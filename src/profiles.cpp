#include <desktop_pilot/profiles.hpp>
#include <desktop_pilot/service.hpp>
#include <windows.h>
#include <fstream>
#include <algorithm>
#include <cctype>
#include <set>
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
bool shallow_match_evidence(const Json& tree) {
    return tree.is_object() && !operation_failed(tree) && tree.contains("elements") && tree.at("elements").is_array() &&
        tree.value("stopReason",std::string{})=="depthLimit";
}
std::string logical_key(const Json& e) {
    std::string key=e.value("role",std::string{})+"\n"+e.value("name",std::string{});
    if(e.contains("automationId") && e.at("automationId").is_string()) key+="\n"+e.at("automationId").get<std::string>();
    if(e.contains("bounds") && e.at("bounds").is_object()) {
        const auto& b=e.at("bounds");
        key+="\n"+std::to_string(b.value("x",0))+","+std::to_string(b.value("y",0))+","+
            std::to_string(b.value("width",0))+","+std::to_string(b.value("height",0));
    }
    return key;
}
}
bool profile_supports_dpi(const Json& profile,int dpi) {
    if(!profile.contains("supportedDpi"))return profile.at("dpi")==dpi;
    for(const auto& value:profile.at("supportedDpi"))if(value==dpi)return true;
    return false;
}
std::string profile_geometry_issue(const Json& profile,const Json& window) {
    if(profile.at("schemaVersion")==2) {
        if(!window.contains("client") || !window["client"].contains("dip96"))return "client_area_unknown";
        const auto& minimum=profile.at("minimumClientSize");
        if(window["client"].contains("physical")&&window.contains("display")&&window["display"].contains("dpi")) {
            const auto& size=window["client"]["physical"];
            const auto dpi=window["display"]["dpi"].get<int>();
            if(dpi<=0)return "client_area_unknown";
            if(int64_t(size.at("width").get<int>())*96<int64_t(minimum.at("width").get<int>())*dpi ||
               int64_t(size.at("height").get<int>())*96<int64_t(minimum.at("height").get<int>())*dpi)return "insufficient_client_area";
        } else {
            const auto& size=window["client"]["dip96"];
            if(size.at("width").get<int>()<minimum.at("width").get<int>() ||
               size.at("height").get<int>()<minimum.at("height").get<int>())return "insufficient_client_area";
        }
        return {};
    }
    const int dpi=window.contains("display")?window["display"].value("dpi",window.value("dpi",96)):window.value("dpi",96);
    const long long requiredWidth=(long long)profile.at("minimumWindowWidth").get<int>()*(dpi>0?dpi:96)/96;
    return window.at("bounds").at("width").get<int>()<requiredWidth?"toolbar_too_narrow":"";
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
    if(p.at("id")!=id||!p.at("actions").is_array())throw std::invalid_argument("Invalid profile manifest: "+id);
    const int version=p.at("schemaVersion").get<int>();
    if(version!=1&&version!=2)throw std::invalid_argument("Unsupported profile schemaVersion: "+id);
    if(version==2) {
        for(auto key:{"minimumClientSize","preferredClientSize"}) {
            if(!p.contains(key)) {if(std::string(key)=="preferredClientSize")continue;throw std::invalid_argument("Missing minimumClientSize: "+id);}
            const auto& size=p.at(key);
            if(!size.is_object()||size.value("unit",std::string{})!="dip96"||
               !size.contains("width")||!size.contains("height")||
               !size["width"].is_number_integer()||!size["height"].is_number_integer()||
               size["width"].get<int>()<=0||size["height"].get<int>()<=0||
               size["width"].get<int>()>20000||size["height"].get<int>()>20000)
                throw std::invalid_argument("Invalid client size: "+id);
        }
        if(p.contains("preferredClientSize") &&
           (p["preferredClientSize"]["width"].get<int>()<p["minimumClientSize"]["width"].get<int>() ||
            p["preferredClientSize"]["height"].get<int>()<p["minimumClientSize"]["height"].get<int>()))
            throw std::invalid_argument("Preferred client size is smaller than minimum: "+id);
    }
    return p;
}
Json discover_profiles(const std::filesystem::path& directory,const std::string& window,const SemanticCall& call,Json* inspection) {
    if(inspection)*inspection=Json();
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
            if(auto issue=profile_geometry_issue(p,w);!issue.empty())reasons.push_back(issue);
            if(!w.value("enabled",true))reasons.push_back("window_blocked");
            if(w.value("minimized",false))reasons.push_back("window_minimized");
            if(reasons.empty()) {
                if(tree.is_null()) {
                    try {
                        tree=call("ui.tree",{{"windowRef",window},{"format","locator"},{"depth",16},{"limit",400},{"nodeBudget",3000},{"queryTimeoutMs",5000},{"metrics",true}});
                    } catch(const std::exception& error) {
                        tree={{"status","error"},{"code","ui_inspection_failed"},{"message",error.what()},
                            {"stopReason","provider_error"},{"evidenceComplete",false}};
                    }
                    if(!tree.is_object())tree={{"status","error"},{"code","ui_inspection_failed"},
                        {"message","UI inspection returned a non-object response"},{"stopReason","provider_error"},{"evidenceComplete",false}};
                    if(inspection)*inspection=tree;
                }
                if(!ui_inspection_complete(tree) && !shallow_match_evidence(tree))reasons.push_back("ui_inspection_incomplete");
                else for(auto& key:match.at("requiredSelectors")) {
                    auto name=key.get<std::string>();auto selector=p.at("selectors").at(name);
                    size_t rawCount=0;
                    std::set<std::string> unique;
                    for(auto& e:tree.at("elements"))if(matches(e,selector)) {++rawCount; unique.insert(logical_key(e));}
                    if(shallow_match_evidence(tree) ? unique.empty() : rawCount!=1)reasons.push_back("control_not_unique:"+name);
                }
            }
            if(reasons.empty())available.push_back({{"id",id},{"description",p.at("description")},{"coordinates",p.at("coordinates")},{"actions",p.at("actions")}});
            else {
                std::string next="Required controls are missing or ambiguous; inspect the layout and app version.";
                if(std::find(reasons.begin(),reasons.end(),"ui_inspection_incomplete")!=reasons.end())next="Compatibility is unknown because control inspection was incomplete; do not resize or repeat unchanged scans. Inspect inspection.stopReason/provider error, then use get_window_state(mode=image) and execute_batch when the target is visually clear. No drawing was dispatched.";
                else if(std::find(reasons.begin(),reasons.end(),"dpi_mismatch")!=reasons.end())next="DPI unsupported by this profile; resizing cannot fix DPI.";
                else if(std::find(reasons.begin(),reasons.end(),"window_blocked")!=reasons.end())next="Target has a modal dialog; resolve that dialog before drawing.";
                else if(std::find(reasons.begin(),reasons.end(),"toolbar_too_narrow")!=reasons.end())next="Toolbar is too narrow at this DPI. If the task permits changing window size, use a standalone prepare_window action or maximize, then inspect again.";
                else if(std::find(reasons.begin(),reasons.end(),"client_area_unknown")!=reasons.end())next="Physical client area or display DPI could not be measured; do not infer profile compatibility from outer window size.";
                else if(std::find(reasons.begin(),reasons.end(),"insufficient_client_area")!=reasons.end())next="Client area is smaller than this profile requires; explicitly prepare the window, then inspect again.";
                Json item={{"id",id},{"reasons",reasons},{"actual",{{"dpi",w.value("dpi",0)},{"width",w.at("bounds").at("width")}}},{"next",next}};
                if(p.contains("recommendedWindow"))item["recommendedWindow"]=p["recommendedWindow"];
                if(p.contains("preferredClientSize"))item["preferredClientSize"]=p["preferredClientSize"];
                if(p.contains("minimumClientSize"))item["minimumClientSize"]=p["minimumClientSize"];
                if(w.contains("client")&&w["client"].contains("dip96"))item["actualClientSize"]=w["client"]["dip96"];
                if(!tree.is_null())for(auto key:{"stopReason","visited","truncated","has_more","evidenceComplete","message","code","providerError","metrics"})if(tree.contains(key))item["inspection"][key]=tree[key];
                unavailable.push_back(item);
            }
        } catch(const std::exception& e) {unavailable.push_back({{"id",id},{"reasons",Json::array({std::string("profile_error: ")+e.what()})}});}
    }
    return {{"status","ok"},{"profiles",available},{"unavailable",unavailable}};
}
Json execute_profile_actions(const std::filesystem::path& directory,const Json& args,const SemanticCall& call,
                             const SemanticDispatch& dispatch) {
        SemanticEvidence evidence;
        evidence.windowRef=args.at("windowRef").get<std::string>();
        const auto catalog=discover_profiles(directory,evidence.windowRef,
            [&](const std::string& op,const Json& parameters) {
                if(op=="ui.tree" && dispatch)evidence.session=call("system.session",Json::object());
                auto result=call(op,parameters);
                if(op=="window.get")evidence.window=result;
                if(op=="ui.tree")evidence.tree=result;
                return result;
            });
        if(operation_failed(catalog))return catalog;
        auto chosen=args.value("profileId",std::string{});
        const auto& candidates=catalog.at("profiles");
        if(chosen.empty() && candidates.size()==1)chosen=candidates[0].at("id");
        bool compatible=false;
        for(const auto& candidate:candidates)if(candidate.at("id")==chosen)compatible=true;
        bool incomplete=false;
        for(const auto& item:catalog.at("unavailable")) {
            if(!chosen.empty() && item.at("id")!=chosen)continue;
            for(const auto& reason:item.at("reasons"))if(reason=="ui_inspection_incomplete")incomplete=true;
        }
        if(!compatible)return {{"status","error"},{"code",chosen.empty() && candidates.size()>1 ? "profile_ambiguous" : incomplete ? "profile_inspection_incomplete" : "profile_not_matched"},
            {"dispatch","not_started"},{"completed",0},{"semantic",catalog},
            {"next",incomplete?"Compatibility is unknown; inspect using get_window_state(mode=image), then use execute_batch when visually clear. Do not repeat unchanged scans.":candidates.empty()?"No matching profile: use execute_batch or correct the reported app conditions.":"Choose one of the returned compatible profile ids."}};
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
        auto result=dispatch?dispatch(request,evidence):call("semantic.perform",request);
        result["profile"]=chosen;
        result["next"]="get_window_state to verify the visible result; do not replay completed actions.";
        return result;
}
}
