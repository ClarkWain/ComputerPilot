#include <desktop_pilot/profiles.hpp>
#include <desktop_pilot/service.hpp>
#include <windows.h>
#include <fstream>
#include <algorithm>
#include <cctype>
namespace dp {
namespace {
std::string lower(std::string s) {
    std::transform(s.begin(),s.end(),s.begin(),[](unsigned char c){return char(std::tolower(c));});
    return s;
}
bool matches(const Json& e,const Json& selector) {
    if(e.value("offscreen",false) || !e.value("enabled",true)) return false;
    for(auto it=selector.begin();it!=selector.end();++it) {
        if(it.key()=="nameContains") {
            if(e.value("name",std::string{}).find(it.value().get<std::string>())==std::string::npos)return false;
        } else if(!e.contains(it.key()) || e[it.key()]!=it.value())return false;
    }
    return true;
}
}
bool profile_supports_dpi(const Json& profile,int dpi) {
    if(!profile.contains("supportedDpi"))return profile.at("dpi")==dpi;
    for(const auto& value:profile.at("supportedDpi"))if(value==dpi)return true;
    return false;
}
std::filesystem::path profiles_directory() {
    wchar_t configured[32768]{};
    auto n=GetEnvironmentVariableW(L"DESKTOPPILOT_PROFILES_DIR",configured,32768);
    if(n) {
        if(n>=32768)throw std::invalid_argument("DESKTOPPILOT_PROFILES_DIR is too long");
        return std::filesystem::path(configured);
    }
    wchar_t executable[32768]{};
    n=GetModuleFileNameW(nullptr,executable,32768);
    if(!n||n>=32768)throw std::runtime_error("Cannot locate executable profiles directory");
    auto dir=std::filesystem::path(executable).parent_path();
    for(int i=0;i<5;++i,dir=dir.parent_path())
        if(std::filesystem::is_directory(dir/L"profiles"))return dir/L"profiles";
    return std::filesystem::path(executable).parent_path()/L"profiles";
}
Json load_profile(const std::filesystem::path& directory,const std::string& id) {
    if(id.empty()||id=="."||id==".."||id.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")!=std::string::npos)
        throw std::invalid_argument("profile must be an installed profile id returned by get_window_state");
    std::ifstream file(directory/std::filesystem::u8path(id)/L"profile.json");
    if(!file)throw std::invalid_argument("Profile is not installed: "+id);
    auto p=Json::parse(file);
    if(p.at("id")!=id||p.at("schemaVersion")!=1||!p.at("actions").is_array())throw std::invalid_argument("Invalid profile manifest: "+id);
    return p;
}
Json discover_profiles(const std::filesystem::path& directory,const std::string& window,const SemanticCall& call) {
    auto w=call("window.get",{{"windowRef",window}});
    if(operation_failed(w))return w;
    Json available=Json::array(),unavailable=Json::array(),tree;
    if(!std::filesystem::is_directory(directory))return {{"status","ok"},{"profiles",available},{"unavailable",unavailable},{"reason","profiles_directory_missing"}};
    std::vector<std::filesystem::path> dirs;
    for(auto& entry:std::filesystem::directory_iterator(directory))if(entry.is_directory())dirs.push_back(entry.path());
    std::sort(dirs.begin(),dirs.end());
    for(auto& dir:dirs) {
        if(!std::filesystem::is_regular_file(dir/L"profile.json"))continue;
        const auto id=utf8(dir.filename().wstring());
        try {
            auto p=load_profile(directory,id);const auto& match=p.at("match");
            // Other applications do not need expensive UIA scans or their action catalogs.
            if(lower(w.value("executable",std::string{}))!=lower(match.at("executable").get<std::string>()))continue;
            Json reasons=Json::array();
            if(w.value("className",std::string{})!=match.at("className").get<std::string>())reasons.push_back("window_class_mismatch");
            if(!profile_supports_dpi(p,w.value("dpi",0)))reasons.push_back("dpi_mismatch");
            if(w.at("bounds").at("width").get<int>()<p.at("minimumWindowWidth").get<int>())reasons.push_back("toolbar_too_narrow");
            if(!w.value("enabled",true))reasons.push_back("window_blocked");
            if(w.value("minimized",false))reasons.push_back("window_minimized");
            if(reasons.empty()) {
                if(tree.is_null())tree=call("ui.tree",{{"windowRef",window},{"format","locator"},{"depth",20},{"limit",400},{"nodeBudget",3000},{"queryTimeoutMs",5000}});
                if(operation_failed(tree)||tree.value("truncated",false))reasons.push_back("ui_inspection_incomplete");
                else for(auto& key:match.at("requiredSelectors")) {
                    auto name=key.get<std::string>();auto selector=p.at("selectors").at(name);
                    size_t count=0;for(auto& e:tree.at("elements"))if(matches(e,selector))++count;
                    if(count!=1)reasons.push_back("control_not_unique:"+name);
                }
            }
            if(reasons.empty())available.push_back({{"id",id},{"description",p.at("description")},{"coordinates",p.at("coordinates")},{"actions",p.at("actions")}});
            else {
                std::string next="Required controls are missing or ambiguous; inspect the layout and app version.";
                if(std::find(reasons.begin(),reasons.end(),"ui_inspection_incomplete")!=reasons.end())next="Control scan was incomplete; do not resize based on this error. Inspect inspection.stopReason/provider error. No drawing was dispatched.";
                else if(std::find(reasons.begin(),reasons.end(),"dpi_mismatch")!=reasons.end())next="DPI unsupported by this profile; resizing cannot fix DPI.";
                else if(std::find(reasons.begin(),reasons.end(),"window_blocked")!=reasons.end())next="Target has a modal dialog; resolve that dialog before drawing.";
                else if(std::find(reasons.begin(),reasons.end(),"toolbar_too_narrow")!=reasons.end())next="Toolbar is too narrow; use recommendedWindow dimensions when resizing is authorized.";
                Json item={{"id",id},{"reasons",reasons},{"actual",{{"dpi",w.value("dpi",0)},{"width",w.at("bounds").at("width")}}},{"next",next}};
                if(p.contains("recommendedWindow"))item["recommendedWindow"]=p["recommendedWindow"];
                if(!tree.is_null())for(auto key:{"stopReason","visited","truncated","message","code"})if(tree.contains(key))item["inspection"][key]=tree[key];
                unavailable.push_back(item);
            }
        } catch(const std::exception& e) {unavailable.push_back({{"id",id},{"reasons",Json::array({std::string("profile_error: ")+e.what()})}});}
    }
    return {{"status","ok"},{"profiles",available},{"unavailable",unavailable}};
}
Json execute_profile_actions(const std::filesystem::path& directory,const Json& args,const SemanticCall& call) {
        const auto catalog=discover_profiles(directory,args.at("windowRef"),call);
        if(operation_failed(catalog))return catalog;
        auto chosen=args.value("profileId",std::string{});
        const auto& candidates=catalog.at("profiles");
        if(chosen.empty() && candidates.size()==1)chosen=candidates[0].at("id");
        bool compatible=false;
        for(const auto& candidate:candidates)if(candidate.at("id")==chosen)compatible=true;
        if(!compatible)return {{"status","error"},{"code",chosen.empty() && candidates.size()>1 ? "profile_ambiguous" : "profile_not_matched"},
            {"dispatch","not_started"},{"completed",0},{"semantic",catalog},
            {"next",candidates.empty()?"No matching profile: use execute_batch or correct the reported app conditions.":"Choose one of the returned compatible profile ids."}};
        const auto profile=load_profile(directory,chosen);
        const auto& actions=args.at("actions");
        if(!actions.is_array()||actions.empty()||actions.size()>256)throw std::invalid_argument("actions must contain 1..256 items");
        for(const auto& item:actions) {
            bool supported=false;
            for(const auto& supportedAction:profile.at("actions"))if(supportedAction.at("action")==item.at("action"))supported=true;
            if(!supported) return {{"status","error"},{"code","action_not_supported"},{"action",item.at("action")},
                {"dispatch","not_started"},{"completed",0},{"next","Use an action example returned by get_window_state for this profile."}};
        }
        Json request={{"profile",utf8((directory/std::filesystem::u8path(chosen)/L"profile.json").wstring())},
            {"windowRef",args.at("windowRef")},{"action","drawing.drawScene"},{"args",{{"items",actions}}}};
        auto result=call("semantic.perform",request);
        result["profile"]=chosen;
        result["next"]="get_window_state to verify the visible result; do not replay completed actions.";
        return result;
}
}
