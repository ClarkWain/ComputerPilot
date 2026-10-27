#include <desktop_pilot/replay.hpp>
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
}
int replay_cli(const std::filesystem::path& file,const std::filesystem::path& output,bool execute) {
    auto recipe=read_recipe(file);auto summary=validate_replay(recipe);
    if(!execute){summary["mode"]="validate";std::cout<<dump_json(summary,2)<<'\n';return 0;}
#ifndef __APPLE__
    throw std::runtime_error("macOS replay requires a macOS executor; validation is available here");
#endif
    if(output.empty())throw std::invalid_argument("Replay execution requires --output NEW_DIRECTORY");
    auto destination=std::filesystem::absolute(output).lexically_normal();
    if(std::filesystem::exists(destination))throw std::invalid_argument("Replay output directory already exists; use a new directory");
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
        const auto& canvas=recipe.at("canvas");int w=canvas.at("width"),h=canvas.at("height");
        Image blank{w,h,std::vector<uint8_t>(size_t(w)*h*3)};
        for(size_t i=0;i<blank.rgb.size();++i)blank.rgb[i]=canvas["background"][i%3].get<uint8_t>();
        save_png(blank,document);write_json(destination/"recipe.json",recipe);
        const auto expectedExecutable=recipe["application"]["executable"].get<std::string>();
        AgentApi api;std::string target;
        auto dispatch=[&](const std::string& operation,const Json& args) {
            auto result=worker.execute(operation,args);
            // Revalidate the executable each time AgentApi prepares the window.
            if(operation=="window.get"&&!operation_failed(result)&&!target.empty()&&
               (result.value("executable",std::string{})!=expectedExecutable||result.value("title",std::string{})!=document.filename().string()))
                return Json{{"status","error"},{"code","replay_target_changed"},{"dispatch","not_started"},{"message","Fresh replay document identity changed"}};
            return result;
        };
        auto call=[&](const std::string& tool,const Json& args){return api.call(tool,args,dispatch);};
        open_document(recipe["application"]["bundleId"],document);
        for(int attempt=0;attempt<150;++attempt) {
            auto listing=call("list_windows",Json::object());
            if(operation_failed(listing))throw std::runtime_error("Replay window discovery failed: "+dump_json(listing));
            Json matches=Json::array();
            for(const auto& window:listing.at("windows"))if(window.at("title")==document.filename().string())matches.push_back(window);
            if(matches.size()>1)throw std::runtime_error("Replay document identity is ambiguous");
            if(matches.size()==1){target=matches[0]["window_id"];break;}
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        if(target.empty())throw std::runtime_error("Replay document did not appear within 30 seconds; process was not relaunched");
        // A compositor window can appear before its Accessibility provider is
        // ready. Poll observations only, without activating or sending input.
        Json initialState;
        for(int attempt=0;attempt<150;++attempt) {
            initialState=call("get_window_state",{{"window_id",target},{"mode","controls"},{"activate",false}});
            if(!operation_failed(initialState)&&initialState.contains("controls")&&!initialState["controls"].empty())break;
            if(initialState.value("paused",false)||initialState.value("referencesInvalidated",false)||
               initialState.value("code",std::string{})=="replay_target_changed")break;
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
        if(operation_failed(initialState)||!initialState.contains("controls")||initialState["controls"].empty())
            throw std::runtime_error("New replay document Accessibility did not become ready: "+dump_json(initialState));
        auto replay=run_replay(recipe,target,call,[&](const Json& progress) {
            auto current=report;current["replay"]=progress;write_json(destination/"progress.json",current);
            std::cerr<<"Replay "<<progress.value("completedSteps",size_t(0))<<'/'<<recipe["steps"].size()<<" steps; "<<progress.value("completedStrokes",size_t(0))<<" strokes\n"<<std::flush;
        });
        report["replay"]=replay;report["status"]=replay.at("status");
        if(!operation_failed(replay)) {
            report["dispatch"]="dispatched";
            if(replay.contains("finalState")&&replay["finalState"].contains("capture")) {
                const auto encoded=replay["finalState"]["capture"]["path"].get<std::string>();
                auto capture=std::filesystem::path(std::u8string(encoded.begin(),encoded.end()));
                const auto preview=destination/"final-window.png";
                std::filesystem::copy_file(capture,preview);
                report["preview"]=utf8(preview.wstring());
            }
            report["verification"]="actions_completed; inspect saved document and final screenshot";
        } else report["dispatch"]=replay.value("dispatch",std::string("unknown"));
    } catch(const std::exception& e) {
        report["status"]="error";report["message"]=e.what();
        report["next"]="Inspect the new replay document and progress.json. No automatic retry or rollback.";
        if(std::filesystem::exists(destination/"progress.json"))report["dispatch"]="unknown";
    }
    report["elapsedMs"]=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count();
    write_json(destination/"report.json",report);std::cout<<dump_json(report,2)<<'\n';
    return report.at("status")=="ok"?0:1;
}
}
