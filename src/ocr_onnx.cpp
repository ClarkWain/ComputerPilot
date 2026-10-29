// PP-OCR preprocessing/CTC contract follows PaddleOCR and RapidOCR.
// Native adaptation; Apache-2.0 attribution is in THIRD_PARTY_NOTICES.md.
#include <desktop_pilot/ocr.hpp>
#include <onnxruntime_cxx_api.h>
#include <opencv2/core.hpp>
#include <opencv2/imgproc.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <numeric>
#include <sstream>
#include <stdexcept>

namespace dp {
using Clock=std::chrono::steady_clock;
static double elapsed(Clock::time_point t){return std::chrono::duration<double,std::milli>(Clock::now()-t).count();}
namespace {
struct Session {
    Ort::Session session{nullptr};
    std::string input,output;
    std::vector<int64_t> input_shape,output_shape;
    Session(Ort::Env& env,const std::filesystem::path& path,const Ort::SessionOptions& options):session(env,path.c_str(),options) {
        if(session.GetInputCount()!=1 || session.GetOutputCount()!=1)throw std::runtime_error("OCR contract requires one input/output");
        Ort::AllocatorWithDefaultOptions allocator;
        input=session.GetInputNameAllocated(0,allocator).get();output=session.GetOutputNameAllocated(0,allocator).get();
        auto input_info=session.GetInputTypeInfo(0); auto output_info=session.GetOutputTypeInfo(0);
        auto in=input_info.GetTensorTypeAndShapeInfo(),out=output_info.GetTensorTypeAndShapeInfo();
        if(in.GetElementType()!=ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT || out.GetElementType()!=ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
            throw std::runtime_error("OCR contract requires float32 tensors");
        input_shape=in.GetShape();output_shape=out.GetShape();
        if(input_shape.size()!=4 || (input_shape[1]>0 && input_shape[1]!=3))throw std::runtime_error("OCR requires NCHW image input");
    }
    Ort::Value run(std::vector<float>& data,std::array<int64_t,4> shape) {
        auto memory=Ort::MemoryInfo::CreateCpu(OrtArenaAllocator,OrtMemTypeDefault);
        auto tensor=Ort::Value::CreateTensor<float>(memory,data.data(),data.size(),shape.data(),shape.size());
        const char* inputs[]={input.c_str()};const char* outputs[]={output.c_str()};
        auto values=session.Run(Ort::RunOptions{nullptr},inputs,&tensor,1,outputs,1);
        return std::move(values.front());
    }
    Json contract() const {return {{"inputName",input},{"outputName",output},{"inputShape",input_shape},{"outputShape",output_shape}};}
};
std::vector<float> normalized(const cv::Mat& bgr,int width,int height) {
    cv::Mat resized;cv::resize(bgr,resized,{width,height},0,0,cv::INTER_LINEAR);
    size_t plane=size_t(width)*height;std::vector<float> out(plane*3);
    for(int y=0;y<height;++y)for(int x=0;x<width;++x)for(int c=0;c<3;++c)
        out[c*plane+size_t(y)*width+x]=resized.at<cv::Vec3b>(y,x)[c]/127.5f-1.f;
    return out;
}
std::array<cv::Point2f,4> ordered(cv::RotatedRect rect) {
    std::array<cv::Point2f,4> p;rect.points(p.data());
    std::sort(p.begin(),p.end(),[](auto a,auto b){return a.x!=b.x?a.x<b.x:a.y<b.y;});
    if(p[0].y>p[1].y)std::swap(p[0],p[1]);
    if(p[2].y>p[3].y)std::swap(p[2],p[3]);
    return {p[0],p[2],p[3],p[1]};
}
Box envelope(const std::array<cv::Point2f,4>& points) {
    Box b{points[0].x,points[0].y,points[0].x,points[0].y};
    for(auto p:points){b.x1=std::min(b.x1,p.x);b.y1=std::min(b.y1,p.y);b.x2=std::max(b.x2,p.x);b.y2=std::max(b.y2,p.y);}
    return b;
}
struct Candidate {std::array<cv::Point2f,4> points;float score;};
}
struct Ocr::Impl {
    Ort::Env env{ORT_LOGGING_LEVEL_ERROR,"computer-pilot-ocr"};
    std::unique_ptr<Session> det,rec;
    OcrOptions options;
    std::vector<std::string> dictionary;
    std::string det_sha,rec_sha;
    double load_ms=0;
};
Ocr::Ocr(const std::filesystem::path& dir,OcrOptions options):impl_(std::make_unique<Impl>()) {
    options.validate();impl_->options=options;auto start=Clock::now();
    impl_->det_sha=file_sha256(dir/L"det.onnx");impl_->rec_sha=file_sha256(dir/L"rec.onnx");
    if(impl_->det_sha!="d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9" ||
       impl_->rec_sha!="48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b")
        throw std::runtime_error("OCR weights do not match the supported PP-OCRv4 model contract; run bootstrap-ocr.cmake");
    Ort::SessionOptions so;so.SetIntraOpNumThreads(options.threads);so.SetInterOpNumThreads(1);
    so.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);
    so.AddConfigEntry("session.intra_op.allow_spinning","0");
    impl_->det=std::make_unique<Session>(impl_->env,dir/L"det.onnx",so);
    impl_->rec=std::make_unique<Session>(impl_->env,dir/L"rec.onnx",so);
    auto& input=impl_->rec->input_shape;
    if(input[2]>0 && input[2]!=48)throw std::runtime_error("Unsupported OCR recognition height");
    Ort::AllocatorWithDefaultOptions allocator;
    auto metadata=impl_->rec->session.GetModelMetadata();
    auto chars=metadata.LookupCustomMetadataMapAllocated("character",allocator);
    if(!chars)throw std::runtime_error("Missing embedded OCR character dictionary");
    std::istringstream stream(chars.get());std::string line;
    impl_->dictionary.emplace_back(""); // CTC blank
    while(std::getline(stream,line)){if(!line.empty()&&line.back()=='\r')line.pop_back();if(line.empty())throw std::runtime_error("Empty OCR dictionary entry");impl_->dictionary.push_back(line);}
    impl_->dictionary.emplace_back(" ");
    auto& output=impl_->rec->output_shape;
    if(output.size()!=3 || (output[2]>0 && size_t(output[2])!=impl_->dictionary.size()))
        throw std::runtime_error("Recognition classes do not match embedded dictionary");
    impl_->load_ms=elapsed(start);
}
Ocr::~Ocr()=default;
bool Ocr::available(){return true;}
OcrResult Ocr::run(const Image& image, int max_side_override) {
    auto saved=impl_->options.max_side;
    impl_->options.max_side=max_side_override;
    impl_->options.validate();
    try {
        auto result=run(image);
        impl_->options.max_side=saved;
        return result;
    } catch(...) {
        impl_->options.max_side=saved;
        throw;
    }
}
Json Ocr::metadata() const {
    return {{"backend","onnxruntime"},{"runtimeVersion",Ort::GetVersionString()},{"opencvVersion",CV_VERSION},{"device","cpu"},
        {"model","PP-OCRv4 mobile / RapidOCR export"},{"detSha256",impl_->det_sha},{"recSha256",impl_->rec_sha},
        {"dictionarySource","recognizer_metadata.character"},{"dictionarySize",impl_->dictionary.size()},
        {"detContract",impl_->det->contract()},{"recContract",impl_->rec->contract()},{"loadMs",impl_->load_ms},
        {"preprocess","BGR / linear resize / (pixel/255-0.5)/0.5"},{"orientationClassifier",false},
        {"polygonExpansion","rotated_rectangle_offset"},{"upstreamBitwiseParity","not_verified"}};
}
OcrResult Ocr::run(const Image& image) {
    image.validate();const auto& opt=impl_->options;auto start=Clock::now();
    cv::Mat rgb(image.height,image.width,CV_8UC3,const_cast<uint8_t*>(image.rgb.data()));cv::Mat bgr;cv::cvtColor(rgb,bgr,cv::COLOR_RGB2BGR);
    double scale=std::min(1.0,double(opt.max_side)/std::max(image.width,image.height));
    int width=std::max(32,int(std::round(int(image.width*scale)/32.0))*32);
    int height=std::max(32,int(std::round(int(image.height*scale)/32.0))*32);
    auto data=normalized(bgr,width,height);double prep_ms=elapsed(start);start=Clock::now();
    auto predicted=impl_->det->run(data,{1,3,height,width});
    auto shape=predicted.GetTensorTypeAndShapeInfo().GetShape();
    if(shape!=std::vector<int64_t>{1,1,height,width})throw std::runtime_error("Unsupported OCR detection output geometry");
    cv::Mat probability(height,width,CV_32F,predicted.GetTensorMutableData<float>());
    if(!cv::checkRange(probability,true,nullptr,0,1.001))throw std::runtime_error("Invalid text detection probabilities");
    double det_ms=elapsed(start);start=Clock::now();
    cv::Mat mask;cv::compare(probability,opt.pixel_threshold,mask,cv::CMP_GT);
    cv::dilate(mask,mask,cv::Mat::ones(2,2,CV_8U));
    std::vector<std::vector<cv::Point>> contours;cv::findContours(mask,contours,cv::RETR_LIST,cv::CHAIN_APPROX_SIMPLE);
    std::vector<Candidate> candidates;
    for(const auto& contour:contours) {
        if(contour.size()<3)continue;
        auto rect=cv::minAreaRect(contour);if(std::min(rect.size.width,rect.size.height)<3)continue;
        auto points=ordered(rect);auto aabb=envelope(points);
        int left=std::clamp(int(std::floor(aabb.x1)),0,width-1),top=std::clamp(int(std::floor(aabb.y1)),0,height-1);
        int right=std::clamp(int(std::ceil(aabb.x2)),left,width-1),bottom=std::clamp(int(std::ceil(aabb.y2)),top,height-1);
        cv::Mat region_mask=cv::Mat::zeros(bottom-top+1,right-left+1,CV_8U);std::vector<cv::Point> polygon;
        for(auto p:points)polygon.emplace_back(int(p.x)-left,int(p.y)-top);
        cv::fillConvexPoly(region_mask,polygon,255);
        float score=float(cv::mean(probability(cv::Rect(left,top,right-left+1,bottom-top+1)),region_mask)[0]);
        if(score<opt.box_threshold)continue;
        // Uniform offset of the fitted rectangle. No Python/Clipper dependency.
        float delta=rect.size.area()*1.6f/(2*(rect.size.width+rect.size.height));
        rect.size.width+=2*delta;rect.size.height+=2*delta;points=ordered(rect);
        for(auto& p:points){p.x=std::clamp(p.x/width*image.width,0.f,float(image.width-1));p.y=std::clamp(p.y/height*image.height,0.f,float(image.height-1));}
        auto bounds=envelope(points);if(bounds.x2-bounds.x1<4 || bounds.y2-bounds.y1<4)continue;
        candidates.push_back({points,score});
    }
    std::stable_sort(candidates.begin(),candidates.end(),[](auto& a,auto& b){return a.score>b.score;});
    OcrResult result;result.candidate_count=candidates.size();result.truncated=candidates.size()>opt.max_lines;
    if(result.truncated)candidates.resize(opt.max_lines);
    double post_ms=elapsed(start);start=Clock::now();
    for(const auto& c:candidates) {
        const auto& p=c.points;
        int crop_width=std::max(1,int(std::round(std::max(cv::norm(p[0]-p[1]),cv::norm(p[3]-p[2])))));
        int crop_height=std::max(1,int(std::round(std::max(cv::norm(p[0]-p[3]),cv::norm(p[1]-p[2])))));
        if(uint64_t(crop_width)*crop_height>64000000ULL)throw std::runtime_error("OCR crop exceeds image budget");
        std::array<cv::Point2f,4> dest={cv::Point2f(0,0),cv::Point2f(float(crop_width-1),0),cv::Point2f(float(crop_width-1),float(crop_height-1)),cv::Point2f(0,float(crop_height-1))};
        auto transform=cv::getPerspectiveTransform(p.data(),dest.data());cv::Mat crop;
        cv::warpPerspective(bgr,crop,transform,{crop_width,crop_height},cv::INTER_CUBIC,cv::BORDER_REPLICATE);
        if(crop.rows>crop.cols*1.5)cv::rotate(crop,crop,cv::ROTATE_90_COUNTERCLOCKWISE);
        int content_width=int(std::ceil(48.0*crop.cols/crop.rows));
        if(content_width>4096){result.truncated=true;++result.rejected_count;continue;}
        int tensor_width=std::max(320,content_width);
        auto resized=normalized(crop,content_width,48);
        size_t plane=size_t(tensor_width)*48;std::vector<float> input(plane*3,0);
        for(int ch=0;ch<3;++ch)for(int row=0;row<48;++row)
            std::copy_n(resized.data()+size_t(ch*48+row)*content_width,content_width,input.data()+ch*plane+size_t(row)*tensor_width);
        auto output=impl_->rec->run(input,{1,3,48,tensor_width});
        auto info=output.GetTensorTypeAndShapeInfo();auto dims=info.GetShape();
        if(dims.size()!=3 || dims[0]!=1 || dims[1]<1 || dims[2]!=int64_t(impl_->dictionary.size()))throw std::runtime_error("Unexpected OCR CTC output");
        auto decoded=decode_ctc({output.GetTensorData<float>(),info.GetElementCount()},size_t(dims[1]),impl_->dictionary);
        if(decoded.text.empty() || decoded.confidence<opt.text_threshold){++result.rejected_count;continue;}
        TextLine line;line.box=envelope(p);line.text=std::move(decoded.text);line.score=decoded.confidence;line.detection_score=c.score;
        for(size_t i=0;i<4;++i)line.polygon[i]={p[i].x,p[i].y};result.lines.push_back(std::move(line));
    }
    std::stable_sort(result.lines.begin(),result.lines.end(),[](auto& a,auto& b){return a.box.y1!=b.box.y1?a.box.y1<b.box.y1:a.box.x1<b.box.x1;});
    result.timings_ms={{"preprocess",prep_ms},{"detect",det_ms},{"postprocess",post_ms},{"recognize",elapsed(start)}};
    return result;
}
}
