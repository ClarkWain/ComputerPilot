#include <desktop_pilot/core.hpp>
#include <array>
#include <cmath>
#include <fstream>
#include <iostream>
#include <stdexcept>

int wmain(int argc,wchar_t** argv) {
    using namespace dp;
    try {
        if(argc!=3) throw std::runtime_error("Expected result JSON and overlay PNG");
        std::ifstream stream(std::filesystem::path(argv[1]),std::ios::binary);
        auto result=Json::parse(stream); auto overlay=load_image(argv[2]);
        if(result.at("status")!="partial" || result.at("components").at("ocr")!="not_requested")
            throw std::runtime_error("Incomplete pipeline must be reported honestly");
        if(overlay.width!=960 || overlay.height!=640) throw std::runtime_error("Overlay geometry changed");
        std::array<Box,4> expected={Box{54,180,654,226},Box{705,180,895,226},Box{54,488,230,536},Box{254,488,430,536}};
        std::array<bool,4> found{};
        for(auto& e:result.at("elements")) {
            auto r=e.at("bounds");float x=r.at("x"),y=r.at("y"),w=r.at("width"),h=r.at("height");
            float px=e.at("point").at("x"),py=e.at("point").at("y");
            if(!std::isfinite(x+y+w+h+px+py) || x<0 || y<0 || w<=0 || h<=0 || x+w>960.001f || y+h>640.001f)
                throw std::runtime_error("Invalid original-image detection geometry");
            if(!e.at("nativeRef").is_null() || !e.at("text").is_null()) throw std::runtime_error("Fabricated native/text information");
            if(e.at("visualRef").at("imageRef")!=result.at("image").at("imageRef")) throw std::runtime_error("Frame reference mismatch");
            for(size_t i=0;i<expected.size();++i) {
                auto target=expected[i];
                if(iou({x,y,x+w,y+h},target)>0.5f && px>=target.x1 && px<=target.x2 && py>=target.y1 && py<=target.y2) found[i]=true;
            }
        }
        for(bool hit:found) if(!hit) throw std::runtime_error("Missed one of the four baseline fixture controls");
        std::cout<<"PASS: 4 labeled controls have matching regions and valid candidate points; schema and overlay verified\n";
        return 0;
    } catch(const std::exception& e){std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;}
}
