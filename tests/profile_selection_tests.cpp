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
        bool truncated=false,hasMore=false,providerFailed=false;Json last;
        auto call=[&](const std::string& op,const Json& args)->Json {
            if(op=="window.get")return window;
            if(op=="system.session")return {{"inputDesktopAccessible",true},{"lockState","unlocked"},{"lastInputTick",42}};
            if(op=="ui.tree"){++treeReads;return {{"status",providerFailed?"error":"ok"},{"elements",elements},{"truncated",truncated},{"has_more",hasMore}};}
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
        window["className"]="MSPaintApp";window["dpi"]=144;window["bounds"]["width"]=1700;
        check(discover()["profiles"].size()==1,"144 DPI supported when window is wide enough for the scaled toolbar");
        window["bounds"]["width"]=1300;
        {auto narrow=discover();
         check(narrow["profiles"].empty(),"144 DPI window too narrow for the scaled toolbar is rejected");
         check(narrow["unavailable"][0]["reasons"][0]=="toolbar_too_narrow","narrow high-DPI window reports toolbar_too_narrow, not a missing control");}
        window["bounds"]["width"]=1700;window["dpi"]=120;
        check(discover()["profiles"].size()==1,"120 DPI is accepted when the classic UI fingerprint matches");
        {auto savedElement=elements[0];elements[0]["name"]="modern zoom control";
         check(discover()["profiles"].empty(),"120 DPI does not bypass UI fingerprint validation");elements[0]=savedElement;}
        window["bounds"]["width"]=1300;
        window["dpi"]=240;check(discover()["profiles"].empty(),"unsupported DPI rejected");window["dpi"]=96;
        window["bounds"]["width"]=800;check(discover()["profiles"].empty(),"narrow layout rejected");window["bounds"]["width"]=1300;
        elements[0]["name"]="200%";check(discover()["profiles"].empty(),"zoom mismatch rejected");elements[0]["name"]="100%";
        elements.push_back(elements[0]);check(discover()["profiles"].empty(),"ambiguous UI fingerprint rejected");elements.erase(elements.size()-1);
        truncated=true;auto incomplete=discover();check(incomplete["profiles"].empty(),"truncated evidence not matched");
        check(execute_profile_actions(dir,request,call)["code"]=="profile_inspection_incomplete"&&dispatches==1,"incomplete inspection is not an app incompatibility");
        check(incomplete["unavailable"][0]["next"].get<std::string>().find("do not resize")!=std::string::npos,"scan failure must not recommend window resizing");truncated=false;
        hasMore=true;check(discover()["profiles"].empty(),"pagination is incomplete uniqueness evidence");hasMore=false;
        providerFailed=true;check(execute_profile_actions(dir,request,call)["code"]=="profile_inspection_incomplete"&&dispatches==1,"provider failure cannot dispatch");providerFailed=false;
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
        elements[0]["name"]="100%";treeReads=0;
        auto dispatched=execute_profile_actions(dir,request,call,[&](const Json& action,const SemanticEvidence& evidence) {
            check(evidence.windowRef=="w"&&evidence.window==window&&evidence.session["lastInputTick"]==42,"execution evidence binds current window and session");
            check(evidence.tree["elements"]==elements&&action["windowRef"]=="w","execution dispatch receives the same inspected tree");
            return Json{{"status","ok"}};
        });
        check(dispatched["status"]=="ok"&&treeReads==1,"one discovery tree shared by candidate profiles and dispatch");
        int throwingReads=0;
        auto throwingProvider=[&](const std::string& op,const Json& args)->Json {
            if(op=="ui.tree"){++throwingReads;throw std::runtime_error("UIA initialization failed");}
            return call(op,args);
        };
        Json inspection;
        auto failedCatalog=discover_profiles(dir,"w",throwingProvider,&inspection);
        check(throwingReads==1&&failedCatalog["profiles"].empty()&&failedCatalog["unavailable"].size()==2,"throwing provider is queried only once across candidates");
        check(inspection["status"]=="error"&&inspection["code"]=="ui_inspection_failed"&&inspection["message"]=="UIA initialization failed","inspection output preserves structured provider exception");
        for(const auto& item:failedCatalog["unavailable"])
            check(item["reasons"]==Json::array({"ui_inspection_incomplete"})&&item["inspection"]["code"]=="ui_inspection_failed","provider exception is not a profile manifest error");
        auto failedExecution=execute_profile_actions(dir,request,throwingProvider,
            [&](const Json&,const SemanticEvidence&)->Json {throw std::runtime_error("failed discovery dispatched input");});
        check(failedExecution["code"]=="profile_inspection_incomplete"&&throwingReads==2,"throwing execution discovery never dispatches");
        window["executable"]="other.exe";
        discover_profiles(dir,"w",throwingProvider,&inspection);
        check(inspection.is_null()&&throwingReads==2,"skipped inspection cannot expose previous query failure");
        bool rejected=false;try{load_profile(dir,"../escape");}catch(...){rejected=true;}
        check(rejected,"profile id is not a path");
        std::filesystem::remove_all(dir);
        std::cout<<"PASS checks="<<checks<<'\n';return 0;
    }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
