#include <desktop_pilot/checkpoint.hpp>
#include <desktop_pilot/platform.hpp>
#include <algorithm>
#include <chrono>
#include <fstream>
#include <set>
#include <cstdio>

namespace dp {
namespace {
std::filesystem::path decoded_path(const std::string& value){return std::filesystem::path(std::u8string(value.begin(),value.end()));}
Json read_json(const std::filesystem::path& path,uintmax_t limit) {
    if(!std::filesystem::is_regular_file(path)||std::filesystem::file_size(path)>limit)throw std::runtime_error("Invalid or oversized checkpoint asset");
    std::ifstream stream(path,std::ios::binary);if(!stream)throw std::runtime_error("Cannot read checkpoint asset");return Json::parse(stream);
}
std::filesystem::path asset(const std::filesystem::path& root,const Json& checkpoint,const char* key,const char* hash) {
    auto relative=decoded_path(checkpoint.at(key).get<std::string>());
    if(relative.empty()||relative.is_absolute())throw std::runtime_error("Checkpoint asset path must be relative");
    for(const auto& part:relative)if(part==".."||part==".")throw std::runtime_error("Checkpoint asset escapes the run directory");
    auto resolved=std::filesystem::canonical(root/relative);auto within=resolved.lexically_relative(root);
    if(within.empty()||within.is_absolute())throw std::runtime_error("Checkpoint asset escapes the run directory");
    for(const auto& part:within)if(part=="..")throw std::runtime_error("Checkpoint asset escapes the run directory");
    if(!std::filesystem::is_regular_file(resolved)||std::filesystem::file_size(resolved)>256*1024*1024||file_sha256(resolved)!=checkpoint.at(hash).get<std::string>())
        throw std::runtime_error(std::string("Checkpoint asset changed: ")+key);
    return resolved;
}
}
size_t replay_prefix_strokes(const Json& recipe,size_t completed_steps) {
    if(completed_steps>recipe.at("steps").size())throw std::invalid_argument("Replay cursor exceeds recipe");
    size_t count=0;for(size_t i=0;i<completed_steps;++i)if(recipe["steps"][i]["type"]=="draw")count+=recipe["steps"][i]["strokes"].size();return count;
}
void validate_replay_stop(const Json& recipe,size_t stop_after) {
    if(!stop_after)return;
    if(stop_after>=recipe.at("steps").size()||recipe["steps"][stop_after-1]["type"]!="draw")
        throw std::invalid_argument("--stop-after must follow a complete draw group before the final step");
}
Json replay_observable_state(const Json& state,const Json& selector) {
    Json canvas,controls=Json::array();size_t matches=0;
    for(const auto& c:state.at("controls")) {
        if(!c.value("enabled",true)||c.value("offscreen",false))continue;
        const auto role=c.at("role").get<std::string>();
        if(role==selector["role"].get<std::string>()&&c.contains("bounds")&&c["bounds"][2]==selector["bounds"]["width"]&&c["bounds"][3]==selector["bounds"]["height"]&&
           (!selector.contains("name")||c.value("name",std::string{})==selector["name"].get<std::string>())){canvas=c;++matches;}
        // IDs, screen positions, timestamps and text labels are transient.
        // Tool values and control dimensions must match the saved observation.
        if(role=="CheckBox"||role=="RadioButton"||role=="ComboBox"||role=="AXColorWell")
            controls.push_back({{"role",role},{"name",c.value("name",std::string{})},{"value",c.value("value",Json())},
                {"size",{c.at("bounds")[2],c.at("bounds")[3]}}});
    }
    if(matches!=1)throw std::runtime_error("Checkpoint canvas is missing or ambiguous");
    std::sort(controls.begin(),controls.end(),[](const Json& a,const Json& b){return a.dump()<b.dump();});
    return {{"canvasSize",{canvas["bounds"][2],canvas["bounds"][3]}},{"controls",controls}};
}
void verify_replay_document(const Json& window,const Json& application,const std::filesystem::path& document,bool require_saved) {
    if(window.at("executable")!=application.at("executable")||window.at("bundleIdentifier")!=application.at("bundleId")||
       window.at("title")!=document.filename().string()||!window.contains("documentPath")||
       std::filesystem::weakly_canonical(decoded_path(window.at("documentPath").get<std::string>()))!=std::filesystem::canonical(document))
        throw std::runtime_error("Checkpoint target is not the original replay document");
    if(require_saved&&(!window.contains("documentEdited")||!window["documentEdited"].is_boolean()||window["documentEdited"].get<bool>()))
        throw std::runtime_error("Checkpoint document is unsaved or its saved state is unavailable");
}
void write_checkpoint_atomic(const std::filesystem::path& file,const Json& checkpoint) {
    auto temporary=file;temporary+=".tmp-"+std::to_string(process_id())+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    try {
        {std::ofstream stream(temporary,std::ios::binary);if(!stream)throw std::runtime_error("Cannot create checkpoint descriptor");
            stream<<checkpoint.dump(2)<<'\n';stream.flush();if(!stream)throw std::runtime_error("Checkpoint write failed");}
#ifdef _WIN32
        if(!MoveFileExW(temporary.c_str(),file.c_str(),MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH))throw std::runtime_error("Checkpoint replacement failed");
#else
        if(std::rename(temporary.c_str(),file.c_str())!=0)throw std::runtime_error("Checkpoint replacement failed");
#endif
    } catch(...) {std::error_code error;std::filesystem::remove(temporary,error);throw;}
}
Json load_replay_checkpoint(const std::filesystem::path& directory) {
    auto root=std::filesystem::canonical(directory);
    if(std::filesystem::is_symlink(root/"checkpoint.json")||std::filesystem::is_symlink(root/"recipe.json"))throw std::runtime_error("Checkpoint descriptors and frozen recipes must be local regular files");
    auto checkpoint=read_json(root/"checkpoint.json",1024*1024);
    const std::set<std::string> fields={"schemaVersion","status","recipeSha256","document","documentSha256","canvas","canvasSha256","observableState","completedSteps","completedStrokes"};
    for(auto it=checkpoint.begin();it!=checkpoint.end();++it)if(!fields.contains(it.key()))throw std::runtime_error("Unknown checkpoint field");
    if(checkpoint.at("schemaVersion")!=1||checkpoint.at("status")!="ready")throw std::runtime_error("Checkpoint is not ready; unknown, active or completed runs cannot resume");
    auto recipe=read_json(root/"recipe.json",8*1024*1024);validate_replay(recipe);
    if(file_sha256(root/"recipe.json")!=checkpoint.at("recipeSha256").get<std::string>())throw std::runtime_error("Checkpoint recipe changed");
    if(!checkpoint.at("completedSteps").is_number_integer()||checkpoint["completedSteps"].get<int64_t>()<1||!checkpoint.at("completedStrokes").is_number_integer()||checkpoint["completedStrokes"].get<int64_t>()<1)
        throw std::runtime_error("Checkpoint has an invalid cursor");
    const auto step=checkpoint["completedSteps"].get<size_t>();validate_replay_stop(recipe,step);
    if(replay_prefix_strokes(recipe,step)!=checkpoint["completedStrokes"].get<size_t>())throw std::runtime_error("Checkpoint stroke count differs from recipe prefix");
    auto document=asset(root,checkpoint,"document","documentSha256");auto relative=decoded_path(checkpoint["document"].get<std::string>());
    if(relative.has_parent_path()||(!relative.filename().string().starts_with("ComputerPilot-replay-")&&!relative.filename().string().starts_with("DesktopPilot-replay-"))||relative.extension()!=".png")throw std::runtime_error("Checkpoint document is not a replay-owned PNG");
    auto canvas=asset(root,checkpoint,"canvas","canvasSha256");load_image(canvas).validate();
    if(!checkpoint.at("observableState").is_object()||checkpoint["observableState"].at("canvasSize")!=Json({recipe["canvas"]["width"],recipe["canvas"]["height"]})||!checkpoint["observableState"].at("controls").is_array())
        throw std::runtime_error("Checkpoint observation differs from recipe canvas");
    return {{"recipe",recipe},{"checkpoint",checkpoint},{"document",utf8(document.wstring())},{"canvas",utf8(canvas.wstring())}};
}
bool replay_resume_not_started(const Json& result,size_t completed_steps,size_t completed_strokes) {
    return result.value("status",std::string{})=="error"&&result.value("phase",std::string{})=="step"&&
        result.value("dispatch",std::string{})=="not_started"&&result.value("completedSteps",size_t(-1))==completed_steps&&
        result.value("completedStrokes",size_t(-1))==completed_strokes;
}
}
