#include <desktop_pilot/profiles.hpp>
#include <fstream>
#include <windows.h>
#include <iostream>
using namespace dp;
int wmain(int argc,wchar_t** argv) {
    if(argc!=2)return 2;
    auto dir=std::filesystem::temp_directory_path()/(L"dp-profile-tests-"+std::to_wstring(GetCurrentProcessId()));
    int checks=0,dispatches=0,treeReads=0;
    try {
        std::filesystem::create_directories(dir/L"mspaint-classic-zh-CN");
        std::filesystem::copy_file(std::filesystem::path(argv[1]),dir/L"mspaint-classic-zh-CN/profile.json",std::filesystem::copy_options::overwrite_existing);
        auto p=load_profile(dir,"mspaint-classic-zh-CN");
        Json window={{"windowRef","w"},{"executable","MSPAINT.EXE"},{"className","MSPaintApp"},{"dpi",96},{"bounds",{{"width",1300}}}};
        Json elements=Json::array();
        for(auto key:p["match"]["requiredSelectors"]) {
            auto e=p["selectors"][key.get<std::string>()];
            if(e.contains("nameContains")){e["name"]=e["nameContains"];e.erase("nameContains");}
            elements.push_back(e);
        }
        bool truncated=false;Json last;
        auto call=[&](const std::string& op,const Json& args)->Json {
            if(op=="window.get")return window;
            if(op=="ui.tree"){++treeReads;return {{"elements",elements},{"truncated",truncated}};}
            if(op=="semantic.perform"){++dispatches;last=args;return {{"status","ok"},{"completed",args["args"]["items"].size()}};}
            throw std::runtime_error("Unexpected call "+op);
        };
        auto check=[&](bool value,const char* text){++checks;if(!value)throw std::runtime_error(text);};
        auto discover=[&]{return discover_profiles(dir,"w",call);};
        auto catalog=discover();check(catalog["profiles"].size()==1,"compatible UI found");
        for(auto key:{"fill","outline"}) {auto e=p["selectors"][key];e["enabled"]=false;elements.push_back(e);}
        check(discover()["profiles"].size()==1,"normal brush mode with disabled shape options remains compatible");
        Json request={{"windowRef","w"},{"actions",Json::array({p["actions"][0]["example"]})}};
        auto result=execute_profile_actions(dir,request,call);
        check(result["status"]=="ok"&&result["profile"]==p["id"]&&dispatches==1,"unique profile selected automatically");
        window["executable"]="aseprite.exe";treeReads=0;
        check(discover()["profiles"].empty()&&treeReads==0,"different apps skip Paint UI scanning");
        request["profileId"]="mspaint-classic-zh-CN";
        check(execute_profile_actions(dir,request,call)["code"]=="profile_not_matched"&&dispatches==1,"explicit profile cannot bypass app match");
        window["executable"]="mspaint.exe";window["className"]="ModernPaint";
        check(discover()["profiles"].empty(),"classic profile does not match another UI class");
        window["className"]="MSPaintApp";window["dpi"]=144;
        check(discover()["profiles"].size()==1,"144 DPI supported by calibrated adapter");
        window["dpi"]=240;check(discover()["profiles"].empty(),"unsupported DPI rejected");window["dpi"]=96;
        window["bounds"]["width"]=800;check(discover()["profiles"].empty(),"narrow layout rejected");window["bounds"]["width"]=1300;
        elements[0]["name"]="200%";check(discover()["profiles"].empty(),"zoom mismatch rejected");elements[0]["name"]="100%";
        elements.push_back(elements[0]);check(discover()["profiles"].empty(),"ambiguous UI fingerprint rejected");elements.erase(elements.size()-1);
        truncated=true;auto incomplete=discover();check(incomplete["profiles"].empty(),"truncated evidence not matched");
        check(incomplete["unavailable"][0]["next"].get<std::string>().find("do not resize")!=std::string::npos,"scan failure must not recommend window resizing");truncated=false;
        window["enabled"]=false;check(discover()["profiles"].empty(),"modal blocked UI not matched");window["enabled"]=true;
        request["actions"][0]["action"]="made.up";
        check(execute_profile_actions(dir,request,call)["code"]=="action_not_supported"&&dispatches==1,"unsupported action rejected before input");
        request["actions"][0]=p["actions"][0]["example"];request.erase("profileId");
        p["id"]="alternate";std::filesystem::create_directories(dir/L"alternate");
        {std::ofstream f(dir/L"alternate/profile.json");f<<p;}
        check(execute_profile_actions(dir,request,call)["code"]=="profile_ambiguous"&&dispatches==1,"multiple profiles need a choice");
        request["profileId"]="alternate";check(execute_profile_actions(dir,request,call)["status"]=="ok"&&dispatches==2,"explicit compatible choice works");
        elements[0]["name"]="50%";
        check(execute_profile_actions(dir,request,call)["code"]=="profile_not_matched"&&dispatches==2,"execution rechecks changed UI instead of trusting old discovery");
        bool rejected=false;try{load_profile(dir,"../escape");}catch(...){rejected=true;}
        check(rejected,"profile id is not a path");
        std::filesystem::remove_all(dir);
        std::cout<<"PASS checks="<<checks<<'\n';return 0;
    }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
