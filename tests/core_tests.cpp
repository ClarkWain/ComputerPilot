#include <desktop_pilot/core.hpp>
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>

static int checks=0;
static void require(bool condition,const char* reason) {++checks;if(!condition)throw std::runtime_error(reason);}
static bool near(float a,float b){return std::abs(a-b)<0.001f;}
int main() {
    using namespace dp;
    try {
        auto l=Letterbox::make(1920,1080,640);
        require(l.resized_width==640 && l.resized_height==360 && l.top==140,"16:9 letterbox");
        auto b=l.to_source({0,140,640,500});
        require(near(b.x1,0)&&near(b.y1,0)&&near(b.x2,1920)&&near(b.y2,1080),"inverse letterbox");
        require(Letterbox::make(200,600,641).target_width==672,"stride rounding");
        auto clipped=l.to_source({-50,-50,800,800});require(clipped.x1==0&&clipped.y1==0&&clipped.x2==1920&&clipped.y2==1080,"clipping");
        require(near(iou({0,0,10,10},{5,0,15,10}),1.f/3),"IoU geometry");
        require(iou({1,1,1,1},{1,1,1,1})==0,"degenerate IoU");
        std::vector<Detection> boxes={{{0,0,10,10},0.9f,0},{{1,1,11,11},0.8f,0},{{1,1,11,11},0.7f,1},{{50,50,60,60},0.6f,0}};
        auto kept=nms(boxes,0.5f,100);require(kept.size()==3,"class-aware NMS");
        require(kept[1].class_id==1,"cross-class overlap preserved");require(nms(boxes,0.5f,1).size()==1,"NMS limit");
        boxes.push_back({{0,0,10,10},std::numeric_limits<float>::quiet_NaN(),0});require(nms(boxes,0.5f,100).size()==3,"NaN filtered");
        Image red{2,1,{255,0,0,255,0,0}};auto square=Letterbox::make(2,1,32);auto tensor=preprocess(red,square);
        require(tensor.size()==32*32*3,"NCHW size");require(near(tensor[0],114.f/255.f),"padding color");
        require(tensor[8*32]==1.f&&tensor[1024+8*32]==0.f,"RGB channels and offset");
        auto root=std::filesystem::current_path()/"core-test-artifacts";std::filesystem::create_directories(root);
        auto path=root/L"中文图像.png";save_png(red,path);auto decoded=load_image(path);
        require(decoded.rgb==red.rgb&&decoded.width==2&&decoded.height==1,"WIC Unicode PNG roundtrip");
        auto text_path=root/"hash.txt";{std::ofstream f(text_path,std::ios::binary);f<<"abc";}
        require(file_sha256(text_path)=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","SHA-256 known answer");
        auto json=detection_json(kept,"img-test");require(json.size()==3&&json[0]["nativeRef"].is_null(),"visual/native identity separation");
        require(json[0]["point"]["x"]==5.f,"candidate center");
        bool rejected=false;try{std::vector<std::filesystem::path> paths{path,root/L"中文图像.png"};ensure_distinct_paths(paths);}catch(const std::invalid_argument&){rejected=true;}
        require(rejected,"output cannot overwrite input");
        std::cout<<"PASS checks="<<checks<<'\n';return 0;
    } catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;}
}
