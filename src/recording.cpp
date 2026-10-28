#include <desktop_pilot/recording.hpp>
#include <desktop_pilot/service.hpp>
#include <algorithm>
#include <cmath>
#include <iostream>
#include <optional>
#include <set>

namespace dp {
ActionRecording::ActionRecording(const std::filesystem::path& directory) {
    if(directory.empty())throw std::invalid_argument("Recording requires a new directory");
    auto destination=std::filesystem::absolute(directory).lexically_normal();
    if(std::filesystem::exists(destination)||!std::filesystem::create_directories(destination))
        throw std::invalid_argument("Recording directory must not exist");
#ifndef _WIN32
    std::filesystem::permissions(destination,std::filesystem::perms::owner_all);
#endif
    path_=destination/"session.jsonl";stream_.open(path_,std::ios::binary);
    if(!stream_)throw std::runtime_error("Cannot create recording journal");
#ifndef _WIN32
    std::filesystem::permissions(path_,std::filesystem::perms::owner_read|std::filesystem::perms::owner_write);
#endif
    append({{"event","session"},{"schemaVersion",1},{"source","desktop-pilot-calls"}});
}
void ActionRecording::append(const Json& event) {
    if(failed_||finished_)throw std::runtime_error("Recording is closed or unavailable; no further input may be dispatched");
    const auto encoded=event.dump(-1,' ',false,Json::error_handler_t::replace);
    if(encoded.size()>8*1024*1024||stream_.tellp()+std::streamoff(encoded.size()+1)>std::streamoff(32*1024*1024)) {
        failed_=true;throw std::runtime_error("Recording journal size limit reached");
    }
    stream_<<encoded<<'\n';stream_.flush();
    if(!stream_){failed_=true;throw std::runtime_error("Recording journal write failed");}
}
void ActionRecording::observe_window(const std::string& operation,const Json& result) {
    if(operation=="window.get"&&!operation_failed(result)&&result.contains("windowRef")) {
        Json identity=Json::object();
        for(const auto key:{"windowRef","title","executable","bundleIdentifier","pid","bounds","desktopContext"})
            if(result.contains(key))identity[key]=result[key];
        windows_[result["windowRef"].get<std::string>()]=std::move(identity);
    }
}
Json ActionRecording::call(const std::string& tool,const Json& args,const ReplayCall& execute) {
    // Do not retain inventories of unrelated windows or list-tools traffic.
    if(tool=="list_windows")return execute(tool,args);
    const auto sequence=++sequence_;
    append({{"event","begin"},{"sequence",sequence},{"tool",tool},{"arguments",args}});
    Json result;
    try{result=execute(tool,args);}
    catch(const std::exception& error){result={{"status","error"},{"dispatch","unknown"},{"message",error.what()}};}
    Json event={{"event","result"},{"sequence",sequence},{"result",result}};
    if(args.contains("window_id")) {
        auto found=windows_.find(args["window_id"].get<std::string>());
        if(found!=windows_.end())event["window"]=found->second;
    }
    try{append(event);}
    catch(const std::exception& error) {
        // Preserve partial completion and the real outcome when post-dispatch
        // logging fails. A caller must inspect, not blindly repeat the action.
        auto outcome=result;result["recordedOutcome"]=std::move(outcome);
        result["status"]="error";result["code"]="recording_write_failed";
        result["dispatch"]=result.value("dispatch",std::string("unknown"));result["message"]=error.what();
        result["automaticRetry"]=false;
    }
    return result;
}
void ActionRecording::finish() {
    if(finished_)return;
    append({{"event","end"},{"calls",sequence_}});finished_=true;stream_.close();
}

namespace {
bool usable(const Json& control) {return control.value("enabled",true)&&!control.value("offscreen",false);}
bool matches(const Json& control,const Json& selector) {
    if(!usable(control)||control.value("role",std::string{})!=selector.at("role").get<std::string>())return false;
    if(selector.contains("name")&&control.value("name",std::string{})!=selector["name"].get<std::string>())return false;
    return !selector.contains("bounds")||(control.contains("bounds")&&control["bounds"][2]==selector["bounds"]["width"]&&control["bounds"][3]==selector["bounds"]["height"]);
}
Json unique_control(const Json& state,const Json& selector) {
    Json found;size_t count=0;
    for(const auto& control:state.at("controls"))if(matches(control,selector)){found=control;++count;}
    if(count!=1)throw std::runtime_error("Recording export needs a unique visible control: "+dump_json(selector));
    return found;
}
Json control_selector(const Json& state,const Json& control) {
    Json selector={{"role",control.at("role")}};
    if(!control.value("name",std::string{}).empty())selector["name"]=control["name"];
    auto unique=[&]{size_t count=0;for(const auto& c:state.at("controls"))if(matches(c,selector))++count;return count==1;};
    if(!selector.contains("name")||!unique()) {
        const auto& b=control.at("bounds");selector["bounds"]={{"width",b[2]},{"height",b[3]}};
    }
    if(!unique())throw std::runtime_error("Recording control cannot be exported without an ambiguous locator");
    return selector;
}
Json native_point(const Json& state,const Json& point) {
    if(!point.is_array()||point.size()!=2||!point[0].is_number_integer()||!point[1].is_number_integer())throw std::runtime_error("Invalid recorded point");
    const auto space=state.at("coordinateSpace").get<std::string>();Json mapped=point;
    if(space=="image_pixels") {
        const auto& capture=state.at("capture");
        for(int i=0;i<2;++i) {
            const char* axis=i==0?"x":"y";const char* extent=i==0?"width":"height";
            const int pixel=point[i],size=capture.at(extent),span=capture["bounds"][extent];
            if(pixel<0||pixel>=size||span<1)throw std::runtime_error("Recorded point outside capture");
            mapped[i]=std::min(span-1,int(std::floor((pixel+0.5)*span/size)))+capture["bounds"][axis].get<int>()-capture["windowBounds"][axis].get<int>();
        }
    } else if(space!="window_relative_points")throw std::runtime_error("Recording export requires macOS native units");
    for(int i=0;i<2;++i)if(mapped[i].get<int>()<0||mapped[i].get<int>()>=state["size"][i==0?"width":"height"].get<int>())throw std::runtime_error("Recorded point outside window");
    return mapped;
}
Json point_control(const Json& state,const Json& point) {
    const std::set<std::string> roles={"Button","CheckBox","RadioButton","ComboBox","AXColorWell","AXGrid","AXImage"};
    Json selected;int64_t area=INT64_MAX;
    for(const auto& c:state.at("controls")) {
        if(!usable(c)||!roles.contains(c.value("role",std::string{}))||!c.contains("bounds"))continue;
        const auto& b=c["bounds"];int x=point[0],y=point[1],w=b[2],h=b[3];
        if(x<b[0].get<int>()||y<b[1].get<int>()||x>=b[0].get<int>()+w||y>=b[1].get<int>()+h||w<=0||h<=0)continue;
        const auto candidate=int64_t(w)*h;
        if(candidate<area){selected=c;area=candidate;}
        else if(candidate==area)throw std::runtime_error("Overlapping recorded click targets are ambiguous");
    }
    if(selected.is_null())throw std::runtime_error("Recorded coordinate click has no supported control anchor");
    return selected;
}
}
Json export_recording(const std::filesystem::path& journal,const Json& model) {
    validate_replay(model);
    if(std::filesystem::file_size(journal)>32*1024*1024)throw std::invalid_argument("Recording journal exceeds 32 MiB");
    std::ifstream input(journal,std::ios::binary);if(!input)throw std::runtime_error("Cannot open recording journal");
    Json recipe=model;recipe["steps"]=Json::array();recipe["strokes"]=Json::object();
    recipe["name"]=model["name"].get<std::string>()+" (recorded)";
    recipe["provenance"]={{"source","desktop-pilot-calls"},{"journalSha256",file_sha256(journal)},{"templateSha256Scope","application/canvas only; original steps are not copied"}};
    std::optional<Json> pending;Json state;std::string target,title;bool session=false,ended=false,needsObservation=false,initialized=false;
    size_t calls=0,events=0;Json generation;
    auto add=[&](Json step){if(recipe["steps"].size()>=512)throw std::runtime_error("Exported recording exceeds 512 steps");recipe["steps"].push_back(std::move(step));};
    auto wait=[&](const Json& selector){add({{"name","Wait for recorded control"},{"type","wait"},{"selector",selector},{"timeoutMs",2000}});};
    auto verifyIdentity=[&](const Json& event) {
        if(!event.contains("window"))throw std::runtime_error("Recorded window identity is missing");
        const auto& w=event["window"];
        if(w.at("executable")!=model["application"]["executable"]||w.at("bundleIdentifier")!=model["application"]["bundleId"])
            throw std::runtime_error("Recorded application differs from export template");
        const auto id=w.at("windowRef").get<std::string>(),currentTitle=w.at("title").get<std::string>();
        if(target.empty()){target=id;title=currentTitle;}
        if(target!=id||title!=currentTitle)throw std::runtime_error("Recording changed document identity");
        if(w.contains("desktopContext")) {
            const auto& context=w["desktopContext"];
            if(!context.value("ready",false))throw std::runtime_error("Recording contains a desktop pause");
            if(!generation.is_null()&&generation!=context.at("generation"))throw std::runtime_error("Recording spans a desktop session transition");
            generation=context.at("generation");
        }
    };
    std::string line;
    while(std::getline(input,line)) {
        if(++events>20000||line.empty())throw std::runtime_error("Invalid or oversized recording event stream");
        auto event=Json::parse(line);const auto kind=event.at("event").get<std::string>();
        if(ended)throw std::runtime_error("Recording has data after its end marker");
        if(!session) {
            if(kind!="session"||event.at("schemaVersion")!=1||event.at("source")!="desktop-pilot-calls")throw std::runtime_error("Unsupported recording session");
            session=true;continue;
        }
        if(kind=="end") {
            if(pending||event.at("calls")!=calls)throw std::runtime_error("Recording ended with incomplete calls");
            ended=true;continue;
        }
        if(kind=="begin") {
            if(pending||event.at("sequence")!=calls+1)throw std::runtime_error("Recording call order is incomplete");
            pending=event;continue;
        }
        if(kind!="result"||!pending||event.at("sequence")!=pending->at("sequence"))throw std::runtime_error("Recording result has no matching request");
        ++calls;const auto request=*pending;pending.reset();
        const auto tool=request.at("tool").get<std::string>();const auto& args=request.at("arguments");const auto& result=event.at("result");
        if(tool=="get_window_state") {
            if(operation_failed(result)){state=nullptr;continue;}
            verifyIdentity(event);
            if(result.value("status",std::string{})!="ok"||result.at("window_id")!=target)throw std::runtime_error("Recorded observation identity is invalid");
            // Image-only reads cannot replace the controls that anchor actions.
            if(!result.contains("controls")||result["controls"].empty()){state=nullptr;continue;}
            // A recorded flow may start with a toolbar/tool already enabled.
            // Reconstruct those observed binary states on a fresh document,
            // in provider order (parent toolbar before its drawing tool).
            if(!initialized) {
                for(const auto& c:result["controls"])if(usable(c)&&c.value("role",std::string{})=="CheckBox"&&c.value("value",Json())==1) {
                    auto selector=control_selector(result,c);wait(selector);
                    add({{"name","Restore initially enabled tool"},{"type","ensure"},{"selector",selector},{"value",1}});
                }
                initialized=true;
            }
            if(needsObservation)needsObservation=false;
            state=result;continue;
        }
        if(tool!="execute_batch")throw std::runtime_error("Recording export does not support "+tool);
        if(operation_failed(result)||result.value("status",std::string{})!="ok"||result.at("completed")!=args.at("actions").size())
            throw std::runtime_error("Recording contains a failed, partial or unknown input outcome; no replay exported");
        verifyIdentity(event);
        if(state.is_null()||needsObservation||args.at("window_id")!=target)throw std::runtime_error("Recorded input lacks a fresh observation");
        Json drawIds=Json::array();
        auto flushDraw=[&]{if(!drawIds.empty()){add({{"name","Recorded strokes"},{"type","draw"},{"strokes",drawIds}});drawIds=Json::array();}};
        for(const auto& action:args.at("actions")) {
            if(action.value("delay_ms",0)!=0)throw std::runtime_error("Recording export cannot preserve explicit action delays");
            const auto type=action.at("type").get<std::string>();
            if(type=="move"&&action.value("hold",std::string{})=="left") {
                auto canvas=unique_control(state,model["canvas"]["selector"]);const auto& b=canvas.at("bounds");Json points=Json::array();
                if(drawIds.empty())for(const auto& c:state["controls"])if(usable(c)&&c.contains("value")) {
                    const auto role=c.value("role",std::string{});
                    if((role=="AXColorWell"&&c["value"].is_string())||(role=="CheckBox"&&c["value"]==1))
                        add({{"name","Check recorded drawing state"},{"type","assert"},{"selector",control_selector(state,c)},{"value",c["value"]}});
                }
                for(const auto& point:action.at("points")) {auto native=native_point(state,point);points.push_back({native[0].get<int>()-b[0].get<int>(),native[1].get<int>()-b[1].get<int>()});}
                auto id="stroke-"+std::to_string(recipe["strokes"].size()+1);recipe["strokes"][id]=points;drawIds.push_back(id);continue;
            }
            flushDraw();
            if(type=="press_keys")add({{"name","Recorded keyboard chord"},{"type","keys"},{"chord",action.at("chord")}});
            else if(type=="click") {
                if(action.value("count",1)!=1)throw std::runtime_error("Double-click recording export is not supported");
                Json control,point;
                if(action.contains("control_id")) {
                    size_t count=0;for(const auto& c:state["controls"])if(c.at("control_id")==action["control_id"]){control=c;++count;}
                    if(count!=1||!usable(control))throw std::runtime_error("Recorded control id is stale or unavailable");
                } else {point=native_point(state,Json::array({action["point"]["x"],action["point"]["y"]}));control=point_control(state,point);}
                auto selector=control_selector(state,control);wait(selector);
                const auto role=control.at("role").get<std::string>();const auto value=control.value("value",Json());
                if((role=="CheckBox"||role=="RadioButton")&&value.is_number_integer()&&(value==0||value==1)) {
                    const int next=role=="RadioButton"?1:1-value.get<int>();
                    add({{"name","Set recorded toggle"},{"type","ensure"},{"selector",selector},{"value",next}});
                    for(auto& c:state["controls"])if(c["control_id"]==control["control_id"])c["value"]=next;
                } else {
                    Json step={{"name","Recorded click"},{"type","click"},{"selector",selector}};
                    if(!point.is_null()) {
                        const auto& b=control["bounds"];step["selector"]["bounds"]={{"width",b[2]},{"height",b[3]}};
                        unique_control(state,step["selector"]);step["offset"]={point[0].get<int>()-b[0].get<int>(),point[1].get<int>()-b[1].get<int>()};
                    }
                    add(step);
                }
            } else throw std::runtime_error("Recording export does not support action "+type);
        }
        flushDraw();needsObservation=true;
    }
    if(!session||!ended||pending||needsObservation)throw std::runtime_error("Recording is incomplete or lacks a final observation");
    validate_replay(recipe);return recipe;
}
int recording_export_cli(const std::filesystem::path& journal,const std::filesystem::path& model,const std::filesystem::path& directory) {
    if(std::filesystem::file_size(model)>8*1024*1024)throw std::invalid_argument("Recording template exceeds 8 MiB");
    std::ifstream input(model);if(!input)throw std::runtime_error("Cannot read recording export template");
    auto recipe=export_recording(journal,Json::parse(input));auto summary=validate_replay(recipe);
    if(directory.empty()||std::filesystem::exists(directory)||!std::filesystem::create_directories(directory))throw std::invalid_argument("Export requires a new output directory");
    auto path=std::filesystem::absolute(directory)/"replay.json";write_json(path,recipe);
    summary["output"]=utf8(path.wstring());summary["mode"]="recording-export";std::cout<<dump_json(summary,2)<<'\n';return 0;
}
}
