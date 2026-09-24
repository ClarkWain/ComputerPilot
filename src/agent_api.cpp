#include <desktop_pilot/agent_api.hpp>
#include <desktop_pilot/service.hpp>
#include <algorithm>
#include <cctype>
#include <chrono>
#include <set>
#include <sstream>
#include <thread>
#include <cmath>
#include <cstdlib>

namespace dp {
namespace {
Json objectSchema(Json properties,Json required=Json::array()) {
    return {{"type","object"},{"properties",properties},{"required",required},{"additionalProperties",false}};
}
Json stringSchema(){return {{"type","string"},{"minLength",1}};}
void fields(const Json& a,const std::set<std::string>& allowed) {
    if(!a.is_object()) throw std::invalid_argument("Expected an object");
    for(auto it=a.begin();it!=a.end();++it) if(!allowed.contains(it.key()))
        throw std::invalid_argument("Unknown field: "+it.key());
}
std::string requiredText(const Json& a,const char* key) {
    if(!a.contains(key)||!a[key].is_string()||a[key].get<std::string>().empty())
        throw std::invalid_argument(std::string("Required nonempty string: ")+key);
    return a[key].get<std::string>();
}
Json failure(const std::string& code,const std::string& message,const std::string& next) {
    return {{"status","error"},{"code",code},{"message",message},{"dispatch","not_started"},{"next",next}};
}
Json keys(std::string chord) {
    Json result=Json::array();std::istringstream stream(chord);std::string key;
    while(std::getline(stream,key,'+')) {
        key.erase(std::remove_if(key.begin(),key.end(),[](unsigned char c){return std::isspace(c);}),key.end());
        std::transform(key.begin(),key.end(),key.begin(),[](unsigned char c){return char(std::toupper(c));});
        static const std::map<std::string,std::string> aliases={{"CONTROL","CTRL"},{"CONTROL_L","CTRL"},{"RETURN","ENTER"},{"ESCAPE","ESC"},{"DEL","DELETE"},{"SPACEBAR","SPACE"}};
        if(auto it=aliases.find(key);it!=aliases.end())key=it->second;
        static const std::set<std::string> named={"CTRL","ALT","SHIFT","WIN","ENTER","TAB","ESC","BACKSPACE","DELETE","HOME","END","LEFT","RIGHT","UP","DOWN","SPACE","PAGEUP","PAGEDOWN","INSERT"};
        bool function=false;
        for(int i=1;i<=12;++i)if(key=="F"+std::to_string(i))function=true;
        if(!(key.size()==1&&std::isalnum(static_cast<unsigned char>(key[0])))&&!named.contains(key)&&!function)
            throw std::invalid_argument("Unsupported key: "+key+". Use Ctrl+A, Enter, Escape, Tab, arrows, A-Z, 0-9 or F1-F12; punctuation belongs in type_text.text.");
        result.push_back(key);
    }
    if(result.empty()||chord.ends_with('+'))throw std::invalid_argument("Empty key chord");
    return result;
}
}
Json AgentApi::tools() {
    auto s=stringSchema();
    auto point=objectSchema({{"x",{{"type","integer"},{"minimum",0}}},{"y",{{"type","integer"},{"minimum",0}}}},{"x","y"});
    auto action=[&](const char* type,Json properties,Json required) {
        properties["type"]={{"const",type}};required.push_back("type");return objectSchema(properties,required);
    };
    Json actions=Json::array({
        action("click",{{"point",point},{"control_id",s},{"count",{{"type","integer"},{"minimum",1},{"maximum",2}}}},Json::array()),
        action("fill_text",{{"control_id",s},{"text",{{"type","string"}}}},{"control_id","text"}),
        action("type_text",{{"text",{{"type","string"}}}},{"text"}),
        action("press_keys",{{"chord",s}},{"chord"}),
        action("drag",{{"from",point},{"to",point}},{"from","to"}),
        action("prepare_window",{{"client_size",objectSchema({{"width",{{"type","integer"},{"minimum",1},{"maximum",20000}}},{"height",{{"type","integer"},{"minimum",1},{"maximum",20000}}},{"unit",{{"const","dip96"}}}},{"width","height","unit"})},
            {"minimum_client_size",objectSchema({{"width",{{"type","integer"},{"minimum",1},{"maximum",20000}}},{"height",{{"type","integer"},{"minimum",1},{"maximum",20000}}},{"unit",{{"const","dip96"}}}},{"width","height","unit"})}},
            {"client_size"}),
        action("move",{{"points",{{"type","array"},{"minItems",1},{"maxItems",4096},{"items",{{"type","array"},{"minItems",2},{"maxItems",2},{"items",{{"type","integer"},{"minimum",0}}}}},{"description","Ordered [x,y] pairs in the latest state coordinateSpace; one continuous path."}}},
            {"hold",{{"type","string"},{"enum",{"left","right","middle"}},{"description","Optional: press at first point, hold through the path, release at end. Omit to move without pressing."}}}},{"points"})});
    actions[0]["oneOf"]=Json::array({Json{{"required",{"point"}},{"not",{{"required",{"control_id"}}}}},Json{{"required",{"control_id"}},{"not",{{"required",{"point"}}}}}});
    for(auto& a:actions)a["properties"]["delay_ms"]={{"type","integer"},{"minimum",0},{"maximum",10000},{"description","Optional delay before this action; default 0"}};
    Json actionSchema={{"oneOf",actions}};
    Json rows=Json::array();
    auto add=[&](const char* name,const char* description,Json schema,bool readOnly){
        rows.push_back({{"name",name},{"description",description},{"inputSchema",schema},
            {"annotations",{{"readOnlyHint",readOnly},{"destructiveHint",!readOnly},{"openWorldHint",true}}}});
    };
    add("list_windows","List all open windows. No parameters. Read the returned titles and pids to identify the intended window_id; does not activate or resize.",objectSchema(Json::object()),true);
    auto region=objectSchema({{"x",{{"type","integer"},{"minimum",0}}},{"y",{{"type","integer"},{"minimum",0}}},{"width",{{"type","integer"},{"minimum",1}}},{"height",{{"type","integer"},{"minimum",1}}}},{"x","y","width","height"});
    add("get_window_state","Get compact controls and semantic profiles by default. detail:full restores complete control fields and longer text. mode:image skips UI Automation and profile discovery; mode:both includes controls/profiles and a screenshot. Screenshots return a local capture.path by default; image_delivery:inline also sends an MCP image. max_edge sets the screenshot's longest pixel edge (default 1600 for full windows; regions retain source size); it never enlarges the capture. Basic point coordinates follow the returned coordinateSpace; screenshot coordinates map automatically. Optional region uses window-relative physical pixels for a lossless detail view. Restores focus unless activate:false.",objectSchema({{"window_id",s},{"mode",{{"type","string"},{"enum",{"controls","image","both"}},{"default","controls"}}},{"detail",{{"type","string"},{"enum",{"compact","full"}},{"default","compact"}}},{"image_delivery",{{"type","string"},{"enum",{"path","inline"}},{"default","path"}}},{"max_edge",{{"type","integer"},{"minimum",1},{"maximum",32000}}},{"region",region},{"activate",{{"type","boolean"},{"default",true}}}},{"window_id"}),false);
    auto semanticAction=objectSchema({{"action",s},{"args",{{"type","object"}}}},{"action","args"});
    add("execute_semantic","PREFERRED when get_window_state returns a matching profile. Execute 1..256 app actions using its examples. Omit profile to auto-select exactly one compatible profile; explicit ids are revalidated. Native execution manages controls, colors, focus and waits. Stops on failure; inspect the result before retrying.",objectSchema({{"window_id",s},{"profile",s},{"actions",{{"type","array"},{"items",semanticAction},{"minItems",1},{"maxItems",256}}}},{"window_id","actions"}),false);
    add("execute_batch","Execute basic actions on the last observed window. A standalone prepare_window action explicitly adjusts its client area in dip96 and returns the measured result; inspect again before input. control_id clicks prefer direct UIA invocation; pointer input restores focus. Points use the last state's coordinateSpace (image_pixels when a screenshot was returned, otherwise window pixels). Mapping is internal. Stops on failure without replay.",objectSchema({{"window_id",s},{"actions",{{"type","array"},{"items",actionSchema},{"minItems",1},{"maxItems",256}}}},{"window_id","actions"}),false);
    return rows;
}
Json AgentApi::call(const std::string& tool,const Json& a,const Dispatch& externalDispatch) {
    try {
        auto dispatch=[&](const std::string& operation,const Json& args) {
            auto result=externalDispatch(operation,args);
            if(result.value("referencesInvalidated",false)) {
                observations_.clear();targets_.clear();
                result["next"]="Worker references were invalidated. Call list_windows, then get_window_state mode:image with the new id. Inspect any prior input outcome before continuing; do not replay actions.";
            }
            return result;
        };
        // Focus recovery is executor work, not an extra agent planning step.
        auto prepareWindow=[&](const std::string& windowId)->Json {
            auto w=dispatch("window.get",{{"windowRef",windowId}});
            if(operation_failed(w))return w;
            if(!w.value("enabled",true)) {
                auto blocked=failure("window_blocked","Target is disabled; its modal dialog must be handled before these actions can continue.","Inspect the blocking window; do not replay input on another page.");
                if(w.contains("blockingWindow")) {
                    auto popup=w["blockingWindow"];auto ref=popup.at("windowRef").get<std::string>();targets_[ref]=popup;
                    blocked["blocking_window"]={{"window_id",ref},{"title",popup.value("title",std::string{})},{"pid",popup.at("pid")}};
                }
                return blocked;
            }
            if(!w.value("foreground",false)||w.value("minimized",false)) {
                auto activation=dispatch("window.activate",{{"windowRef",windowId}});
                if(operation_failed(activation))return activation;
                w=dispatch("window.get",{{"windowRef",windowId}});
                if(operation_failed(w))return w;
                if(!w.value("enabled",true))return failure("window_blocked","Target became blocked during activation.","get_window_state with activate:false to inspect");
                if(!w.value("foreground",false))return failure("window_activation_failed","Automatic activation did not restore target focus.","Inspect desktop/session or blocking window; no action input sent.");
            }
            return w;
        };
        if(tool=="list_windows") {
            fields(a,{});
            auto r=dispatch("window.list",Json::object());if(operation_failed(r))return r;auto windows=r.at("windows");
            Json candidates=Json::array();
            for(auto& w:windows) {
                auto ref=w.at("windowRef").get<std::string>();targets_[ref]=w;
                candidates.push_back({{"window_id",ref},{"title",w.value("title",std::string{})},{"pid",w.at("pid")}});
            }
            return {{"status","ok"},{"windows",candidates},{"next","Read titles/pids to identify the intended window_id, then get_window_state. No activation occurred."}};
        }
        if(tool=="get_window_state") {
            fields(a,{"window_id","mode","detail","image_delivery","max_edge","activate","region"});auto window_id=requiredText(a,"window_id");
            if(!targets_.contains(window_id))return failure("unknown_window","Use a window_id returned by list_windows in this session.","list_windows");
            observations_.erase(window_id);
            auto mode=a.value("mode",std::string("controls"));if(mode!="both"&&mode!="image"&&mode!="controls")throw std::invalid_argument("mode must be image, controls or both");
            auto detail=a.value("detail",std::string("compact"));if(detail!="compact"&&detail!="full")throw std::invalid_argument("detail must be compact or full");
            auto imageDelivery=a.value("image_delivery",std::string("path"));if(imageDelivery!="path"&&imageDelivery!="inline")throw std::invalid_argument("image_delivery must be path or inline");
            if(a.contains("region")&&mode=="controls")throw std::invalid_argument("region requires mode:image or both");
            if(mode=="controls"&&imageDelivery=="inline")throw std::invalid_argument("image_delivery:inline requires mode:image or both");
            if(a.contains("max_edge")&&(mode=="controls"||!a["max_edge"].is_number_integer()||a["max_edge"].get<int64_t>()<1||a["max_edge"].get<int64_t>()>32000))throw std::invalid_argument("max_edge requires image/both and integer 1..32000");
            auto w=a.value("activate",true)?prepareWindow(window_id):dispatch("window.get",{{"windowRef",window_id}});if(operation_failed(w))return w;
            Observation o;o.id="state-"+std::to_string(++serial_);o.window=w;
            Json result={{"status","ok"},{"window_id",window_id},{"title",w.value("title",std::string{})},
                {"foreground",w.value("foreground",false)},{"coordinateSpace","window_relative_physical_pixels"},
                {"size",{{"width",w["bounds"]["width"]},{"height",w["bounds"]["height"]}}},
                {"next","Prefer execute_semantic if a profile matches; otherwise execute_batch. Inspect again to verify the result."}};
            if(w.contains("client")&&w.contains("display"))result["layout"]={{"clientDip96",w["client"]["dip96"]},
                {"displayDpi",w["display"]["dpi"]},{"dpiAwareness",w.value("dpiAwareness",std::string("unknown"))}};
            // A screenshot must remain available when UI Automation is slow or broken.
            // An empty unchecked catalog is not evidence that an application is incompatible.
            Json profiles={{"status","not_checked"},{"profiles",Json::array()},{"unavailable",Json::array()},
                {"next","Image-only observation skips UI Automation. Use controls/both to discover semantic actions, or execute_batch from this screenshot."}};
            if(mode!="image") profiles=dispatch("semantic.profiles",{{"windowRef",window_id},{"includeControls",true},{"providerTimeoutMs",8000}});
            if(profiles.value("referencesInvalidated",false)) {
                return profiles;
            }
            if(mode!="image") {
                auto tree=operation_failed(profiles)?profiles:(profiles.contains("inspection")?profiles["inspection"]:dispatch("ui.tree",{{"windowRef",window_id},{"format","compact"},{"depth",6},{"limit",80},{"nodeBudget",1500},{"queryTimeoutMs",3000},{"providerTimeoutMs",5000}}));
                if(tree.value("referencesInvalidated",false)) {
                    return tree;
                }
                if(!operation_failed(tree) && (!tree.contains("elements") || !tree.at("elements").is_array()))
                    tree={{"status","error"},{"code","invalid_inspection_result"},{"message","UI inspection did not return an elements array."}};
                const bool failed=operation_failed(tree);
                if(failed && mode=="controls") {
                    tree["next"]="UI inspection failed. Use get_window_state mode:image and execute_batch from visible evidence; do not repeat the same scan unchanged.";
                    return tree;
                }
                result["controls"]=Json::array();result["truncated"]=tree.value("truncated",false);
                const bool incomplete=!ui_inspection_complete(tree);
                result["inspection"]={{"status",failed?"error":incomplete?"incomplete":"ok"}};
                for(auto key:{"stopReason","visited","truncated","has_more","evidenceComplete","metrics","message","code","providerError"})
                    if(tree.contains(key))result["inspection"][key]=tree[key];
                if(failed) {
                    result["truncated"]=true;
                    result["next"]="UI inspection failed; screenshot remains available. Use execute_batch from visible evidence instead of repeating the same scan.";
                }
                else if(incomplete) result["next"]="UI inspection is incomplete. Use mode:image if needed, then execute_batch from visible evidence; do not repeat unchanged scans.";
                // Cap oversized text (e.g. an editor buffer exposed as a control name/value) to bound tokens.
                auto cap=[](std::string s,size_t limit)->std::string{
                    if(s.size()<=limit)return s;
                    size_t cut=limit;
                    while(cut>0&&(static_cast<unsigned char>(s[cut])&0xC0)==0x80)--cut;
                    return s.substr(0,cut)+"…[+"+std::to_string(s.size()-cut)+"]";
                };
                for(auto e:failed?Json::array():tree.at("elements")) {
                    if(!e.contains("elementRef"))continue;
                    if(e.value("name",std::string{}).empty()&&(e.value("role",std::string{})=="Pane"||e.value("role",std::string{})=="Window"))continue;
                    if(result["controls"].size()>=80){result["truncated"]=true;break;}
                    auto ref=e.at("elementRef").get<std::string>();o.controls[ref]=e;
                    Json c={{"control_id",ref},{"name",cap(e.value("name",std::string{}),detail=="compact"?128:256)},{"role",e.value("role",std::string{})}};
                    for(auto key:{"value","enabled","offscreen"})if(e.contains(key)) {
                        if(detail=="compact" && ((std::string(key)=="value" && (e[key].is_null() || e[key]=="")) ||
                            (std::string(key)=="enabled" && e[key]==true) || (std::string(key)=="offscreen" && e[key]==false)))continue;
                        c[key]=(std::string(key)=="value"&&e[key].is_string())?Json(cap(e[key].get<std::string>(),detail=="compact"?256:2048)):e[key];
                    }
                    if(e.contains("bounds")&&e["bounds"].is_object()) {
                        c["bounds"]=Json::array({
                            e["bounds"]["x"].get<int>()-w["bounds"]["x"].get<int>(),
                            e["bounds"]["y"].get<int>()-w["bounds"]["y"].get<int>(),
                            e["bounds"]["width"].get<int>(),
                            e["bounds"]["height"].get<int>()});
                    }
                    result["controls"].push_back(c);
                }
            }
            if(mode!="controls") {
                const char* format=std::getenv("DP_IMAGE_FORMAT");
                const bool webp=webp_available()&&format&&std::string(format)=="webp";
                auto path=std::filesystem::temp_directory_path()/std::filesystem::u8path("desktop-pilot-observe-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+(webp?".webp":".png"));
                Json captureArgs={{"windowRef",window_id},{"method","screen"},{"output",utf8(path.wstring())},{"maxEdge",a.value("max_edge",a.contains("region")?32000:1600)}};
                if(a.contains("region")) {fields(a["region"],{"x","y","width","height"});captureArgs["region"]=a["region"];captureArgs["lossless"]=true;}
                auto capture=dispatch("capture.window",captureArgs);
                if(operation_failed(capture))return capture;
                capture["delivery"]=imageDelivery;
                result["capture"]=capture;o.capture=capture;
                result["coordinateSpace"]="image_pixels";
                result["inputSize"]={{"width",capture["width"]},{"height",capture["height"]}};
            }
            auto after=dispatch("window.get",{{"windowRef",window_id}});if(operation_failed(after))return after;
            if(after["bounds"]!=w["bounds"]||after.value("dpi",Json())!=w.value("dpi",Json())||after.value("client",Json())!=w.value("client",Json())||after.value("display",Json())!=w.value("display",Json()))return failure("geometry_changed","Window geometry or DPI changed while observing.","get_window_state");
            profiles.erase("inspection");
            result["semantic"]=profiles;
            observations_[window_id]=std::move(o);return result;
        }
        if(tool=="execute_semantic") {
            fields(a,{"window_id","profile","actions"});
            auto window_id=requiredText(a,"window_id");
            if(!targets_.contains(window_id))return failure("unknown_window","Use a window_id returned by list_windows.","list_windows");
            const auto& actions=a.at("actions");
            if(!actions.is_array()||actions.empty()||actions.size()>256)throw std::invalid_argument("actions must contain 1..256 items");
            for(const auto& item:actions) {fields(item,{"action","args"});requiredText(item,"action");if(!item.at("args").is_object())throw std::invalid_argument("args must be an object");}
            Json request={{"windowRef",window_id},{"actions",actions},{"providerTimeoutMs",600000}};
            if(a.contains("profile"))request["profileId"]=requiredText(a,"profile");
            auto w=prepareWindow(window_id);if(operation_failed(w))return w;
            observations_.erase(window_id);
            return dispatch("semantic.execute",request);
        }
        if(tool!="execute_batch")throw std::invalid_argument("Unknown tool");
        fields(a,{"window_id","actions"});
        auto window_id=requiredText(a,"window_id");
        auto found=observations_.find(window_id);
        if(found==observations_.end())return failure("state_required","Inspect this window before sending another input batch.","get_window_state");
        auto o=found->second;Json actions=a.at("actions");
        if(!actions.is_array()||actions.empty()||actions.size()>256)throw std::invalid_argument("actions must contain 1..256 items");
        auto geometryChanged=[&](const Json& w){return w["bounds"]!=o.window["bounds"]||
            w.value("dpi",Json())!=o.window.value("dpi",Json())||
            w.value("client",Json())!=o.window.value("client",Json())||
            w.value("display",Json())!=o.window.value("display",Json());};
        if(actions[0].is_object()&&actions[0].value("type",std::string{})=="prepare_window") {
            if(actions.size()!=1)throw std::invalid_argument("prepare_window must be the only action; inspect the new layout before input");
            const auto& action=actions[0];fields(action,{"type","client_size","minimum_client_size"});
            auto size=[&](const Json& value){fields(value,{"width","height","unit"});
                if(value.value("unit",std::string{})!="dip96")throw std::invalid_argument("client size unit must be dip96");
                for(auto key:{"width","height"})if(!value.contains(key)||!value[key].is_number_integer()||value[key].get<int64_t>()<1||value[key].get<int64_t>()>20000)throw std::invalid_argument("client size must be 1..20000 dip96");
            };
            const auto& preferred=action.at("client_size");size(preferred);
            const auto& minimum=action.value("minimum_client_size",preferred);size(minimum);
            for(auto key:{"width","height"})if(minimum[key].get<int>()>preferred[key].get<int>())throw std::invalid_argument("minimum client size exceeds preferred size");
            auto current=prepareWindow(window_id);if(operation_failed(current))return current;
            if(geometryChanged(current))return failure("geometry_changed","Window changed since observation.","get_window_state");
            observations_.erase(window_id);
            auto prepared=dispatch("window.prepare",{{"windowRef",window_id},{"width",preferred["width"]},{"height",preferred["height"]},
                {"minimumWidth",minimum["width"]},{"minimumHeight",minimum["height"]}});
            prepared["next"]="get_window_state to inspect actual layout before further input";
            return prepared;
        }
        Json planned=Json::array();
        auto point=[&](const Json& p) {
            fields(p,{"x","y"});
            for(auto key:{"x","y"})if(!p.contains(key)||!p[key].is_number_integer())throw std::invalid_argument("Point needs integer x/y");
            const auto& frame=o.capture.is_null()?o.window["bounds"]:o.capture;
            if(p["x"].get<int64_t>()<0||p["y"].get<int64_t>()<0||p["x"].get<int64_t>()>=frame["width"].get<int>()||p["y"].get<int64_t>()>=frame["height"].get<int>())
                throw std::invalid_argument("Point is outside observed window; no screen coordinates accepted");return p;
        };
        auto mappedPoint=[&](const Json& p) {
            auto mapped=point(p);
            if(!o.capture.is_null())for(auto pair:{std::pair{"x","width"},std::pair{"y","height"}}) {
                const auto [axis,extent]=pair;
                const int span=o.capture["bounds"][extent].get<int>();
                mapped[axis]=std::min(span-1,int(std::floor((p[axis].get<double>()+0.5)*span/o.capture[extent].get<int>())))+
                    o.capture["bounds"][axis].get<int>()-o.window["bounds"][axis].get<int>();
            }
            return mapped;
        };
        for(auto action:actions) {
            if(action.contains("delay_ms")&&(!action["delay_ms"].is_number_integer()||action["delay_ms"].get<int64_t>()<0||action["delay_ms"].get<int64_t>()>10000))throw std::invalid_argument("delay_ms must be integer 0..10000");
            const auto delay=action.value("delay_ms",0);action.erase("delay_ms");
            auto type=requiredText(action,"type");Json args={{"windowRef",window_id},{"autoActivate",true},{"coordinateSpace","window_relative"},
                {"expectedSize",{{"width",o.window["bounds"]["width"]},{"height",o.window["bounds"]["height"]}}}};
            std::string op;Json control_id=nullptr;
            if(action.contains("control_id")) {
                auto ref=requiredText(action,"control_id");if(!o.controls.contains(ref))throw std::invalid_argument("control_id must come from the last observation");control_id=o.controls.at(ref);
            }
            if(type=="click") {
                fields(action,{"type","point","control_id","count"});
                if(action.contains("point")==action.contains("control_id"))throw std::invalid_argument("click needs exactly one of point/control_id");
                Json p;
                if(!control_id.is_null()) {auto b=control_id.at("bounds");p={{"x",b["x"].get<int>()+b["width"].get<int>()/2-o.window["bounds"]["x"].get<int>()},{"y",b["y"].get<int>()+b["height"].get<int>()/2-o.window["bounds"]["y"].get<int>()}};}
                else p=mappedPoint(action.at("point"));args.update(p);
                if(action.contains("count")&&(!action["count"].is_number_integer()||action["count"].get<int>()<1||action["count"].get<int>()>2))throw std::invalid_argument("click count must be 1 or 2");
                args["count"]=action.value("count",1);op="input.click";
                if(!control_id.is_null()&&args["count"]==1){op="ui.click";args={{"windowRef",window_id},{"elementRef",control_id["elementRef"]}};}
            } else if(type=="fill_text"||type=="type_text") {
                fields(action,type=="fill_text"?std::set<std::string>{"type","control_id","text"}:std::set<std::string>{"type","text"});
                if(!action.contains("text")||!action["text"].is_string())throw std::invalid_argument("text must be a string");
                args["text"]=action["text"];op="input.type_text";
                if(type=="fill_text") {if(control_id.is_null())throw std::invalid_argument("fill_text requires an observed control_id");op="ui.fill";args={{"windowRef",window_id},{"autoActivate",true},{"elementRef",control_id["elementRef"]},{"text",action["text"]},{"timeoutMs",3000}};}
            } else if(type=="press_keys") {fields(action,{"type","chord"});args["keys"]=keys(requiredText(action,"chord"));op="input.key_chord";}
            else if(type=="drag") {fields(action,{"type","from","to"});args.update(mappedPoint(action.at("from")));auto to=mappedPoint(action.at("to"));args["toX"]=to["x"];args["toY"]=to["y"];op="input.drag";}
            else if(type=="move") {
                fields(action,{"type","points","hold"});
                const auto& points=action.at("points");
                if(!points.is_array()||points.empty()||points.size()>4096)throw std::invalid_argument("move.points must contain 1..4096 [x,y] pairs");
                for(const auto& p:points) {
                    if(!p.is_array()||p.size()!=2)throw std::invalid_argument("move point must be [x,y]");
                    point({{"x",p[0]},{"y",p[1]}});
                }
                if(action.contains("hold")) {
                    auto hold=requiredText(action,"hold");
                    if(hold!="left"&&hold!="right"&&hold!="middle")throw std::invalid_argument("move.hold must be left, right or middle");
                    if(points.size()<2)throw std::invalid_argument("Held move needs at least two points; use click for one point");
                    args["hold"]=hold;
                }
                args["points"]=Json::array();for(const auto& p:points){auto mapped=mappedPoint({{"x",p[0]},{"y",p[1]}});args["points"].push_back({mapped["x"],mapped["y"]});}op="input.move";
            }
            else throw std::invalid_argument("Unknown action type: "+type);
            planned.push_back({{"delay_ms",delay},{"operation",op},{"args",args},{"control_id",control_id}});
        }
        size_t completed=0,fieldsVerified=0;bool attempted=false;
        // Consume before execution: even an unknown outcome cannot reuse the old observation.
        observations_.erase(window_id);
        for(auto& step:planned) {
            Json r;
            try {
                if(step["delay_ms"].get<int>()>0)std::this_thread::sleep_for(std::chrono::milliseconds(step["delay_ms"].get<int>()));
                auto w=prepareWindow(window_id);
                if(operation_failed(w))r=w;
                else if(geometryChanged(w))r=failure("geometry_changed","Window geometry or DPI changed since observation.","get_window_state");
                else {
                    if(!step["control_id"].is_null()) {
                        auto current=dispatch("ui.get",{{"elementRef",step["control_id"]["elementRef"]}});
                        if(operation_failed(current))r=current;
                        else if(current["bounds"]!=step["control_id"]["bounds"])r=failure("control_changed","Control moved since observation.","get_window_state");
                    }
                    if(r.is_null()) {attempted=true;r=dispatch(step["operation"],step["args"]);}
                }
            } catch(const std::exception& e){r={{"status","error"},{"message",e.what()}};}
            if(operation_failed(r)) {
                Json result={{"status","error"},{"code","action_failed"},{"completed",completed},{"failedIndex",completed},
                {"dispatch",r.value("dispatch",std::string(attempted?"unknown":"not_started"))},{"error",r},
                {"next","get_window_state; inspect failed action outcome before submitting only unfinished actions. No rollback."}};
                if(r.value("referencesInvalidated",false)) {
                    result["referencesInvalidated"]=true;result["next"]=r.at("next");
                }
                return result;
            }
            if(step["operation"]=="ui.fill")++fieldsVerified;
            ++completed;attempted=false;
        }
        return {{"status","ok"},{"completed",completed},{"fieldsVerified",fieldsVerified},{"verification","business_result_not_verified"},
            {"next","get_window_state to verify the requested outcome; previous observation is consumed"}};
    } catch(const std::exception& e) {return failure("invalid_arguments",e.what(),"Correct arguments; if state changed use get_window_state");}
}
}
