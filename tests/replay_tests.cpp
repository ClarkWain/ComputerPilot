#include <desktop_pilot/replay.hpp>
#include <iostream>
#include <fstream>
#include <stdexcept>
using namespace dp;
int main(int argc,char** argv) {
    int checks=0;
    auto require=[&](bool yes,const char* reason){++checks;if(!yes)throw std::runtime_error(reason);};
    try {
        if(argc!=2)throw std::runtime_error("Expected replay example path");
        std::ifstream source(argv[1]);auto example=Json::parse(source);auto summary=validate_replay(example);
        require(summary["strokes"]==12&&summary["drawnStrokes"]==12,"flower recipe lost or repeated a stroke");
        Json recipe={{"schemaVersion",1},{"name","Replay tests"},{"platform","macos"},
            {"application",{{"bundleId","com.apple.Preview"},{"executable","Preview"}}},
            {"canvas",{{"width",100},{"height",80},{"background",{255,255,255}},
                {"selector",{{"role","AXImage"},{"bounds",{{"width",100},{"height",80}}}}}}},
            {"strokes",{{"one",{{0,0},{99,79}}},{"two",{{10,20},{30,40}}}}},
            {"steps",Json::array({
                Json{{"name","Enable drawing"},{"type","ensure"},{"selector",{{"name","Draw"},{"role","CheckBox"}}},{"value",1}},
                Json{{"name","Check color"},{"type","assert"},{"selector",{{"name","Color"},{"role","AXColorWell"}}},{"color",{0.4,0.6,0.2,1}}},
                Json{{"name","Draw two"},{"type","draw"},{"strokes",{"one","two"}}},
                Json{{"name","Save"},{"type","keys"},{"chord","Cmd+S"}}})}};
        int reads=0,writes=0,geometryRaces=0;bool enabled=false,ambiguous=false,paused=false,wrongCanvas=false,transportThrows=false,wrongColor=false,incompleteBatch=false;
        Json last;std::string currentId;
        auto call=[&](const std::string& tool,const Json& args)->Json {
            if(tool=="get_window_state") {
                if(geometryRaces>0){--geometryRaces;return {{"status","error"},{"code","geometry_changed"},{"dispatch","not_started"}};}
                ++reads;currentId="draw-"+std::to_string(reads);
                Json controls=Json::array({
                    Json{{"control_id",currentId},{"name","Draw"},{"role","CheckBox"},{"value",enabled?1:0},{"bounds",{0,0,20,20}}},
                    Json{{"control_id","canvas"},{"name",""},{"role","AXImage"},{"bounds",{25,110,wrongCanvas?101:100,80}}},
                    Json{{"control_id","color"},{"name","Color"},{"role","AXColorWell"},{"value",wrongColor?"rgb 0 0 0 1":"rgb 0.401 0.6 0.2 1"}}});
                if(ambiguous)controls.push_back(controls[0]);
                Json state={{"status","ok"},{"coordinateSpace","window_relative_points"},{"controls",controls}};
                if(args.value("mode",std::string{})=="both")state["capture"]={{"path","unused.png"}};
                return state;
            }
            require(tool=="execute_batch","replay invented a public tool");++writes;last=args;
            if(transportThrows)throw std::runtime_error("transport failed after dispatch");
            auto first=args.at("actions")[0];
            if(first["type"]=="click") {
                require(first["control_id"]==currentId,"replay reused an old control id");enabled=true;
            }
            if(paused&&first["type"]=="move")return {{"status","error"},{"code","desktop_locked"},{"paused",true},{"dispatch","dispatched"},{"completed",1}};
            return {{"status","ok"},{"completed",incompleteBatch?size_t(0):args.at("actions").size()}};
        };
        Json progress;
        auto result=run_replay(recipe,"new-window",call,[&](const Json& r){progress=r;});
        require(result["status"]=="ok"&&result["completedStrokes"]==2&&writes==3,"successful replay did not complete exactly once");
        require(progress["completedSteps"]==4,"replay progress did not record completed steps");
        enabled=true;writes=0;
        auto drawingOnly=recipe;drawingOnly["steps"]=Json::array({recipe["steps"][2]});
        result=run_replay(drawingOnly,"fresh-window",call);
        require(writes==1&&last["window_id"]=="fresh-window","replay reused recorded window id");
        require(last["actions"][0]["points"]==Json({{25,110},{124,189}}),"canvas points did not follow current canvas origin");
        auto invalid=[&](Json bad){int calls=0;bool rejected=false;try{run_replay(bad,"x",[&](const std::string&,const Json&){++calls;return Json::object();});}catch(...){rejected=true;}require(rejected&&calls==0,"invalid late replay step dispatched early input");};
        auto bad=recipe;bad["strokes"]["two"][1][0]=100;invalid(bad);
        bad=recipe;bad["steps"][3]["chord"]="Cmd+INVALID";invalid(bad);
        bad=recipe;bad["steps"][0]["control_id"]="old-control";invalid(bad);
        bad=recipe;bad["window_id"]="old-window";invalid(bad);
        bad=recipe;bad["strokes"]["one"]=Json::array({Json::array({1,2})});invalid(bad);
        bad=recipe;bad["steps"][2]["strokes"]={"missing"};invalid(bad);
        bad=recipe;bad["canvas"]["selector"]["bounds"]["width"]=99;invalid(bad);
        bad=recipe;bad["steps"][0]["type"]="shell";invalid(bad);
        bad=recipe;bad["application"]["bundleId"]="com.apple.Preview;whoami";invalid(bad);
        bad=recipe;bad["steps"][1]["color"][0]=2;invalid(bad);
        reads=0;writes=0;ambiguous=true;result=run_replay(recipe,"x",call);ambiguous=false;
        require(result["status"]=="error"&&writes==0,"ambiguous control was clicked");
        reads=0;writes=0;paused=true;result=run_replay(recipe,"x",call);paused=false;
        require(result["status"]=="error"&&result["paused"]==true&&result["completedStrokes"]==1&&result["failedStep"]==2&&writes==1,"partial paused group was replayed or followed by Save");
        writes=0;wrongCanvas=true;result=run_replay(drawingOnly,"x",call);wrongCanvas=false;
        require(result["status"]=="error"&&writes==0,"changed canvas geometry dispatched drawing");
        writes=0;wrongColor=true;result=run_replay(recipe,"x",call);wrongColor=false;
        require(result["status"]=="error"&&writes==0&&result["failedStep"]==1,"wrong color did not stop before painting");
        writes=0;transportThrows=true;result=run_replay(drawingOnly,"x",call);transportThrows=false;
        require(result["status"]=="error"&&result["dispatch"]=="unknown"&&writes==1,"transport failure was treated as safely retryable");
        writes=0;incompleteBatch=true;result=run_replay(drawingOnly,"x",call);incompleteBatch=false;
        require(result["status"]=="error"&&result["completedSteps"]==0&&result["dispatch"]=="unknown"&&writes==1,"incomplete successful response was treated as a finished replay");
        writes=0;geometryRaces=2;result=run_replay(drawingOnly,"x",call);
        require(result["status"]=="ok"&&writes==1&&geometryRaces==0,"bounded geometry re-observation replayed input");
        writes=0;geometryRaces=3;result=run_replay(drawingOnly,"x",call);
        require(result["status"]=="error"&&writes==0,"persistent geometry race dispatched input");
        auto waiting=recipe;waiting["steps"]=Json::array({Json{{"name","Wait for palette"},{"type","wait"},{"selector",{{"name","Draw"},{"role","CheckBox"}}},{"timeoutMs",500}}});
        writes=0;int waits=0;
        result=run_replay(waiting,"x",[&](const std::string& tool,const Json& args) {
            auto state=call(tool,args);
            if(tool=="get_window_state"&&++waits==1)state["controls"]=Json::array();
            return state;
        });
        require(result["status"]=="ok"&&waits==3&&writes==0,"wait sent input instead of waiting for fresh controls");
        bad=waiting;bad["steps"][0]["timeoutMs"]=10001;invalid(bad);
        std::cout<<"PASS replay checks="<<checks<<'\n';return 0;
    } catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
