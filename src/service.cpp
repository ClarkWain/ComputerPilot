#include <algorithm>
#include <cmath>
#include <chrono>
#include <desktop_pilot/service.hpp>
#include <desktop_pilot/semantic.hpp>
#include <desktop_pilot/profiles.hpp>
#include <desktop_pilot/preflight.hpp>
#include <fstream>
#include <thread>
namespace dp {
namespace {
std::filesystem::path path(const std::string &value) { return std::filesystem::u8path(value); }
} // namespace
bool Service::read_only(const std::string &op) {
    return op == "runtime.capabilities" || op == "runtime.describe" || op == "action.status" ||
           op == "system.info" || op == "system.session" || op == "system.preflight" || op == "process.list" || op == "display.list" || op == "window.list" ||
           op == "window.get" || op == "window.children" || op == "window.foreground" || op == "ui.tree" || op == "ui.find" ||
           op == "ui.get" || op == "ui.at_point" || op == "ui.text" || op == "ui.selection" ||
           op == "clipboard.formats" || op == "clipboard.read" || op == "vision.parse" ||
           op == "vision.ocr" || op == "semantic.profiles";
}
Json Service::execute(const std::string &op, const Json &args) {
    if (!args.contains("requestId"))
        return perform(op, args);
    auto id = args.at("requestId").get<std::string>();
    if (id.empty())
        throw std::invalid_argument("requestId must not be empty");
    Json payload = {{"operation", op}, {"args", args}};
    auto found = receipts_.find(id);
    if (found != receipts_.end()) {
        if (found->second.first != payload)
            throw std::invalid_argument("requestId_conflict: same id with different arguments");
        auto replay = found->second.second;
        replay["replayed"] = true;
        return replay;
    }
    Json pending = {
        {"requestId", id}, {"status", "unknown"}, {"dispatch", "dispatched"}, {"verification", "unknown"}};
    receipts_[id] = {payload, pending};
    try {
        auto result = perform(op, args);
        if (!result.is_object())
            result = {{"result", result}};
        result["requestId"] = id;
        result["replayed"] = false;
        receipts_[id].second = result;
        return result;
    } catch (const std::exception &e) {
        auto result = pending;
        result["status"] = "error";
        result["message"] = e.what();
        result["retryability"] = "inspect before retry; same requestId will not dispatch again";
        receipts_[id].second = result;
        return result;
    }
}
Json Service::perform(const std::string &op, const Json &args) {
    if(op=="app.launch") {
        auto launched=desktop_.execute(op,args);
        if(args.value("hidden",false))return launched;
        try {
        // Only windows created by this launch may be fitted. Existing user windows
        // are never resized by observation or profile matching.
        const auto dir=profiles_directory();
        if(!std::filesystem::is_directory(dir))return launched;
        auto executable=path(args.at("executable")).filename().string();
        std::transform(executable.begin(),executable.end(),executable.begin(),[](unsigned char c){return char(std::tolower(c));});
        for(const auto& entry:std::filesystem::directory_iterator(dir)) {
            if(!entry.is_directory()||!std::filesystem::exists(entry.path()/"profile.json"))continue;
            auto profile=load_profile(dir,utf8(entry.path().filename().wstring()));
            if(!profile.contains("recommendedWindow")||profile["match"]["executable"]!=executable)continue;
            for(int attempt=0;attempt<20;++attempt) {
                auto windows=desktop_.execute("window.list",{{"pid",launched["pid"]},{"includeHidden",true}})["windows"];
                Json matches=Json::array();for(auto& w:windows)if(w["className"]==profile["match"]["className"])matches.push_back(w);
                if(matches.size()==1) {
                    auto w=matches[0];double scale=w.value("dpi",96)/96.0;
                    desktop_.execute("window.restore",{{"windowRef",w["windowRef"]}});
                    int width=int(profile["recommendedWindow"]["width"].get<int>()*scale),height=int(profile["recommendedWindow"]["height"].get<int>()*scale);
                    auto displays=desktop_.execute("display.list",Json::object())["displays"];
                    for(auto& display:displays) {auto b=display["workArea"];int x=w["bounds"]["x"],y=w["bounds"]["y"];
                        if(x>=b["x"].get<int>()&&y>=b["y"].get<int>()&&x<b["x"].get<int>()+b["width"].get<int>()&&y<b["y"].get<int>()+b["height"].get<int>()) {
                            width=std::min(width,b["width"].get<int>());height=std::min(height,b["height"].get<int>());
                            desktop_.execute("window.move",{{"windowRef",w["windowRef"]},{"x",std::clamp(x,b["x"].get<int>(),b["x"].get<int>()+b["width"].get<int>()-width)},
                                {"y",std::clamp(y,b["y"].get<int>(),b["y"].get<int>()+b["height"].get<int>()-height)}});break;
                        }
                    }
                    desktop_.execute("window.resize",{{"windowRef",w["windowRef"]},{"width",width},{"height",height}});
                    launched["windowRef"]=w["windowRef"];launched["windowPrepared"]=true;return launched;
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            launched["windowPrepared"]=false;launched["next"]="New process has no unique matching window yet; list_windows.";break;
        }
        } catch (const std::exception& e) {
            launched["windowPrepared"]=false;
            launched["preparationError"]=e.what();
            launched["next"]="Process was launched; inspect its window. Do not launch a duplicate.";
        }
        return launched;
    }
    if (op == "system.preflight")
        return desktop_preflight(desktop_.execute("system.session", Json::object()));
    if (op == "semantic.profiles") {
        Json inspection;
        auto result=discover_profiles(profiles_directory(),args.at("windowRef"),
            [&](const std::string& operation,const Json& parameters){return execute(operation,parameters);},&inspection);
        if(args.value("includeControls",false)&&!inspection.is_null())result["inspection"]=inspection;
        return result;
    }
    if (op == "semantic.execute")
        return execute_profile_actions(profiles_directory(),args,
            [&](const std::string& operation,const Json& parameters){return execute(operation,parameters);},
            [&](const Json& request,const SemanticEvidence& evidence){return perform_semantic(request,&evidence);});
    if (op == "semantic.perform") return perform_semantic(args);
    if (op == "action.status") {
        auto found = receipts_.find(args.at("id").get<std::string>());
        if (found == receipts_.end())
            return {{"status", "not_found"}, {"dispatch", "not_started"}};
        return found->second.second;
    }
    if (op.starts_with("capture.")) {
        auto captured = desktop_.execute(op, args);
        captured["contentRef"] = captured["imageRef"];
        captured["imageRef"] =
            "capture-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" +
            std::to_string(++capture_serial_) + "-" + captured["contentRef"].get<std::string>();
        if (args.contains("windowRef"))
            captured["windowRef"] = args["windowRef"];
        images_[captured.at("imageRef").get<std::string>()] = captured;
        return captured;
    }
    if (op.starts_with("input.") &&
        args.value("coordinateSpace", std::string{}) != "window_relative" &&
        args.value("coordinateSpace", std::string{}) != "client_relative" &&
        args.value("coordinateSpace", std::string("screen_physical")) != "screen_physical") {
        if (args.at("coordinateSpace") != "image_pixels")
            throw std::invalid_argument("Supported input spaces: screen_physical, image_pixels");
        auto id = args.at("imageRef").get<std::string>();
        auto it = images_.find(id);
        if (it == images_.end())
            throw std::invalid_argument("Unknown imageRef; use a capture returned by this session");
        auto frame = it->second;
        if (frame.contains("windowRef")) {
            auto current = desktop_.execute("window.get", {{"windowRef", frame["windowRef"]}});
            if (current["bounds"] != frame.value("windowBounds",frame["bounds"]))
                throw std::runtime_error("stale_image_geometry; capture again or use live UIA elementRef");
        }
        auto converted = args;
        int x = args.at("x"), y = args.at("y");
        if (x < 0 || y < 0 || x >= frame["width"].get<int>() || y >= frame["height"].get<int>())
            throw std::invalid_argument("Point outside image bounds");
        auto map=[&](int value,const char* axis,const char* extent){return int((int64_t(value)*frame["bounds"][extent].get<int>())/frame[extent].get<int>())+frame["bounds"][axis].get<int>();};
        converted["x"] = map(x,"x","width");
        converted["y"] = map(y,"y","height");
        converted["coordinateSpace"] = "screen_physical";
        if (op == "input.drag") {
            int tx = args.at("toX"), ty = args.at("toY");
            if (tx < 0 || ty < 0 || tx >= frame["width"].get<int>() || ty >= frame["height"].get<int>())
                throw std::invalid_argument("Drag endpoint outside image bounds");
            converted["toX"] = map(tx,"x","width");
            converted["toY"] = map(ty,"y","height");
        }
        return desktop_.execute(op, converted);
    }
    if (op == "runtime.capabilities") {
        auto r = desktop_.execute(op, args);
        r["operations"].push_back("runtime.describe");
        r["operations"].push_back("system.preflight");
        r["desktopPreflight"] = perform("system.preflight", Json::object());
        r["operations"].push_back("action.status");
        r["operations"].push_back("semantic.perform");
        r["operations"].push_back("vision.parse");
        r["operations"].push_back("vision.ocr");
        r["operations"].push_back("inspect.hybrid");
        r["vision"] = {
            {"detector", Detector::available()},
            {"ocr", Ocr::available()},
            {"loaded", {{"detector", bool(detector_)}, {"ocr", bool(ocr_)}}}};
        r["transport"] = {"mcp-stdio", "jsonl"};
        return r;
    }
    if (op == "runtime.describe")
        return Json::parse(
            R"({"references":"windowRef and elementRef are session-local","nativeQuery":{"operation":"ui.find","args":{"windowRef":"w1","selector":{"role":"Edit","nameContains":"title"},"depth":8,"limit":50,"offset":0,"nodeBudget":5000}},"setValue":{"operation":"ui.set_value","args":{"elementRef":"e2","value":"text"}},"capture":{"operation":"capture.window","args":{"windowRef":"w1","output":"absolute PNG path"}},"vision":{"operation":"vision.parse","args":{"image":"absolute PNG path","model":"absolute detector .pt path","ocrModels":"optional OCR directory"}},"hybrid":{"operation":"inspect.hybrid","args":{"windowRef":"w1","output":"absolute PNG path","model":"absolute detector .pt path"}},"input":{"coordinateSpace":"screen_physical","click":{"x":100,"y":100,"button":"left","count":1},"typeText":{"text":"Unicode text"},"keyChord":{"keys":["CTRL","A"]}}})");
    if (op == "inspect.hybrid") {
        std::vector<std::filesystem::path> files{path(args.at("output").get<std::string>()),
                                                 path(args.at("model").get<std::string>())};
        if (args.contains("ocrModels"))
            for (auto name : {"det.onnx", "rec.onnx"})
                files.push_back(path(args["ocrModels"].get<std::string>()) / name);
        ensure_distinct_paths(files);
        auto captured = execute("capture.window", args);
        auto vision_args = args;
        vision_args["image"] = captured["path"];
        auto visual = execute("vision.parse", vision_args);
        auto tree = desktop_.execute("ui.tree", args);
        int left = captured["bounds"]["x"], top = captured["bounds"]["y"];
        for (auto &region : visual["elements"]) {
            auto b = region["bounds"];
            double cx = b["x"].get<double>() + b["width"].get<double>() / 2 + left,
                   cy = b["y"].get<double>() + b["height"].get<double>() / 2 + top;
            double best = 1e30;
            Json match = nullptr;
            for (auto &node : tree["elements"]) {
                auto n = node["bounds"];
                double x = n["x"], y = n["y"], w = n["width"], h = n["height"];
                if (cx >= x && cy >= y && cx < x + w && cy < y + h && w * h < best) {
                    match = node["elementRef"];
                    best = w * h;
                }
            }
            region["nativeRef"] = match;
            region["associationMethod"] =
                "smallest UIA bounds containing visual center; not semantic identity proof";
            region["screenCandidatePoint"] = {{"x", cx},
                                              {"y", cy},
                                              {"source", "visual_bounds_center"},
                                              {"coordinateSpace", "screen_physical"}};
        }
        visual["capture"] = captured;
        visual["native"] = tree;
        visual["atomicSnapshot"] = false;
        return visual;
    }
    if (!op.starts_with("vision."))
        return desktop_.execute(op, args);
    if (op != "vision.parse" && op != "vision.ocr")
        throw std::invalid_argument("Unknown vision operation");
    auto image_path = path(args.at("image").get<std::string>());
    auto image = load_image(image_path);
    auto image_ref = "img-sha256-" + file_sha256(image_path);
    DetectionResult detected;
    OcrResult recognized;
    Json result = {{"status", "ok"},
                   {"imageRef", image_ref},
                   {"width", image.width},
                   {"height", image.height},
                   {"components",
                    {{"detector", "not_requested"}, {"ocr", "not_requested"}}}};
    if (op == "vision.parse") {
        auto file = args.at("model").get<std::string>();
        if (!detector_ || detector_path_ != file) {
            auto replacement = std::make_unique<Detector>(path(file), DetectorOptions{});
            detector_ = std::move(replacement);
            detector_path_ = file;
        }
        detected = detector_->run(image);
        result["components"]["detector"] = "completed";
        result["detectorTimingsMs"] = detected.timings_ms;
    }
    if (op == "vision.ocr" || args.contains("ocrModels")) {
        try {
            auto dir = args.at("ocrModels").get<std::string>();
            if (!ocr_ || ocr_path_ != dir) {
                auto replacement = std::make_unique<Ocr>(path(dir), OcrOptions{});
                ocr_ = std::move(replacement);
                ocr_path_ = dir;
            }
            if (args.contains("ocrMaxSide")) {
                int override_side = args.at("ocrMaxSide").get<int>();
                if (override_side < 32 || override_side > 2048)
                    throw std::invalid_argument("ocrMaxSide must be within 32..2048");
                recognized = ocr_->run(image, override_side);
            } else {
                recognized = ocr_->run(image);
            }
            result["textLines"] = text_lines_json(recognized.lines, image_ref);
            result["components"]["ocr"] = recognized.truncated ? "partial" : "completed";
            if (recognized.truncated)
                result["status"] = "partial";
        } catch (const std::exception &e) {
            result["components"]["ocr"] = "failed";
            result["ocrError"] = e.what();
            result["status"] = "partial";
        }
    }
    result["elements"] = fuse_text(detected.detections, recognized.lines, image_ref);
    return result;
}
Json Service::perform_semantic(const Json& args, const SemanticEvidence* evidence) {
    std::ifstream file(path(args.at("profile").get<std::string>()));
    if (!file) throw std::invalid_argument("Cannot open semantic profile");
    auto profile = Json::parse(file);
    auto semanticArgs = args;
    if (!semanticArgs.contains("failureScreenshot")) {
        semanticArgs["failureScreenshot"] = utf8((std::filesystem::temp_directory_path() /
            (L"desktop-pilot-failure-" + std::to_wstring(std::chrono::steady_clock::now().time_since_epoch().count()) + L".png")).wstring());
    } else if (semanticArgs["failureScreenshot"] == false) semanticArgs.erase("failureScreenshot");
    return run_semantic(semanticArgs, profile,
        [&](const std::string& operation, const Json& parameters) {
            auto bound=parameters;
            if((operation.starts_with("input.")||operation=="ui.fill") && bound.contains("windowRef"))bound["autoActivate"]=true;
            return execute(operation,bound);
        },
        [](int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }, evidence);
}
} // namespace dp
