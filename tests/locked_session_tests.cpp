#include <desktop_pilot/agent_api.hpp>
#include <desktop_pilot/preflight.hpp>
#include <desktop_pilot/service.hpp>
#include <iostream>
#include <stdexcept>
using namespace dp;

int main() {
    int checks=0;
    auto require=[&](bool yes,const char* reason){++checks;if(!yes)throw std::runtime_error(reason);};
    try {
        Json ready={{"platform","macos"},{"consoleSession",true},{"sameUserSession",true},{"lockState","unlocked"},
            {"secureInput",false},{"accessibilityTrusted",true},{"screenCaptureAllowed",true},{"postEventAllowed",true}};
        DesktopSessionTracker tracker;
        auto first=tracker.observe(ready);auto same=tracker.observe(ready);
        require(first["desktopGeneration"]==same["desktopGeneration"],"stable session changed generation");
        auto locked=ready;locked["lockState"]="locked";
        auto second=tracker.observe(locked);auto third=tracker.observe(ready);
        require(second["desktopGeneration"]!=first["desktopGeneration"]&&third["desktopGeneration"]!=first["desktopGeneration"],"lock/unlock must invalidate old observations");
        auto preflight=desktop_preflight(second);
        require(!preflight["ready"].get<bool>()&&preflight["executionMode"]=="background_only","locked session promoted to interactive");
        require(preflight["capabilities"]["lockedApplicationActions"].empty(),"unvalidated app actions advertised");
        for(auto op:{"system.info","system.session","system.preflight","runtime.capabilities","action.status","window.list","window.get","vision.parse","vision.ocr"})
            require(desktop_operation_access(op,preflight).empty(),"background operation blocked");
        for(auto op:{"input.click","input.key_chord","input.type_text","input.move","ui.fill","ui.click","ui.invoke","ui.tree","capture.window","clipboard.read","clipboard.write","semantic.execute","arbitrary.command"}) {
            auto result=desktop_operation_access(op,preflight);
            require(result["code"]=="desktop_locked"&&result["dispatch"]=="not_started"&&result["resumeRequiresObservation"]==true,"locked UI operation was not paused before dispatch");
        }
        auto missing=locked;missing.erase("lockState");
        require(desktop_operation_access("ui.fill",desktop_preflight(missing))["code"]=="desktop_environment_not_ready","unknown lock state permitted input");
        auto revoked=ready;revoked["accessibilityTrusted"]=false;
        auto changed=tracker.observe(revoked);require(changed["desktopGeneration"]!=third["desktopGeneration"],"permission change did not invalidate observation");

        AgentApi api;
        auto context=[](const Json& s){auto p=desktop_preflight(s);return Json{{"generation",s.at("desktopGeneration")},{"ready",p["ready"]},{"lockState",s["lockState"]},{"preflight",p}};};
        Json desktop=context(first);int writes=0,activations=0,trees=0,captures=0;
        bool lockAfterWrite=false,changeDuringCapture=false,pauseInProvider=false;
        Json lastArgs;
        auto dispatch=[&](const std::string& op,const Json& args)->Json {
            Json window={{"windowRef","w1"},{"pid",42},{"title","Test"},{"foreground",true},{"enabled",true},
                {"coordinateUnits","screen_points"},{"desktopContext",desktop},{"bounds",{{"x",10},{"y",20},{"width",200},{"height",100}}}};
            Json control={{"elementRef","e1"},{"name","Field"},{"role","Edit"},{"bounds",{{"x",20},{"y",40},{"width",80},{"height",20}}}};
            if(op=="window.list")return {{"windows",Json::array({window})},{"desktopContext",desktop}};
            if(op=="window.get")return window;
            if(op=="window.activate"){++activations;return window;}
            if(op=="semantic.profiles")return {{"status","ok"},{"profiles",Json::array()}};
            if(op=="ui.tree"){++trees;return {{"elements",Json::array({control})}};}
            if(op=="ui.get")return control;
            if(op=="capture.window") {
                ++captures;if(changeDuringCapture){desktop=context(tracker.observe(ready));changeDuringCapture=false;}
                return {{"imageRef","img"},{"path","unused.png"},{"bounds",window["bounds"]},{"width",200},{"height",100}};
            }
            require(args.contains("expectedDesktopGeneration"),"native mutation omitted observation generation");lastArgs=args;
            if(pauseInProvider) {
                pauseInProvider=false;desktop=context(tracker.observe(locked));
                auto result=desktop_operation_access(op,desktop["preflight"]);result["dispatch"]="dispatched";result["verification"]="unknown";return result;
            }
            ++writes;if(lockAfterWrite){lockAfterWrite=false;desktop=context(tracker.observe(locked));}
            return {{"status","ok"}};
        };
        auto list=[&]{return api.call("list_windows",Json::object(),dispatch);};
        auto observe=[&](const char* mode="controls"){return api.call("get_window_state",{{"window_id","w1"},{"mode",mode}},dispatch);};
        auto batch=[&](Json actions){return api.call("execute_batch",{{"window_id","w1"},{"actions",actions}},dispatch);};
        Json enter={{"type","press_keys"},{"chord","Enter"}};
        list();require(observe()["status"]=="ok","initial observation failed");
        lockAfterWrite=true;auto result=batch(Json::array({enter,enter}));
        require(result["paused"]==true&&result["completed"]==1&&result["failedIndex"]==1&&result["remaining"]==1&&writes==1,"lock between steps replayed or continued input");
        require(result["failedActionOutcome"]=="not_started","untouched step reported as unknown");
        desktop=context(tracker.observe(ready));
        require(batch(Json::array({enter}))["code"]=="state_required"&&writes==1,"unlock reused consumed observation");
        require(observe()["status"]=="ok","fresh observation after unlock failed");
        require(batch(Json::array({enter}))["completed"]==1&&writes==2,"unfinished step did not resume exactly once");

        observe();tracker.observe(locked);desktop=context(tracker.observe(ready));
        result=batch(Json::array({enter}));require(result["code"]=="observation_required"&&result["completed"]==0&&writes==2,"unseen lock/unlock reused old geometry");
        observe();pauseInProvider=true;result=batch(Json::array({enter,enter}));
        require(result["paused"]==true&&result["completed"]==0&&result["failedActionOutcome"]=="inspect_required"&&writes==2,"partial native operation was treated as safely replayable");
        auto beforeTrees=trees,beforeCaptures=captures;
        require(list()["desktopContext"]["ready"]==false,"locked diagnostics unavailable");
        result=api.call("get_window_state",{{"window_id","w1"},{"activate",false},{"mode","both"}},dispatch);
        require(result["paused"]==true&&trees==beforeTrees&&captures==beforeCaptures&&activations==0,"locked observation scanned UI or captured desktop");

        desktop=context(tracker.observe(ready));observe();
        result=batch(Json::array({Json{{"type","fill_text"},{"control_id","e1"},{"text","new"}}}));
        require(result["completed"]==1&&lastArgs["expectedDesktopGeneration"]==desktop["generation"],"control mutation lost generation guard");
        // Transition during a screenshot must not produce a usable observation.
        tracker.observe(locked);desktop=context(tracker.observe(locked));changeDuringCapture=true;
        desktop=context(tracker.observe(ready));
        // Give the callback a genuinely different ready generation.
        auto transitionDispatch=[&](const std::string& op,const Json& args)->Json {
            if(op=="capture.window"){tracker.observe(locked);}
            return dispatch(op,args);
        };
        result=api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},transitionDispatch);
        require(result["code"]=="observation_required","observation spanning lock/unlock was retained");
        require(batch(Json::array({enter}))["code"]=="state_required","transitioning capture allowed later input");
        std::cout<<"PASS locked session checks="<<checks<<'\n';return 0;
    } catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
