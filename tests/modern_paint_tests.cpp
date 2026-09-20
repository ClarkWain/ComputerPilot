#include <desktop_pilot/semantic.hpp>
#include <fstream>
#include <iostream>
using dp::Json;
void require(bool ok,const char* message){if(!ok)throw std::runtime_error(message);}
int main(int argc,char** argv){try{
    require(argc==2,"profile required");std::ifstream f(argv[1]);auto profile=Json::parse(f);
    int calls=0,draws=0,width=1;bool mismatch=false,zoomBad=false,failDraw=false;std::string focused,hex="#000000";
    Json sent,host={{"x",-9},{"y",-9},{"width",1800},{"height",1200}};
    auto mock=[&](const std::string& op,const Json& a)->Json{
        ++calls;
        if(op=="system.session")return {{"inputDesktopAccessible",true},{"lockState","unlocked"}};
        if(op=="window.get")return {{"dpi",120},{"bounds",host},{"enabled",true}};
        if(op=="ui.find"){
            const auto& s=a.at("selector");std::string name=s.value("name",s.value("nameContains",s.value("automationId",std::string{})));
            Json e={{"elementRef",name},{"name",name},{"enabled",true},{"offscreen",false},{"value",nullptr},{"bounds",{{"x",20},{"y",80},{"width",45},{"height",60}}}};
            if(name=="在画布上使用"){e["name"]="在画布上使用 画笔 工具";e["bounds"]={{"x",300},{"y",350},{"width",688},{"height",810}};}
            if(name=="缩放")e["value"]=zoomBad?"125 百分比":"100 百分比";
            if(name=="RedTextBox" || name=="GreenTextBox" || name=="BlueTextBox"){
                // setColor no longer verifies R/G/B channels — ui.fill on the
                // hex box already carries verification. Failing here catches
                // a regression that reintroduces per-channel scans.
                require(false,"R/G/B verification removed; setColor must trust hex ui.fill verify");
            }
            return {{"elements",Json::array({e})},{"truncated",false}};
        }
        if(op=="ui.focus")focused=a.at("elementRef");
        if(op=="ui.set_range_value"){int index=a.at("value");width=index<24?index+1:24+(index-23)*2;}
        if(op=="ui.fill"){hex=a.at("text");return {{"status","ok"},{"verification","passed"}};}
        if(op=="input.key_chord" && focused=="大小") {if(a.at("keys")[0]=="HOME")width=1;else if(a.at("keys")[0]=="RIGHT")++width;}
        if(op=="ui.get") {
            // Canvas is elementRef-cached and re-read via ui.get; mock the same
            // shape that ui.find returned so readCanvas can consume it.
            if(a.at("elementRef")=="在画布上使用")
                return {{"elementRef","在画布上使用"},{"name","在画布上使用 画笔 工具"},
                    {"enabled",true},{"offscreen",false},
                    {"bounds",{{"x",300},{"y",350},{"width",688},{"height",810}}}};
            return {{"value",a.at("elementRef")=="不透明度"?"100%":std::to_string(width+(mismatch?1:0))+" 像素"}};
        }
        if(op=="input.move"){++draws;sent=a;if(failDraw)return {{"status","error"},{"message","partial input"}};}
        return {{"status","ok"}};
    };
    Json path={{"action","drawing.drawPolyline"},{"args",{{"points",{{20,30},{120,30},{120,130}}},{"closed",true},{"stroke",{{"color",{245,155,165}},{"width",7}}}}}};
    Json request={{"action","drawing.drawScene"},{"windowRef","test"},{"args",{{"items",Json::array({path})}}}};
    auto result=dp::run_semantic(request,profile,mock,[](int){});
    require(result.at("status")=="ok" && draws==1,"modern drawing failed");
    require(sent.at("points")==Json::array({{329,389},{429,389},{429,489},{329,389}}),"120 DPI must not rescale canvas pixels");
    require(width==7 && hex=="#F59BA5","settings incorrect");
    auto thick=request;thick["args"]["items"][0]["args"]["stroke"]["width"]=30;
    result=dp::run_semantic(thick,profile,mock,[](int){});require(result.at("status")=="ok" && width==30,"nonlinear width mapping");
    auto bad=request;bad["args"]["items"].push_back(path);bad["args"]["items"][1]["args"]["stroke"]["width"]=0;calls=0;bool rejected=false;
    try{dp::run_semantic(bad,profile,mock,[](int){});}catch(const std::invalid_argument&){rejected=true;}
    require(rejected && calls==0,"invalid trailing action caused side effects");
    zoomBad=true;draws=0;result=dp::run_semantic(request,profile,mock,[](int){});
    require(result.at("status")=="error" && draws==0,"non100 zoom drew");zoomBad=false;
    mismatch=true;result=dp::run_semantic(request,profile,mock,[](int){});
    require(result.at("status")=="error" && draws==0,"wrong brush width drew");mismatch=false;
    bad=request;bad["args"]["items"][0]["args"]["points"][0]={900,30};
    result=dp::run_semantic(bad,profile,mock,[](int){});require(result.at("status")=="error" && draws==0,"out of canvas drew");
    failDraw=true;result=dp::run_semantic(request,profile,mock,[](int){});
    require(result.at("status")=="error" && draws==1 && result.at("dispatch")=="possibly_partial" && result.at("completed")==0,"partial stroke replayed or misreported");
    std::cout<<"modern Paint tests passed\n";return 0;
}catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}}
