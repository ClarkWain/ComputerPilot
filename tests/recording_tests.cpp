#include <desktop_pilot/recording.hpp>
#include <desktop_pilot/platform.hpp>
#include <iostream>
#include <chrono>
#include <fstream>
using namespace dp;
int main(int argc,char** argv) {
    auto root=std::filesystem::temp_directory_path()/("dp-recording-tests-"+std::to_string(process_id())+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup{std::filesystem::path path;~Cleanup(){std::error_code error;std::filesystem::remove_all(path,error);}}cleanup{root};
    int checks=0;auto require=[&](bool yes,const char* why){++checks;if(!yes)throw std::runtime_error(why);};
    try {
        if(argc!=2)throw std::runtime_error("Expected flower template");
        std::ifstream file(argv[1]);auto model=Json::parse(file);
        auto identity=[](std::string title="source.png"){return Json{{"windowRef","old-window"},{"title",title},{"executable","Preview"},{"bundleIdentifier","com.apple.Preview"},
            {"desktopContext",{{"ready",true},{"generation",1}}}};};
        auto observation=[](bool enabled,bool image=false) {
            Json state={{"status","ok"},{"window_id","old-window"},{"coordinateSpace",image?"image_pixels":"window_relative_points"},
                {"size",{{"width",1100},{"height",950}}},{"controls",Json::array({
                    Json{{"control_id","old-draw"},{"role","CheckBox"},{"name","Draw"},{"value",enabled?1:0},{"bounds",{10,50,30,20}}},
                    Json{{"control_id","old-canvas"},{"role","AXImage"},{"name",""},{"bounds",{25,110,1000,800}}},
                    Json{{"control_id","old-color"},{"role","AXColorWell"},{"name","Color"},{"value","rgb 0.4 0.6 0.2 1"},{"bounds",{60,50,25,20}}},
                    Json{{"control_id","old-markup"},{"role","CheckBox"},{"name","Markup"},{"value",1},{"bounds",{100,10,25,20}}}})}};
            if(image)state["capture"]={{"path","unused.png"},{"width",1600},{"height",1280},{"bounds",{{"x",100},{"y",200},{"width",1000},{"height",800}}},{"windowBounds",{{"x",75},{"y",90}}}};
            return state;
        };
        const Json move={{"type","move"},{"hold","left"},{"points",{{125,210},{225,310}}}};
        auto make=[&](const std::string& name,const std::string& variant)->std::filesystem::path {
            ActionRecording recording(root/name);bool enabled=false;
            auto call=[&](const std::string& tool,const Json& args,const Json& result) {
                return recording.call(tool,args,[&](const std::string&,const Json&){recording.observe_window("window.get",identity());return result;});
            };
            auto read=[&](bool image=false){call("get_window_state",{{"window_id","old-window"},{"mode",image?"both":"controls"}},observation(enabled,image));};
            auto batch=[&](Json actions,bool partial=false){call("execute_batch",{{"window_id","old-window"},{"actions",actions}},partial?Json{{"status","error"},{"dispatch","unknown"},{"completed",0}}:Json{{"status","ok"},{"completed",actions.size()}});};
            read();batch(Json::array({Json{{"type","click"},{"control_id","old-draw"}}}));enabled=true;read(variant=="crop");
            if(variant=="semantic")call("execute_semantic",{{"window_id","old-window"}},{{"status","ok"}});
            else if(variant=="unsupported")batch(Json::array({Json{{"type","type_text"},{"text","private input"}}}));
            else {
                auto stroke=move;if(variant=="crop")stroke["points"]={{160,160},{320,320}};
                if(variant=="outside")stroke["points"]={{1,1},{2,2}};
                batch(Json::array({stroke}),variant=="partial");
                if(variant!="stale")read();
                batch(Json::array({Json{{"type","press_keys"},{"chord","Cmd+S"}}}));
            }
            if(variant!="no-final")read();
            recording.finish();return recording.path();
        };
        auto good=make("good","ok");auto exported=export_recording(good,model);
        require(exported["strokes"].size()==1&&exported["strokes"]["stroke-1"]==Json({{100,100},{200,200}}),"recorded stroke was not anchored to canvas");
        auto encoded=exported.dump();require(encoded.find("old-")==std::string::npos,"export leaked session references");
        require(exported["steps"][1]["type"]=="ensure"&&exported["steps"][1]["value"]==1,"recorded checkbox was exported as a blind toggle");
        require(exported["steps"][1]["selector"]["name"]=="Markup","initially enabled toolbar was not reconstructed");
        require(exported["strokes"].size()!=model["strokes"].size(),"export copied template strokes rather than real inputs");
        int writes=0;bool drawing=false;Json finalAction;
        auto replay=run_replay(exported,"fresh-window",[&](const std::string& tool,const Json& args)->Json {
            if(tool=="get_window_state") {
                auto state=observation(drawing);state["window_id"]="fresh-window";state["controls"][0]["control_id"]="fresh-draw";state["controls"][1]["bounds"]={40,140,1000,800};
                state["capture"]={{"path","unused.png"}};return state;
            }
            ++writes;const auto& action=args["actions"][0];
            if(action["type"]=="click"){require(action["control_id"]=="fresh-draw","replay used recorded control id");drawing=true;}
            if(action["type"]=="move")finalAction=action;
            return {{"status","ok"},{"completed",args["actions"].size()}};
        });
        require(replay["status"]=="ok"&&writes==3&&finalAction["points"]==Json({{140,240},{240,340}}),"record/export/replay round trip did not rebase to current canvas");
        auto crop=export_recording(make("crop","crop"),model);
        require(crop["strokes"]==exported["strokes"],"Retina crop mapping differed from public API");
        auto rejected=[&](const std::filesystem::path& path){bool rejected=false;try{export_recording(path,model);}catch(...){rejected=true;}require(rejected,"unsafe recording exported a playable recipe");};
        for(const auto variant:{"partial","stale","unsupported","semantic","outside","no-final"})rejected(make(variant,variant));
        auto missingEnd=root/"missing-end.jsonl";
        {std::ifstream input(good);std::ofstream output(missingEnd);std::string line;while(std::getline(input,line))if(Json::parse(line)["event"]!="end")output<<line<<'\n';}rejected(missingEnd);
        auto switched=root/"switched.jsonl";
        {std::ifstream input(good);std::ofstream output(switched);std::string line;bool changed=false;while(std::getline(input,line)){auto event=Json::parse(line);if(!changed&&event.value("event",std::string{})=="result"&&event.contains("window")){event["window"]["bundleIdentifier"]="com.apple.Other";changed=true;}output<<event.dump()<<'\n';}}rejected(switched);
        bool overwrite=false;try{ActionRecording recording(root/"good");}catch(...){overwrite=true;}
        require(overwrite&&std::filesystem::file_size(good)>0,"recording overwrote existing output");
        {ActionRecording closed(root/"closed");closed.finish();int dispatched=0;bool refused=false;
            try{closed.call("execute_batch",Json::object(),[&](const std::string&,const Json&){++dispatched;return Json{{"status","ok"}};});}catch(...){refused=true;}
            require(refused&&dispatched==0,"closed journal allowed unrecorded input");}
        {ActionRecording limited(root/"limited");int dispatched=0;bool refused=false;
            try{limited.call("execute_batch",{{"text",std::string(8*1024*1024,'x')}},[&](const std::string&,const Json&){++dispatched;return Json{{"status","ok"}};});}catch(...){refused=true;}
            require(refused&&dispatched==0,"oversized journal request was dispatched before being recorded");}
        {ActionRecording limited(root/"post-dispatch-limit");int dispatched=0;
            auto result=limited.call("execute_batch",Json::object(),[&](const std::string&,const Json&){++dispatched;return Json{{"status","ok"},{"completed",1},{"padding",std::string(8*1024*1024,'x')}};});
            require(result["code"]=="recording_write_failed"&&result["completed"]==1&&result["recordedOutcome"]["status"]=="ok","post-dispatch log failure lost the real outcome");
            bool refused=false;try{limited.call("execute_batch",Json::object(),[&](const std::string&,const Json&){++dispatched;return Json{{"status","ok"}};});}catch(...){refused=true;}
            require(refused&&dispatched==1,"failed recording allowed another input");}
        auto crashed=root/"crashed";{ActionRecording recording(crashed);recording.call("get_window_state",{{"window_id","old-window"}},[](const std::string&,const Json&)->Json{throw std::runtime_error("transport failed");});}rejected(crashed/"session.jsonl");
        std::cout<<"PASS recording checks="<<checks<<'\n';return 0;
    } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
