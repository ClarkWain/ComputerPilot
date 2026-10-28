#include <desktop_pilot/replay.hpp>
#include <desktop_pilot/recording.hpp>
#include <desktop_pilot/checkpoint.hpp>
#include <desktop_pilot/agent_api.hpp>
#include <desktop_pilot/worker.hpp>
#include <desktop_pilot/service.hpp>
#include <desktop_pilot/platform.hpp>
#include <chrono>
#include <fstream>
#include <iostream>
#include <thread>
#ifdef __APPLE__
#include <spawn.h>
#include <sys/wait.h>
#include <cerrno>
extern char** environ;
#endif

namespace dp {
namespace {
Json read_recipe(const std::filesystem::path& path) {
    if(std::filesystem::file_size(path)>8*1024*1024)throw std::invalid_argument("Replay file exceeds 8 MiB");
    std::ifstream input(path,std::ios::binary);if(!input)throw std::runtime_error("Cannot open replay file");return Json::parse(input);
}
void open_document(const std::string& bundle,const std::filesystem::path& path) {
#ifdef __APPLE__
    std::string program="/usr/bin/open",option="-b",document=path.string(),application=bundle;
    char* argv[]={program.data(),option.data(),application.data(),document.data(),nullptr};pid_t pid=-1;
    int error=posix_spawn(&pid,program.c_str(),nullptr,nullptr,argv,environ);
    if(error)throw std::runtime_error("Replay launch failed: "+std::to_string(error));
    int status=0;pid_t waited;
    do {waited=waitpid(pid,&status,0);}while(waited<0&&errno==EINTR);
    if(waited<0||!WIFEXITED(status)||WEXITSTATUS(status)!=0)throw std::runtime_error("Replay document launcher failed");
#else
    (void)bundle;(void)path;throw std::runtime_error("macOS replay requires a macOS executor");
#endif
}
std::filesystem::path decoded_path(const std::string& value){return std::filesystem::path(std::u8string(value.begin(),value.end()));}
std::string ticket(){return std::to_string(process_id())+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());}
void require_success(const Json& result) {
    if(operation_failed(result)||result.value("status",std::string{})!="ok")throw std::runtime_error("Replay desktop operation failed: "+dump_json(result));
}
struct RunLock {
    std::filesystem::path path;
    explicit RunLock(const std::filesystem::path& root):path(root/".replay-active") {
        if(!std::filesystem::create_directory(path))throw std::runtime_error("Replay run is active or an unclean exit left its lock; no input sent");
    }
    ~RunLock(){std::error_code error;std::filesystem::remove(path,error);}
};
class ReplayDesktop {
public:
    Worker& worker;Json application,metadata;std::filesystem::path document;AgentApi api;std::string target;
    ActionRecording* recording=nullptr;bool strict_document=false;
    ReplayDesktop(Worker& w,const Json& app,const std::filesystem::path& file,ActionRecording* record=nullptr):worker(w),application(app),document(file),recording(record){}
    Json call(const std::string& tool,const Json& args) {
        auto dispatch=[&](const std::string& operation,const Json& parameters) {
            auto result=worker.execute(operation,parameters);
            if(recording)recording->observe_window(operation,result);
            if(operation=="window.get"&&!operation_failed(result)&&!target.empty()) {
                metadata=result;
                if(result.value("executable",std::string{})!=application["executable"].get<std::string>()||result.value("title",std::string{})!=document.filename().string())
                    return Json{{"status","error"},{"code","replay_target_changed"},{"dispatch","not_started"},{"message","Replay document identity changed"}};
                if(strict_document)try{verify_replay_document(result,application,document,false);}
                    catch(const std::exception& error){return Json{{"status","error"},{"code","replay_target_changed"},{"dispatch","not_started"},{"message",error.what()}};}
            }
            return result;
        };
        auto invoke=[&](const std::string& name,const Json& arguments){return api.call(name,arguments,dispatch);};
        return recording?recording->call(tool,args,invoke):invoke(tool,args);
    }
    void discover(bool wait) {
        for(int attempt=0;attempt<(wait?150:1);++attempt) {
            auto listing=call("list_windows",Json::object());require_success(listing);Json matches=Json::array();
            for(const auto& window:listing.at("windows"))if(window.at("title")==document.filename().string())matches.push_back(window);
            if(matches.size()>1)throw std::runtime_error("Replay document identity is ambiguous");
            if(matches.size()==1){target=matches[0]["window_id"];break;}
            if(wait)std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        if(target.empty())throw std::runtime_error("Original replay document is not open; it was not relaunched");
    }
    Json observe(bool activate=true) {
        return call("get_window_state",{{"window_id",target},{"mode","controls"},{"activate",activate}});
    }
    void await_ready() {
        Json state;
        for(int attempt=0;attempt<150;++attempt) {
            state=observe(false);
            if(!operation_failed(state)&&state.contains("controls")&&!state["controls"].empty())return;
            if(state.value("paused",false)||state.value("referencesInvalidated",false)||state.value("code",std::string{})=="replay_target_changed")break;
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        throw std::runtime_error("Replay Accessibility did not become ready: "+dump_json(state));
    }
    Json canvas_view(const Json& recipe) {
        auto state=observe();require_success(state);replay_observable_state(state,recipe["canvas"]["selector"]);
        Json bounds;
        for(const auto& c:state["controls"])if(c.value("enabled",true)&&!c.value("offscreen",false)&&c.value("role",std::string{})==recipe["canvas"]["selector"]["role"].get<std::string>()&&
            c["bounds"][2]==recipe["canvas"]["width"]&&c["bounds"][3]==recipe["canvas"]["height"]&&
            (!recipe["canvas"]["selector"].contains("name")||c.value("name",std::string{})==recipe["canvas"]["selector"]["name"].get<std::string>()))bounds=c["bounds"];
        auto view=call("get_window_state",{{"window_id",target},{"mode","both"},
            {"region",{{"x",bounds[0]},{"y",bounds[1]},{"width",bounds[2]},{"height",bounds[3]}}}});require_success(view);
        replay_observable_state(view,recipe["canvas"]["selector"]);return view;
    }
};
Json save_checkpoint(ReplayDesktop& desktop,const Json& recipe,const Json& result,const std::filesystem::path& root) {
    auto state=desktop.observe();require_success(state);verify_replay_document(desktop.metadata,recipe["application"],desktop.document,false);
    const auto before=replay_observable_state(state,recipe["canvas"]["selector"]);
    auto saved=desktop.call("execute_batch",{{"window_id",desktop.target},{"actions",Json::array({Json{{"type","press_keys"},{"chord","Cmd+S"}}})}});
    require_success(saved);if(saved.value("completed",size_t(0))!=1)throw std::runtime_error("Checkpoint save outcome is unknown");
    bool clean=false;std::string previous;int stable=0;
    for(int attempt=0;attempt<50;++attempt) {
        state=desktop.observe();require_success(state);
        if(desktop.metadata.contains("documentEdited")&&desktop.metadata["documentEdited"].is_boolean()&&!desktop.metadata["documentEdited"].get<bool>()) {
            const auto hash=file_sha256(desktop.document);stable=hash==previous?stable+1:0;previous=hash;
            if(stable>=2){clean=true;break;}
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if(!clean)throw std::runtime_error("Checkpoint document did not confirm a completed save");
    auto view=desktop.canvas_view(recipe);verify_replay_document(desktop.metadata,recipe["application"],desktop.document,true);
    if(before!=replay_observable_state(view,recipe["canvas"]["selector"]))throw std::runtime_error("Saving changed observable tool state; checkpoint is not ready");
    if(file_sha256(desktop.document)!=previous)throw std::runtime_error("Document changed while creating checkpoint");
    const auto folder=root/"checkpoints";std::filesystem::create_directories(folder);
    const auto relative=std::filesystem::path("checkpoints")/(ticket()+"-canvas.png");
    save_png(load_image(decoded_path(view["capture"]["path"].get<std::string>())),root/relative);
    Json checkpoint={{"schemaVersion",1},{"status","ready"},{"recipeSha256",file_sha256(root/"recipe.json")},
        {"document",desktop.document.filename().string()},{"documentSha256",previous},{"canvas",relative.generic_string()},
        {"canvasSha256",file_sha256(root/relative)},{"observableState",replay_observable_state(view,recipe["canvas"]["selector"])},
        {"completedSteps",result.at("completedSteps")},{"completedStrokes",result.at("completedStrokes")}};
    write_checkpoint_atomic(root/"checkpoint.json",checkpoint);return checkpoint;
}
void verify_checkpoint_view(ReplayDesktop& desktop,const Json& recipe,const Json& loaded) {
    auto view=desktop.canvas_view(recipe);const auto& checkpoint=loaded.at("checkpoint");
    verify_replay_document(desktop.metadata,recipe["application"],desktop.document,true);
    if(replay_observable_state(view,recipe["canvas"]["selector"])!=checkpoint.at("observableState"))throw std::runtime_error("Observable tool state differs from checkpoint");
    const auto old=load_image(decoded_path(loaded.at("canvas").get<std::string>())),current=load_image(decoded_path(view["capture"]["path"].get<std::string>()));
    if(old.width!=current.width||old.height!=current.height||old.rgb!=current.rgb)throw std::runtime_error("Visible canvas differs from checkpoint; no replay input sent");
    if(file_sha256(desktop.document)!=checkpoint.at("documentSha256").get<std::string>())throw std::runtime_error("Document changed since checkpoint");
}
}
int replay_cli(const std::filesystem::path& file,const std::filesystem::path& output,bool execute,const std::filesystem::path& recording_directory,size_t stop_after) {
    auto recipe=read_recipe(file);auto summary=validate_replay(recipe);
    validate_replay_stop(recipe,stop_after);
    if(!execute){summary["mode"]="validate";std::cout<<dump_json(summary,2)<<'\n';return 0;}
#ifndef __APPLE__
    throw std::runtime_error("macOS replay requires a macOS executor; validation is available here");
#endif
    if(output.empty())throw std::invalid_argument("Replay execution requires --output NEW_DIRECTORY");
    auto destination=std::filesystem::weakly_canonical(std::filesystem::absolute(output));
    if(std::filesystem::exists(destination))throw std::invalid_argument("Replay output directory already exists; use a new directory");
    if(!recording_directory.empty()) {
        auto recordPath=std::filesystem::weakly_canonical(std::filesystem::absolute(recording_directory));
        if(std::filesystem::exists(recordPath)||recordPath==destination||recordPath.string().starts_with(destination.string()+std::string(1,std::filesystem::path::preferred_separator))||destination.string().starts_with(recordPath.string()+std::string(1,std::filesystem::path::preferred_separator)))
            throw std::invalid_argument("Recording and replay outputs must be separate new directories");
    }
    Worker worker;auto environment=worker.execute("system.preflight",Json::object());
    if(!environment.value("ready",false)) {
        std::cout<<dump_json(Json{{"status","error"},{"code","desktop_environment_not_ready"},{"dispatch","not_started"},{"preflight",environment}},2)<<'\n';return 3;
    }
    // Every execution owns a new directory and uniquely named document. Existing
    // user windows and the recipe's reference artwork are never selected by title.
    if(!std::filesystem::create_directories(destination))throw std::invalid_argument("Replay output directory was created concurrently");
    const auto ticket=std::to_string(process_id())+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    const auto document=destination/("DesktopPilot-replay-"+ticket+".png");
    const auto started=std::chrono::steady_clock::now();
    Json report={{"status","error"},{"dispatch","not_started"},{"outputDirectory",utf8(destination.wstring())},
        {"document",utf8(document.wstring())},{"recipe",utf8(std::filesystem::absolute(file).wstring())},{"automaticRetry",false}};
    try {
        std::unique_ptr<ActionRecording> recording;
        if(!recording_directory.empty())recording=std::make_unique<ActionRecording>(recording_directory);
        const auto& canvas=recipe.at("canvas");int w=canvas.at("width"),h=canvas.at("height");
        Image blank{w,h,std::vector<uint8_t>(size_t(w)*h*3)};
        for(size_t i=0;i<blank.rgb.size();++i)blank.rgb[i]=canvas["background"][i%3].get<uint8_t>();
        save_png(blank,document);write_json(destination/"recipe.json",recipe);
        ReplayDesktop desktop(worker,recipe["application"],document,recording.get());
        auto call=[&](const std::string& tool,const Json& args){return desktop.call(tool,args);};
        open_document(recipe["application"]["bundleId"],document);
        desktop.discover(true);desktop.await_ready();
        if(stop_after) {
            verify_replay_document(desktop.metadata,recipe["application"],document,false);desktop.strict_document=true;
            write_checkpoint_atomic(destination/"checkpoint.json",{{"schemaVersion",1},{"status","in_progress"}});
        }
        auto replay=run_replay(recipe,desktop.target,call,[&](const Json& progress) {
            auto current=report;current["replay"]=progress;write_json(destination/"progress.json",current);
            std::cerr<<"Replay "<<progress.value("completedSteps",size_t(0))<<'/'<<recipe["steps"].size()<<" steps; "<<progress.value("completedStrokes",size_t(0))<<" strokes\n"<<std::flush;
        },0,stop_after);
        report["replay"]=replay;report["status"]=replay.at("status");
        if(!operation_failed(replay)&&replay.value("paused",false)) {
            save_checkpoint(desktop,recipe,replay,destination);
            report["status"]="paused";report["checkpoint"]=utf8((destination/"checkpoint.json").wstring());
        }
        if(recording){recording->finish();report["recording"]=utf8(recording->path().wstring());}
        if(!operation_failed(replay)) {
            report["dispatch"]="dispatched";
            if(replay.contains("finalState")&&replay["finalState"].contains("capture")) {
                const auto encoded=replay["finalState"]["capture"]["path"].get<std::string>();
                auto capture=std::filesystem::path(std::u8string(encoded.begin(),encoded.end()));
                const auto preview=destination/"final-window.png";
                std::filesystem::copy_file(capture,preview);
                report["preview"]=utf8(preview.wstring());
            }
            report["verification"]=report["status"]=="paused"?"checkpoint_saved; unfinished steps not dispatched":"actions_completed; inspect saved document and final screenshot";
        } else report["dispatch"]=replay.value("dispatch",std::string("unknown"));
    } catch(const std::exception& e) {
        report["status"]="error";report["message"]=e.what();
        report["next"]="Inspect the new replay document and progress.json. No automatic retry or rollback.";
        if(std::filesystem::exists(destination/"progress.json"))report["dispatch"]="unknown";
    }
    report["elapsedMs"]=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
    write_json(destination/"report.json",report);std::cout<<dump_json(report,2)<<'\n';
    return report.at("status")=="ok"||report.at("status")=="paused"?0:1;
}
int replay_resume_cli(const std::filesystem::path& directory,size_t stop_after) {
#ifndef __APPLE__
    (void)directory;(void)stop_after;throw std::runtime_error("Replay resume requires macOS");
#else
    const auto root=std::filesystem::canonical(directory);RunLock lock(root);
    auto loaded=load_replay_checkpoint(root);const auto recipe=loaded.at("recipe");const auto checkpoint=loaded.at("checkpoint");
    const size_t start=checkpoint.at("completedSteps"),strokes=checkpoint.at("completedStrokes");
    validate_replay_stop(recipe,stop_after);
    if(stop_after&&stop_after<=start)throw std::invalid_argument("Resume stop boundary must follow the saved cursor");
    Worker worker;auto environment=worker.execute("system.preflight",Json::object());
    if(!environment.value("ready",false)){std::cout<<dump_json(Json{{"status","error"},{"dispatch","not_started"},{"preflight",environment}},2)<<'\n';return 3;}
    const auto output=root/"attempts"/ticket();std::filesystem::create_directories(output);
    Json report={{"status","error"},{"dispatch","not_started"},{"document",loaded["document"]},{"outputDirectory",utf8(output.wstring())},
        {"resumedFromStep",start},{"automaticRetry",false}};
    bool armed=false;const auto started=std::chrono::steady_clock::now();
    try {
        ReplayDesktop desktop(worker,recipe["application"],decoded_path(loaded["document"].get<std::string>()));desktop.strict_document=true;
        desktop.discover(false);verify_checkpoint_view(desktop,recipe,loaded);
        auto busy=checkpoint;busy["status"]="in_progress";write_checkpoint_atomic(root/"checkpoint.json",busy);armed=true;
        auto replay=run_replay(recipe,desktop.target,[&](const std::string& tool,const Json& args){return desktop.call(tool,args);},[&](const Json& progress) {
            auto current=report;current["replay"]=progress;write_json(output/"progress.json",current);
            std::cerr<<"Resume "<<progress.value("completedSteps",size_t(0))<<'/'<<recipe["steps"].size()<<" steps; "<<progress.value("completedStrokes",size_t(0))<<" total strokes\n"<<std::flush;
        },start,stop_after);
        report["replay"]=replay;report["status"]=replay.at("status");
        if(!operation_failed(replay)) {
            if(replay.value("paused",false)){save_checkpoint(desktop,recipe,replay,root);report["status"]="paused";}
            else {
                Json done={{"schemaVersion",1},{"status","complete"},{"completedSteps",replay["completedSteps"]},{"completedStrokes",replay["completedStrokes"]},
                    {"document",checkpoint["document"]},{"recipeSha256",checkpoint["recipeSha256"]}};
                write_checkpoint_atomic(root/"checkpoint.json",done);
            }
            const auto preview=output/"final-window.png";save_png(load_image(decoded_path(replay["finalState"]["capture"]["path"].get<std::string>())),preview);
            report["preview"]=utf8(preview.wstring());report["dispatch"]="dispatched";
        } else {
            report["dispatch"]=replay.value("dispatch",std::string("unknown"));
            if(replay_resume_not_started(replay,start,strokes)){write_checkpoint_atomic(root/"checkpoint.json",checkpoint);report["checkpointRearmed"]=true;}
        }
    } catch(const std::exception& error) {
        report["message"]=error.what();if(armed)report["dispatch"]="unknown";
        report["next"]="Inspect the document and attempt report; do not reset an in_progress checkpoint or repeat uncertain input.";
    }
    report["elapsedMs"]=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
    write_json(output/"report.json",report);std::cout<<dump_json(report,2)<<'\n';
    return report["status"]=="ok"||report["status"]=="paused"?0:1;
#endif
}
}
