#include <desktop_pilot/replay.hpp>
#include <desktop_pilot/agent_api.hpp>
#include <desktop_pilot/service.hpp>
#include <algorithm>
#include <chrono>
#include <thread>
#include <cmath>
#include <set>
#include <sstream>
#include <stdexcept>

namespace dp {
namespace {
void fields(const Json& value,const std::set<std::string>& allowed) {
    if(!value.is_object())throw std::invalid_argument("Replay field must be an object");
    for(auto it=value.begin();it!=value.end();++it)
        if(!allowed.contains(it.key()))throw std::invalid_argument("Unknown replay field: "+it.key());
}
std::string text(const Json& object,const char* key) {
    if(!object.contains(key)||!object[key].is_string()||object[key].get<std::string>().empty()||object[key].get<std::string>().size()>512)
        throw std::invalid_argument(std::string("Replay requires nonempty string: ")+key);
    return object[key].get<std::string>();
}
int integer(const Json& object,const char* key,int lo,int hi) {
    if(!object.contains(key)||!object[key].is_number_integer()||object[key].get<int64_t>()<lo||object[key].get<int64_t>()>hi)
        throw std::invalid_argument(std::string("Replay integer outside range: ")+key);
    return object[key].get<int>();
}
void pair(const Json& value,int maxX,int maxY) {
    if(!value.is_array()||value.size()!=2||!value[0].is_number_integer()||!value[1].is_number_integer()||
       value[0].get<int64_t>()<0||value[1].get<int64_t>()<0||value[0].get<int64_t>()>=maxX||value[1].get<int64_t>()>=maxY)
        throw std::invalid_argument("Replay point outside its coordinate space");
}
void selector(const Json& value) {
    fields(value,{"name","role","bounds"});text(value,"role");
    if(value.contains("name"))text(value,"name");
    if(!value.contains("name")&&!value.contains("bounds"))throw std::invalid_argument("Replay selector needs name or bounds evidence");
    if(value.contains("bounds")) {
        fields(value["bounds"],{"width","height"});
        integer(value["bounds"],"width",1,32000);integer(value["bounds"],"height",1,32000);
    }
}
Json locate(const Json& state,const Json& target) {
    Json hits=Json::array();
    for(const auto& control:state.at("controls")) {
        if(!control.value("enabled",true)||control.value("offscreen",false)||control.value("role",std::string{})!=target.at("role").get<std::string>())continue;
        if(target.contains("name")&&control.value("name",std::string{})!=target.at("name").get<std::string>())continue;
        if(target.contains("bounds")) {
            if(!control.contains("bounds")||!control["bounds"].is_array()||control["bounds"].size()!=4)continue;
            if(control["bounds"][2]!=target["bounds"]["width"]||control["bounds"][3]!=target["bounds"]["height"])continue;
        }
        hits.push_back(control);
    }
    if(hits.size()!=1)throw std::runtime_error("replay_locator_"+std::string(hits.empty()?"missing":"ambiguous")+": "+dump_json(target));
    return hits[0];
}
bool expected(const Json& control,const Json& step) {
    if(step.contains("value"))return control.value("value",Json())==step["value"];
    const auto value=control.value("value",Json());if(!value.is_string())return false;
    std::istringstream input(value.get<std::string>());std::string prefix;input>>prefix;
    if(prefix!="rgb")return false;
    for(const auto& component:step.at("color")) {
        double actual=0;if(!(input>>actual)||!std::isfinite(actual)||std::abs(actual-component.get<double>())>0.005)return false;
    }
    input>>std::ws;return input.eof();
}
}
Json validate_replay(const Json& recipe) {
    fields(recipe,{"schemaVersion","name","platform","application","canvas","strokes","steps","provenance"});
    if(!recipe.contains("schemaVersion")||!recipe["schemaVersion"].is_number_integer()||recipe["schemaVersion"]!=1)
        throw std::invalid_argument("Unsupported replay schemaVersion");
    text(recipe,"name");if(text(recipe,"platform")!="macos")throw std::invalid_argument("Replay v1 currently supports macOS documents");
    fields(recipe.at("application"),{"bundleId","executable"});
    const auto bundle=text(recipe["application"],"bundleId");text(recipe["application"],"executable");
    if(bundle.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-")!=std::string::npos)
        throw std::invalid_argument("Invalid replay application bundleId");
    const auto& canvas=recipe.at("canvas");fields(canvas,{"width","height","background","selector"});
    int width=integer(canvas,"width",1,8000),height=integer(canvas,"height",1,8000);
    if(int64_t(width)*height>64000000)throw std::invalid_argument("Replay canvas exceeds 64 million pixels");
    if(!canvas.contains("background")||!canvas["background"].is_array()||canvas["background"].size()!=3)throw std::invalid_argument("Replay canvas needs RGB background");
    for(const auto& c:canvas["background"])if(!c.is_number_integer()||c.get<int64_t>()<0||c.get<int64_t>()>255)throw std::invalid_argument("Invalid replay background RGB");
    selector(canvas.at("selector"));
    if(!canvas["selector"].contains("bounds")||canvas["selector"]["bounds"]["width"]!=width||canvas["selector"]["bounds"]["height"]!=height)
        throw std::invalid_argument("Replay canvas selector must prove the unscaled native canvas dimensions");
    const auto& strokes=recipe.at("strokes");
    if(!strokes.is_object()||strokes.empty()||strokes.size()>128)throw std::invalid_argument("Replay needs 1..128 named strokes");
    size_t pointCount=0;
    for(auto it=strokes.begin();it!=strokes.end();++it) {
        if(it.key().empty()||it.key().size()>128||!it.value().is_array()||it.value().size()<2||it.value().size()>4096)
            throw std::invalid_argument("Replay stroke needs a name and 2..4096 points");
        for(const auto& p:it.value())pair(p,width,height);
        pointCount+=it.value().size();
    }
    if(pointCount>100000)throw std::invalid_argument("Replay exceeds 100000 stored points");
    const auto& steps=recipe.at("steps");
    if(!steps.is_array()||steps.empty()||steps.size()>512)throw std::invalid_argument("Replay needs 1..512 steps");
    size_t drawCount=0;
    for(const auto& step:steps) {
        auto type=text(step,"type");text(step,"name");
        if(type=="click") {
            fields(step,{"type","name","selector","offset"});selector(step.at("selector"));
            if(step.contains("offset")) {
                const auto& bound=step["selector"].at("bounds");
                pair(step["offset"],bound.at("width"),bound.at("height"));
            }
        } else if(type=="wait") {
            fields(step,{"type","name","selector","timeoutMs"});selector(step.at("selector"));integer(step,"timeoutMs",1,10000);
        } else if(type=="ensure"||type=="assert") {
            fields(step,{"type","name","selector","value","color"});selector(step.at("selector"));
            if(step.contains("value")==step.contains("color"))throw std::invalid_argument("Replay assertion needs exactly one of value/color");
            if(type=="ensure"&&(!step.contains("value")||!step["value"].is_number_integer()||(step["value"]!=0&&step["value"]!=1)))
                throw std::invalid_argument("Replay ensure supports binary controls only");
            if(step.contains("value")&&!(step["value"].is_string()||step["value"].is_boolean()||step["value"].is_number_integer()))
                throw std::invalid_argument("Invalid replay expected control value");
            if(step.contains("color")) {
                if(!step["color"].is_array()||step["color"].size()!=4)throw std::invalid_argument("Replay assertion needs four RGBA components");
                for(const auto& c:step["color"])if(!c.is_number()||!std::isfinite(c.get<double>())||c.get<double>()<0||c.get<double>()>1)throw std::invalid_argument("Invalid replay RGBA");
            }
        } else if(type=="keys") {
            fields(step,{"type","name","chord"});normalize_key_chord(text(step,"chord"));
        } else if(type=="draw") {
            fields(step,{"type","name","strokes"});
            if(!step.at("strokes").is_array()||step["strokes"].empty()||step["strokes"].size()>256)throw std::invalid_argument("Invalid replay drawing group");
            for(const auto& id:step["strokes"]) {
                if(!id.is_string()||!strokes.contains(id.get<std::string>()))throw std::invalid_argument("Unknown replay stroke");
                if(++drawCount>512)throw std::invalid_argument("Replay exceeds 512 dispatched strokes");
            }
        } else throw std::invalid_argument("Unknown replay step type: "+type);
    }
    return {{"status","ok"},{"schemaVersion",1},{"name",recipe.at("name")},{"platform","macos"},
        {"steps",steps.size()},{"strokes",strokes.size()},{"drawnStrokes",drawCount},{"storedPoints",pointCount},
        {"coordinateSpace","canvas_relative_native_units"},{"desktopInputSent",false}};
}
Json run_replay(const Json& recipe,const std::string& window_id,const ReplayCall& call,const ReplayProgress& progress,size_t start_step,size_t stop_after) {
    validate_replay(recipe);
    if(window_id.empty())throw std::invalid_argument("Replay needs a freshly discovered window_id");
    const auto total=recipe["steps"].size();
    if(start_step>total||(stop_after&&(stop_after<=start_step||stop_after>total)))throw std::invalid_argument("Invalid replay cursor or stop boundary");
    size_t strokes=0;for(size_t i=0;i<start_step;++i)if(recipe["steps"][i]["type"]=="draw")strokes+=recipe["steps"][i]["strokes"].size();
    Json report={{"status","ok"},{"completedSteps",0},{"completedStrokes",0},{"steps",Json::array()},
        {"verification","business_result_not_verified"},{"automaticRetry",false}};
    report["completedSteps"]=start_step;report["completedStrokes"]=strokes;report["startedAtStep"]=start_step;
    size_t index=start_step;bool attempted=false;
    try {
        auto readState=[&](const std::string& mode) {
            Json state;
            for(int attempt=0;attempt<3;++attempt) {
                state=call("get_window_state",{{"window_id",window_id},{"mode",mode}});
                // New documents/toolbars can finish laying out during a read.
                // Retry only this explicit observation race, never input or a
                // provider timeout, paused request, or invalidated reference.
                if(state.value("code",std::string{})=="geometry_changed"&&!state.value("referencesInvalidated",false)&&
                   !state.value("paused",false)&&attempt<2) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));continue;
                }
                if(operation_failed(state))throw state;
                if(state.value("status",std::string{})!="ok")throw std::runtime_error("Replay received an invalid observation");
                return state;
            }
            return state;
        };
        auto observe=[&]() {
            auto state=readState("controls");
            if(state.at("coordinateSpace")!="window_relative_points")throw std::runtime_error("replay_coordinate_space_mismatch");
            return state;
        };
        auto verifyBatch=[&](const Json& outcome,size_t count) {
            if(operation_failed(outcome))throw outcome;
            if(outcome.value("status",std::string{})!="ok"||!outcome.contains("completed")||
               !outcome["completed"].is_number_integer()||outcome["completed"].get<int64_t>()!=int64_t(count))
                throw std::runtime_error("Replay batch did not confirm all requested actions");
        };
        auto batch=[&](const Json& actions) {
            attempted=true;auto outcome=call("execute_batch",{{"window_id",window_id},{"actions",actions}});
            verifyBatch(outcome,actions.size());return outcome;
        };
        while(index<total&&(!stop_after||index<stop_after)) {
            const auto& step=recipe["steps"][index];
            const auto type=step.at("type").get<std::string>();attempted=false;auto state=observe();Json outcome={{"status","ok"}};
            // Check the canvas before every stroke group, using the current layout.
            if(type=="wait") {
                const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(step["timeoutMs"].get<int>());
                for(;;) {
                    try{locate(state,step["selector"]);break;}
                    catch(const std::runtime_error& e) {
                        if(std::string(e.what()).rfind("replay_locator_missing:",0)!=0||std::chrono::steady_clock::now()>=deadline)throw;
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));state=observe();
                }
            } else if(type=="draw") {
                auto canvas=locate(state,recipe["canvas"]["selector"]);const auto& bounds=canvas.at("bounds");
                Json actions=Json::array();
                for(const auto& id:step["strokes"]) {
                    Json points=Json::array();
                    for(const auto& p:recipe["strokes"][id.get<std::string>()])
                        points.push_back({p[0].get<int>()+bounds[0].get<int>(),p[1].get<int>()+bounds[1].get<int>()});
                    actions.push_back({{"type","move"},{"hold","left"},{"points",points}});
                }
                attempted=true;outcome=call("execute_batch",{{"window_id",window_id},{"actions",actions}});
                if(outcome.contains("completed")&&outcome["completed"].is_number_integer()) {
                    auto count=outcome["completed"].get<int64_t>();
                    if(count>=0&&count<=int64_t(actions.size()))report["completedStrokes"]=report["completedStrokes"].get<size_t>()+size_t(count);
                }
                verifyBatch(outcome,actions.size());
            } else if(type=="keys")outcome=batch(Json::array({Json{{"type","press_keys"},{"chord",step["chord"]}}}));
            else {
                auto control=locate(state,step.at("selector"));
                if(type=="assert") {
                    if(!expected(control,step))throw std::runtime_error("replay_assertion_failed: "+step["name"].get<std::string>()+" actual="+dump_json(control.value("value",Json())));
                } else if(type=="click"||!expected(control,step)) {
                    Json action={{"type","click"},{"control_id",control.at("control_id")}};
                    if(step.contains("offset")) {
                        const auto& b=control.at("bounds");pair(step["offset"],b[2],b[3]);
                        action.erase("control_id");action["point"]={{"x",b[0].get<int>()+step["offset"][0].get<int>()},{"y",b[1].get<int>()+step["offset"][1].get<int>()}};
                    }
                    outcome=batch(Json::array({action}));
                    if(type=="ensure"&&!expected(locate(observe(),step["selector"]),step))throw std::runtime_error("replay_ensure_failed: "+step["name"].get<std::string>());
                }
            }
            report["steps"].push_back({{"index",index},{"name",step.at("name")},{"status","ok"}});
            report["completedSteps"]=++index;if(progress)progress(report);
        }
        report["finalState"]=readState("both");
        if(!report["finalState"].contains("capture")||!report["finalState"]["capture"].is_object())
            throw std::runtime_error("Replay final observation did not include a screenshot");
        report["complete"]=index==total;
        if(index<total){report["paused"]=true;report["pauseReason"]="requested_checkpoint";}
        return report;
    } catch(const Json& error) {
        report["error"]=error;
        report["dispatch"]=error.value("dispatch",std::string("unknown"));
        if(error.value("paused",false)){report["paused"]=true;report["resumeRequiresObservation"]=true;}
    } catch(const std::exception& error) {
        report["error"]={{"message",error.what()}};report["dispatch"]=attempted?"unknown":"not_started";
    }
    report["phase"]=index==recipe.at("steps").size()?"final_observation":"step";
    report["status"]="error";report["failedStep"]=index;
    report["next"]="Inspect the fresh replay document and report. No action is automatically retried and completed strokes are not replayed.";
    if(progress)progress(report);return report;
}
}
