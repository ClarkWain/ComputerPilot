#include <desktop_pilot/ocr.hpp>
#include <fstream>
#include <iostream>
#include <stdexcept>
int wmain(int argc,wchar_t** argv){
    using namespace dp;
    try{
        if(argc<2)throw std::runtime_error("Expected result JSON");
        std::ifstream f(std::filesystem::path(argv[1]),std::ios::binary);auto result=Json::parse(f);
        if(argc>2 && std::wstring(argv[2])==L"--ocr-failed"){
            if(result.at("components").at("ocr")!="failed" || result.at("components").at("detector")!="completed" ||
                result.at("status")!="partial" || result.at("elements").empty() || !result.contains("ocrError"))
                throw std::runtime_error("OCR failure discarded successful detections or was hidden");
            std::cout<<"PASS OCR failure preserved successful detector output\n";return 0;
        }
        if(result.at("components").at("ocr")!="completed")throw std::runtime_error("OCR did not complete");
        bool create=false,cancel=false,chinese=false;
        for(auto& line:result.at("textLines")){
            std::string s=line.at("text");create|=s=="Create";cancel|=s=="Cancel";chinese|=s.find("车窗")!=std::string::npos;
            auto b=line.at("bounds");float x=b.at("x"),y=b.at("y"),w=b.at("width"),h=b.at("height");
            if(x<0||y<0||w<=0||h<=0||x+w>960.01||y+h>640.01)throw std::runtime_error("OCR bounds outside source image");
        }
        if(!create||!cancel||!chinese)throw std::runtime_error("English labels or Chinese lyric fixture not recognized");
        if(argc>2){
            bool associated=false;
            for(auto& e:result.at("elements"))if(e.at("kind")=="detected_region"&&e.at("text")=="Create"){
                auto p=e.at("point");float x=p.at("x"),y=p.at("y");
                associated=x>=54&&x<=230&&y>=488&&y<=536&&e.at("textRefs").size()==1;
            }
            if(!associated)throw std::runtime_error("Create label not associated with actual button region");
        }
        std::cout<<"PASS native OCR English/Chinese text and source geometry"<<(argc>2?" with button association":"")<<'\n';return 0;
    }catch(const std::exception& e){std::cerr<<"FAIL "<<e.what()<<'\n';return 1;}
}
