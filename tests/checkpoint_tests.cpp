#include <desktop_pilot/checkpoint.hpp>
#include <desktop_pilot/platform.hpp>
#include <chrono>
#include <fstream>
#include <iostream>
using namespace dp;
int main(int argc,char** argv) {
    auto root=std::filesystem::temp_directory_path()/("dp-checkpoint-tests-"+std::to_string(process_id())+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    struct Cleanup{std::filesystem::path root;~Cleanup(){std::error_code error;std::filesystem::remove_all(root,error);}}cleanup{root};
    int checks=0;auto require=[&](bool value,const char* reason){++checks;if(!value)throw std::runtime_error(reason);};
    auto rejects=[&](auto operation,const char* reason){bool rejected=false;try{operation();}catch(...){rejected=true;}require(rejected,reason);};
    try {
        if(argc!=2)throw std::runtime_error("Expected flower recipe");std::ifstream input(argv[1]);const auto recipe=Json::parse(input);
        std::filesystem::create_directories(root/"checkpoints");write_json(root/"recipe.json",recipe);
        const auto document=root/"DesktopPilot-replay-owned.png",canvas=root/"checkpoints/canvas.png";
        save_png(Image{5,4,std::vector<uint8_t>(5*4*3,255)},document);std::filesystem::copy_file(document,canvas);
        Json state={{"controls",Json::array({
            Json{{"role","AXImage"},{"name",""},{"control_id","old-canvas"},{"bounds",{10,100,1000,800}}},
            Json{{"role","CheckBox"},{"name","Draw"},{"value",1},{"control_id","old-draw"},{"bounds",{10,30,25,20}}},
            Json{{"role","AXColorWell"},{"name","Color"},{"value","rgb 0.4 0.6 0.2 1"},{"bounds",{50,30,25,20}}}})}};
        const auto observed=replay_observable_state(state,recipe["canvas"]["selector"]);
        auto moved=state;for(auto& c:moved["controls"]){c["control_id"]="fresh";c["bounds"][0]=c["bounds"][0].get<int>()+20;}
        require(replay_observable_state(moved,recipe["canvas"]["selector"])==observed,"checkpoint retained transient IDs or absolute positions");
        moved["controls"][1]["value"]=0;require(replay_observable_state(moved,recipe["canvas"]["selector"])!=observed,"checkpoint ignored a tool state change");
        auto missing=state;missing["controls"].erase(0);rejects([&]{replay_observable_state(missing,recipe["canvas"]["selector"]);},"checkpoint accepted a missing canvas");
        Json checkpoint={{"schemaVersion",1},{"status","ready"},{"recipeSha256",file_sha256(root/"recipe.json")},{"document",document.filename().string()},
            {"documentSha256",file_sha256(document)},{"canvas","checkpoints/canvas.png"},{"canvasSha256",file_sha256(canvas)},
            {"observableState",observed},{"completedSteps",14},{"completedStrokes",3}};
        auto load=[&](const Json& value){write_checkpoint_atomic(root/"checkpoint.json",value);return load_replay_checkpoint(root);};
        require(load(checkpoint)["checkpoint"]["completedSteps"]==14,"valid checkpoint could not be loaded offline");
        for(const auto status:{"in_progress","complete"}){auto bad=checkpoint;bad["status"]=status;rejects([&]{load(bad);},"unknown/completed checkpoint was resumable");}
        auto bad=checkpoint;bad["completedSteps"]=15;rejects([&]{load(bad);},"checkpoint stopped inside a toolbar sequence");
        bad=checkpoint;bad["completedStrokes"]=4;rejects([&]{load(bad);},"checkpoint cursor and stroke count disagreed");
        bad=checkpoint;bad["completedSteps"]=-1;rejects([&]{load(bad);},"negative checkpoint cursor was accepted");
        bad=checkpoint;bad["completedSteps"]=999999;rejects([&]{load(bad);},"oversized checkpoint cursor was accepted");
        bad=checkpoint;bad["overrideCursor"]=20;rejects([&]{load(bad);},"unknown checkpoint field was ignored");
        bad=checkpoint;bad["canvas"]="../canvas.png";rejects([&]{load(bad);},"checkpoint could escape its run directory");
        bad=checkpoint;bad["documentSha256"]="changed";rejects([&]{load(bad);},"changed document was accepted");
        bad=checkpoint;bad["recipeSha256"]="changed";rejects([&]{load(bad);},"changed recipe was accepted");
        bad=checkpoint;bad["canvasSha256"]="changed";rejects([&]{load(bad);},"changed snapshot was accepted");
        Json window={{"executable","Preview"},{"bundleIdentifier","com.apple.Preview"},{"title",document.filename().string()},
            {"documentPath",utf8(document.wstring())},{"documentEdited",false}};
        verify_replay_document(window,recipe["application"],document,true);++checks;
        auto dirty=window;dirty["documentEdited"]=true;rejects([&]{verify_replay_document(dirty,recipe["application"],document,true);},"unsaved document passed resume identity checks");
        dirty=window;dirty.erase("documentEdited");rejects([&]{verify_replay_document(dirty,recipe["application"],document,true);},"unknown save state was considered saved");
        dirty=window;dirty["documentPath"]=utf8(canvas.wstring());rejects([&]{verify_replay_document(dirty,recipe["application"],document,true);},"same title at a different path was accepted");
        Json stopped={{"status","error"},{"phase","step"},{"dispatch","not_started"},{"completedSteps",14},{"completedStrokes",3}};
        require(replay_resume_not_started(stopped,14,3),"known not-started failure could not preserve checkpoint");
        stopped["dispatch"]="unknown";require(!replay_resume_not_started(stopped,14,3),"unknown input outcome rearmed checkpoint");
        stopped["dispatch"]="not_started";stopped["completedStrokes"]=4;require(!replay_resume_not_started(stopped,14,3),"partial stroke group rearmed checkpoint");
        stopped["completedStrokes"]=3;stopped["completedSteps"]=15;require(!replay_resume_not_started(stopped,14,3),"advanced run rearmed an obsolete checkpoint");
        load(checkpoint);size_t temporaries=0;for(const auto& entry:std::filesystem::directory_iterator(root))if(entry.path().filename().string().find(".tmp-")!=std::string::npos)++temporaries;
        require(temporaries==0,"atomic replacement left temporary descriptors");
        std::cout<<"PASS checkpoint checks="<<checks<<'\n';return 0;
    } catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
}
