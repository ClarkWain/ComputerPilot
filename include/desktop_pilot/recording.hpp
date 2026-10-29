#pragma once
#include <desktop_pilot/replay.hpp>
#include <fstream>
#include <map>

namespace dp {
// Opt-in recording of ComputerPilot calls, not a global keyboard/mouse hook.
class ActionRecording {
public:
    explicit ActionRecording(const std::filesystem::path& new_directory);
    void observe_window(const std::string& operation,const Json& result);
    Json call(const std::string& tool,const Json& args,const ReplayCall& execute);
    void finish();
    const std::filesystem::path& path() const {return path_;}
private:
    void append(const Json& event);
    std::filesystem::path path_;
    std::ofstream stream_;
    std::map<std::string,Json> windows_;
    size_t sequence_=0;
    bool failed_=false,finished_=false;
};
// Offline conversion: neither function below starts an application or sends input.
Json export_recording(const std::filesystem::path& journal,const Json& recipe_template);
int recording_export_cli(const std::filesystem::path& journal,const std::filesystem::path& recipe_template,
                         const std::filesystem::path& new_directory);
}
