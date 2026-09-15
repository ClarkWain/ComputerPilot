// Adapter contract follows Microsoft OmniParser util/yolov9.py.
// Attribution and CC-BY-4.0 adaptation notice: see THIRD_PARTY_NOTICES.md.
#include <desktop_pilot/detector.hpp>
#include <torch/script.h>
#include <torch/version.h>
#include <torch/csrc/jit/runtime/graph_executor.h>
#include <ATen/Parallel.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <stdexcept>

namespace dp {
using Clock=std::chrono::steady_clock;
static double elapsed(Clock::time_point start){return std::chrono::duration<double,std::milli>(Clock::now()-start).count();}
void DetectorOptions::validate() const {
    if(size<32 || size>2048 || threads<1 || threads>64 || max_detections<1 || max_detections>10000 ||
        !std::isfinite(confidence) || confidence<0 || confidence>1 || !std::isfinite(nms_iou) || nms_iou<0 || nms_iou>1)
        throw std::invalid_argument("Invalid detector settings: size 32..2048, threads 1..64, confidence/iou 0..1, max-detections 1..10000");
}
struct Detector::Impl {
    torch::jit::Module model;
    DetectorOptions options;
    double load_ms=0;
    std::string sha;
};
Detector::Detector(const std::filesystem::path& path,DetectorOptions options):impl_(std::make_unique<Impl>()) {
    options.validate(); impl_->options=options;
    at::set_num_threads(options.threads);
    auto start=Clock::now();
    // std::ifstream accepts a native wide filesystem path on Windows.
    std::ifstream stream(path,std::ios::binary);
    if(!stream) throw std::runtime_error("Cannot open model file");
    impl_->model=torch::jit::load(stream,torch::kCPU); impl_->model.eval();
    impl_->load_ms=elapsed(start); impl_->sha=file_sha256(path);
}
Detector::~Detector()=default;
bool Detector::available(){return true;}
Json Detector::metadata() const {return {{"backend","libtorch"},{"runtimeVersion",TORCH_VERSION},{"device","cpu"},
    {"format","torchscript"},{"sha256",impl_->sha},{"loadMs",impl_->load_ms},{"threads",impl_->options.threads},
    {"preprocess","rgb_lanczos3_letterbox_nchw_float32"},{"pillowBitwiseParity","not_verified"}};}
DetectionResult Detector::run(const Image& image) {
    c10::InferenceMode inference_guard;
    // The upstream adapter disables graph optimization for this artifact.
    const bool old_opt=torch::jit::getGraphExecutorOptimize();
    struct Restore{bool value;~Restore(){torch::jit::setGraphExecutorOptimize(value);}} restore{old_opt};
    torch::jit::setGraphExecutorOptimize(false);
    auto start=Clock::now(); const auto& opt=impl_->options;
    auto layout=Letterbox::make(image.width,image.height,opt.size);
    auto pixels=preprocess(image,layout);
    auto tensor=torch::from_blob(pixels.data(),{1,3,layout.target_height,layout.target_width},torch::kFloat32);
    double prep_ms=elapsed(start); start=Clock::now();
    auto output=impl_->model.forward({tensor});
    double forward_ms=elapsed(start); start=Clock::now();
    std::vector<torch::Tensor> heads;
    if(output.isTuple()) { for(const auto& item:output.toTuple()->elements()) {if(!item.isTensor()) throw std::runtime_error("Expected tensor tuple");heads.push_back(item.toTensor());} }
    else if(output.isTensorList()) heads=output.toTensorVector();
    else throw std::runtime_error("Unexpected TorchScript output type; expected six detector heads");
    if(heads.size()!=6) throw std::runtime_error("Unsupported detector contract: expected exactly three logits/distance pairs");
    std::vector<Detection> candidates; Json shapes=Json::array();
    const int strides[]={8,16,32};
    for(int i=0;i<3;++i) {
        auto logits=heads[i*2].to(torch::kCPU).to(torch::kFloat32).contiguous();
        auto dist=heads[i*2+1].to(torch::kCPU).to(torch::kFloat32).contiguous();
        if(logits.dim()!=4 || dist.dim()!=4 || logits.size(0)!=1 || dist.size(0)!=1 || dist.size(1)!=4 || logits.size(1)<1 ||
            logits.size(2)!=dist.size(2) || logits.size(3)!=dist.size(3) ||
            logits.size(2)!=layout.target_height/strides[i] || logits.size(3)!=layout.target_width/strides[i])
            throw std::runtime_error("Detector head shape does not match YOLOv9 raw-head contract");
        shapes.push_back({{"logits",logits.sizes().vec()},{"distances",dist.sizes().vec()},{"stride",strides[i]}});
        int h=int(logits.size(2)),w=int(logits.size(3)),classes=int(logits.size(1)); size_t plane=size_t(h)*w;
        const auto* lp=logits.data_ptr<float>(); const auto* dp=dist.data_ptr<float>();
        for(int y=0;y<h;++y) for(int x=0;x<w;++x) {
            size_t p=size_t(y)*w+x; int cls=0; float best=lp[p];
            for(int c=1;c<classes;++c) if(lp[c*plane+p]>best){best=lp[c*plane+p];cls=c;}
            float score=1.f/(1.f+std::exp(-best)); if(!(score>opt.confidence)) continue;
            float stride=float(strides[i]),ax=(x+0.5f)*stride,ay=(y+0.5f)*stride;
            Box box{ax-dp[p]*stride,ay-dp[plane+p]*stride,ax+dp[2*plane+p]*stride,ay+dp[3*plane+p]*stride};
            candidates.push_back({layout.to_source(box,false),score,cls});
        }
    }
    auto detections=nms(std::move(candidates),opt.nms_iou,opt.max_detections);
    for(auto& d:detections) {
        d.box.x1=std::clamp(d.box.x1,0.f,float(image.width)); d.box.x2=std::clamp(d.box.x2,0.f,float(image.width));
        d.box.y1=std::clamp(d.box.y1,0.f,float(image.height)); d.box.y2=std::clamp(d.box.y2,0.f,float(image.height));
    }
    std::erase_if(detections,[](auto& d){return d.box.x2<=d.box.x1 || d.box.y2<=d.box.y1;});
    return {std::move(detections),std::move(shapes),{{"preprocess",prep_ms},{"forward",forward_ms},{"postprocess",elapsed(start)}}};
}
}
