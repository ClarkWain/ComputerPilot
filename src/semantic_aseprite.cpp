// Aseprite vision-driven semantic adapter.
//
// Aseprite (verified against v1.2.15) draws its entire UI with Allegro; the
// UIA tree exposes only Win32 non-client decorations (title bar, system menu,
// scroll bars). Selectors that work for Paint's ribbon are unusable here.
//
// This adapter drives Aseprite by:
//   - keyboard hotkeys for tools/undo/zoom (input.key_chord),
//   - screenshot capture and PP-OCR text recognition to locate on-screen
//     labels (menu names in the top strip), then window-relative clicks.
//
// The adapter exposes key chords, stock tool/zoom hotkeys, generic window
// clicks, and OCR-based menu opening when the OCR backend is built. It does
// not provide pixel drawing, document creation, or save semantics.

#include <desktop_pilot/semantic.hpp>
#include <desktop_pilot/profiles.hpp>
#include <desktop_pilot/service.hpp>
#include <desktop_pilot/platform.hpp>
#include <algorithm>
#include <chrono>
#include <cctype>
#include <filesystem>
#include <map>
#include <set>

namespace dp {
namespace {

std::filesystem::path resolve_ocr_models(const Json& profile) {
    // Priority: explicit override in the profile-level "ocrModels" field
    // (used as-is so tests / packaging can inject a path without a filesystem
    // check), then COMPUTERPILOT_OCR_MODELS env var, then the "models/ocr"
    // directory found by walking up from the executable, which is what the
    // CMake install layout produces.
    if (profile.contains("ocrModels") && profile.at("ocrModels").is_string())
        return std::filesystem::path{profile.at("ocrModels").get<std::string>()};
    const auto configured=environment_path("COMPUTERPILOT_OCR_MODELS");
    if(!configured.empty() && std::filesystem::is_regular_file(configured/"det.onnx") &&
       std::filesystem::is_regular_file(configured/"rec.onnx"))return configured;
    auto dir=executable_path().parent_path();
    for(int i=0;i<6;++i,dir=dir.parent_path()) {
        auto candidate=dir/"models"/"ocr";
        if(std::filesystem::is_regular_file(candidate/"det.onnx") &&
           std::filesystem::is_regular_file(candidate/"rec.onnx"))return candidate;
    }
    throw std::runtime_error(
        "ocr_models_unavailable: place det.onnx and rec.onnx under models/ocr, "
        "set COMPUTERPILOT_OCR_MODELS, or add \"ocrModels\" to the profile");
}

std::string lower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return char(std::tolower(c)); });
    return s;
}

// Menu bar names Aseprite v1.2.15 English UI. If the target ever localizes we
// will need per-locale profiles; do not localize this here.
const std::set<std::string> menu_names = {"File",   "Edit",    "Sprite", "Layer", "Frame",
                                          "Select", "Tags",    "View",   "Help"};

// Aseprite v1.2.15 default tool hotkeys. Key is the user-facing tool name;
// value is the single-character shortcut. Renaming a hotkey inside Aseprite
// invalidates this table and needs a per-user profile override — but the
// stock installation is what we target here.
const std::map<std::string, std::string> tool_hotkeys = {
    {"pencil", "B"},         {"spray", "N"},          {"eraser", "E"},
    {"paintBucket", "G"},    {"line", "L"},           {"rectangle", "U"},
    {"ellipse", "O"},        {"text", "T"},           {"magicWand", "W"},
    {"hand", "H"},           {"eyedropper", "Y"},     {"move", "M"},
    {"rectangularMarquee", "F"}};

// Aseprite v1.2.15 default zoom hotkeys. Only the discrete presets are
// mapped; smaller/larger stepping via + / - is not exposed here so callers
// can rely on a deterministic final zoom level.
const std::map<int, std::string> zoom_hotkeys = {{100, "1"},  {200, "2"},  {400, "3"},
                                                 {800, "4"},  {1600, "5"}, {3200, "6"}};

bool is_ascii_key(const std::string& key) {
    // The same allowlist input.key_chord accepts. Aseprite hotkeys use
    // uppercase letters, digits, function keys, and modifier prefixes.
    if (key == "CTRL" || key == "SHIFT" || key == "ALT" || key == "WIN") return true;
    static const std::set<std::string> named = {"ENTER",   "TAB",   "ESC",     "BACKSPACE",
                                                "DELETE",  "LEFT",  "RIGHT",   "UP",
                                                "DOWN",    "HOME",  "END",     "SPACE",
                                                "PAGEUP",  "PAGEDOWN", "INSERT"};
    if (named.contains(key)) return true;
    if (key.size() == 1 && ((key[0] >= 'A' && key[0] <= 'Z') || (key[0] >= '0' && key[0] <= '9')))
        return true;
    for (int i = 1; i <= 12; ++i)
        if (key == "F" + std::to_string(i)) return true;
    return false;
}

} // namespace

Json run_aseprite_vision(const Json& request, const Json& profile, const SemanticCall& execute,
                        const std::function<void(int)>& sleep) {
    // Accept either a bare action ({action, args, windowRef}) or the batched
    // drawing.drawScene wrapper that execute_profile_actions produces. In the
    // wrapped form we run each item sequentially and stop on the first error.
    if (request.at("action") == "drawing.drawScene") {
        for (auto it = request.at("args").begin(); it != request.at("args").end(); ++it)
            if (it.key() != "items")
                throw std::invalid_argument("Aseprite scene supports only items");
        const auto& items = request.at("args").at("items");
        if (!items.is_array() || items.empty() || items.size() > 256)
            throw std::invalid_argument("Expected 1..256 aseprite actions");
        size_t completed = 0;
        size_t totalCalls = 0;
        Json lastResult;
        for (const auto& item : items) {
            Json child = item;
            child["windowRef"] = request.at("windowRef");
            lastResult = run_aseprite_vision(child, profile, execute, sleep);
            if (lastResult.value("nativeCalls", size_t{0}) > 0)
                totalCalls += lastResult.value("nativeCalls", size_t{0});
            if (lastResult.value("status", std::string{}) != "ok") {
                lastResult["completed"] = completed;
                lastResult["total"] = items.size();
                lastResult["nativeCalls"] = totalCalls;
                lastResult["failedIndex"] = completed;
                return lastResult;
            }
            ++completed;
        }
        return {{"status", "ok"},
                {"completed", completed},
                {"total", items.size()},
                {"nativeCalls", totalCalls},
                {"lastResult", lastResult}};
    }

    const auto action = request.at("action").get<std::string>();
    if (action != "aseprite.keyChord" && action != "aseprite.openMenu" &&
        action != "aseprite.selectTool" && action != "aseprite.zoom" &&
        action != "aseprite.click")
        throw std::invalid_argument("Unsupported Aseprite action");
    if (!request.contains("windowRef") || !request.at("windowRef").is_string())
        throw std::invalid_argument("windowRef required");
    const auto& a = request.at("args");
    if (!a.is_object()) throw std::invalid_argument("args must be an object");

    // Parameter validation before any desktop call.
    if (action == "aseprite.keyChord") {
        if (!a.contains("keys") || !a.at("keys").is_array() || a.at("keys").empty() ||
            a.at("keys").size() > 8)
            throw std::invalid_argument("keys must be a 1..8 element array");
        for (const auto& k : a.at("keys")) {
            if (!k.is_string() || !is_ascii_key(k.get<std::string>()))
                throw std::invalid_argument("Unsupported key; use uppercase key names");
        }
        for (auto it = a.begin(); it != a.end(); ++it)
            if (it.key() != "keys") throw std::invalid_argument("Unsupported argument: " + it.key());
    } else if (action == "aseprite.openMenu") {
        if (!a.contains("name") || !a.at("name").is_string())
            throw std::invalid_argument("name must be a string");
        if (!menu_names.contains(a.at("name").get<std::string>()))
            throw std::invalid_argument(
                "Unknown menu; use one of File/Edit/Sprite/Layer/Frame/Select/Tags/View/Help");
        for (auto it = a.begin(); it != a.end(); ++it)
            if (it.key() != "name") throw std::invalid_argument("Unsupported argument: " + it.key());
    } else if (action == "aseprite.selectTool") {
        if (!a.contains("tool") || !a.at("tool").is_string())
            throw std::invalid_argument("tool must be a string");
        if (!tool_hotkeys.contains(a.at("tool").get<std::string>()))
            throw std::invalid_argument(
                "Unknown tool; supported: pencil/spray/eraser/paintBucket/line/rectangle/"
                "ellipse/text/magicWand/hand/eyedropper/move/rectangularMarquee");
        for (auto it = a.begin(); it != a.end(); ++it)
            if (it.key() != "tool") throw std::invalid_argument("Unsupported argument: " + it.key());
    } else if (action == "aseprite.zoom") {
        if (!a.contains("percent") || !a.at("percent").is_number_integer())
            throw std::invalid_argument("percent must be an integer");
        if (!zoom_hotkeys.contains(a.at("percent").get<int>()))
            throw std::invalid_argument(
                "Unsupported zoom; use one of 100/200/400/800/1600/3200");
        for (auto it = a.begin(); it != a.end(); ++it)
            if (it.key() != "percent")
                throw std::invalid_argument("Unsupported argument: " + it.key());
    } else if (action == "aseprite.click") {
        for (auto key : {"x", "y"}) {
            if (!a.contains(key) || !a.at(key).is_number_integer())
                throw std::invalid_argument(std::string(key) + " must be an integer");
            int v = a.at(key).get<int>();
            if (v < 0 || v > 32000)
                throw std::invalid_argument(std::string(key) + " out of range 0..32000");
        }
        if (a.contains("button") && !a.at("button").is_string())
            throw std::invalid_argument("button must be a string when supplied");
        if (a.contains("button")) {
            const auto btn = a.at("button").get<std::string>();
            if (btn != "left" && btn != "right" && btn != "middle")
                throw std::invalid_argument("button must be left, right or middle");
        }
        if (a.contains("count")) {
            if (!a.at("count").is_number_integer())
                throw std::invalid_argument("count must be an integer");
            const int c = a.at("count").get<int>();
            if (c < 1 || c > 3)
                throw std::invalid_argument("count must be 1..3");
        }
        for (auto it = a.begin(); it != a.end(); ++it)
            if (it.key() != "x" && it.key() != "y" && it.key() != "button" && it.key() != "count")
                throw std::invalid_argument("Unsupported argument: " + it.key());
    }

    const auto window = request.at("windowRef");
    size_t calls = 0;
    std::string phase = "preflight";
    bool dispatched = false;
    const auto started = std::chrono::steady_clock::now();

    auto call = [&](const std::string& op, const Json& args) {
        ++calls;
        auto result = execute(op, args);
        if (operation_failed(result))
            throw std::runtime_error(op + ": " +
                                     result.value("message", std::string("operation_failed")));
        return result;
    };

    try {
        const auto session = call("system.session", Json::object());
        if (!session.value("inputDesktopAccessible", false) ||
            session.value("lockState", std::string{}) == "locked")
            throw std::runtime_error("interactive_desktop_unavailable");
        const auto host = call("window.get", {{"windowRef", window}});
        if (!profile_supports_dpi(profile, host.value("dpi", 0)) ||
            !host.value("enabled", true) || host.value("minimized", false))
            throw std::runtime_error("unsupported_window_state");
        const auto& hb = host.at("bounds");
        const int win_x = hb.at("x").get<int>(), win_y = hb.at("y").get<int>(),
                  win_w = hb.at("width").get<int>(), win_h = hb.at("height").get<int>();
        if (win_w < profile.at("minimumWindowWidth").get<int>())
            throw std::runtime_error("window_too_narrow");

        if (!host.value("foreground", false)) call("window.activate", {{"windowRef", window}});

        if (action == "aseprite.keyChord") {
            phase = "dispatch";
            dispatched = true;
            call("input.key_chord", {{"windowRef", window}, {"keys", a.at("keys")}});
            const int settle = profile.value("keySettleMs", 60);
            if (settle) sleep(settle);
            return {{"status", "ok"},           {"action", action},
                    {"nativeCalls", calls},     {"verification", "not_requested"},
                    {"dispatch", "returned"},
                    {"elapsedMs",
                     std::chrono::duration<double, std::milli>(
                         std::chrono::steady_clock::now() - started)
                         .count()}};
        }

        if (action == "aseprite.selectTool") {
            phase = "dispatch";
            dispatched = true;
            const auto tool = a.at("tool").get<std::string>();
            const auto& hotkey = tool_hotkeys.at(tool);
            call("input.key_chord", {{"windowRef", window}, {"keys", Json::array({hotkey})}});
            const int settle = profile.value("keySettleMs", 60);
            if (settle) sleep(settle);
            return {{"status", "ok"},
                    {"action", action},
                    {"tool", tool},
                    {"hotkey", hotkey},
                    {"nativeCalls", calls},
                    {"verification", "not_requested"},
                    {"dispatch", "returned"},
                    {"elapsedMs", std::chrono::duration<double, std::milli>(
                                      std::chrono::steady_clock::now() - started)
                                      .count()}};
        }

        if (action == "aseprite.zoom") {
            phase = "dispatch";
            dispatched = true;
            const int percent = a.at("percent").get<int>();
            const auto& hotkey = zoom_hotkeys.at(percent);
            call("input.key_chord", {{"windowRef", window}, {"keys", Json::array({hotkey})}});
            const int settle = profile.value("keySettleMs", 60);
            if (settle) sleep(settle);
            return {{"status", "ok"},
                    {"action", action},
                    {"percent", percent},
                    {"hotkey", hotkey},
                    {"nativeCalls", calls},
                    {"verification", "not_requested"},
                    {"dispatch", "returned"},
                    {"elapsedMs", std::chrono::duration<double, std::milli>(
                                      std::chrono::steady_clock::now() - started)
                                      .count()}};
        }

        if (action == "aseprite.click") {
            phase = "dispatch";
            dispatched = true;
            const int x = a.at("x").get<int>();
            const int y = a.at("y").get<int>();
            if (x >= win_w || y >= win_h)
                throw std::runtime_error("click_point_outside_window");
            Json click_args = {{"windowRef", window},
                               {"coordinateSpace", "window_relative"},
                               {"expectedSize", host.at("bounds")},
                               {"x", x},
                               {"y", y}};
            if (a.contains("button")) click_args["button"] = a.at("button");
            if (a.contains("count")) click_args["count"] = a.at("count");
            call("input.click", click_args);
            const int settle = profile.value("clickSettleMs", 60);
            if (settle) sleep(settle);
            return {{"status", "ok"},
                    {"action", action},
                    {"x", x},
                    {"y", y},
                    {"nativeCalls", calls},
                    {"verification", "not_requested"},
                    {"dispatch", "returned"},
                    {"elapsedMs", std::chrono::duration<double, std::milli>(
                                      std::chrono::steady_clock::now() - started)
                                      .count()}};
        }

        // aseprite.openMenu: capture the top menu strip, OCR it, then click on
        // the matching label.
        phase = "capture";
        const int menu_h = int(std::lround(profile.value("menuBarHeightPx", 30) *
                                          host.value("dpi", 96) / 96.0));
        if (menu_h <= 0 || menu_h > win_h / 2)
            throw std::runtime_error("menu_bar_height_out_of_range");
        auto tmp_dir = std::filesystem::temp_directory_path();
        auto tmp_file = tmp_dir / (L"computer-pilot-aseprite-menu-" +
                                   std::to_wstring(std::chrono::steady_clock::now()
                                                       .time_since_epoch()
                                                       .count()) +
                                   L".png");
        auto strip = call("capture.region",
                          {{"x", win_x}, {"y", win_y}, {"width", win_w}, {"height", menu_h},
                           {"output", utf8(tmp_file.wstring())}, {"method", "screen"}});
        phase = "ocr";
        const auto ocr_dir = resolve_ocr_models(profile);
        // Aseprite's self-drawn menu bar is 10-14 px tall (small pixel font).
        // The default OCR max_side=960 downscales a full-width HD/4K strip to
        // ~350x — text becomes 4-5 px and detection misses everything. Pass a
        // large override so the strip runs at native resolution.
        const int ocrMaxSide = profile.value("ocrMaxSide", 2048);
        auto ocr_result = call("vision.ocr",
                               {{"image", strip.at("path")},
                                {"ocrModels", utf8(ocr_dir.wstring())},
                                {"ocrMaxSide", ocrMaxSide}});
        std::error_code ec;
        std::filesystem::remove(tmp_file, ec); // Best-effort cleanup.

        const auto target = a.at("name").get<std::string>();
        const auto target_lower = lower(target);
        const auto& lines = ocr_result.at("textLines");
        // PP-OCRv4 tends to merge closely spaced menu labels into one detected
        // line ("File Edit Sprite Layer Frame Select View Help"). We scan
        // every line for the target as a case-insensitive substring, then
        // proportionally interpolate the bounding box to estimate the label
        // center. Match with word boundaries so "View" does not match "Preview".
        Json best;
        float best_score = -1;
        int best_center_x = 0, best_center_y = 0;
        for (const auto& line : lines) {
            auto text = line.value("text", std::string{});
            if (text.empty()) continue;
            auto text_lower = lower(text);
            size_t pos = text_lower.find(target_lower);
            if (pos == std::string::npos) continue;
            // Enforce word boundaries: no alpha before/after the match.
            auto is_alpha = [](char c) {
                return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            };
            if (pos > 0 && is_alpha(text[pos - 1])) continue;
            size_t end = pos + target_lower.size();
            if (end < text.size() && is_alpha(text[end])) continue;
            float score = line.value("recognitionScore", 0.0f);
            if (score <= best_score) continue;
            // Estimate the on-screen position: the OCR bounds contain the
            // whole line; the target substring's center sits at position
            // (pos + target/2) / text.size along the bounds width.
            const auto& b = line.at("bounds");
            const int bx = b.at("x").get<int>();
            const int by = b.at("y").get<int>();
            const int bw = b.at("width").get<int>();
            const int bh = b.at("height").get<int>();
            const double frac = (double(pos) + double(target.size()) / 2.0) /
                                double(std::max<size_t>(text.size(), 1));
            best_score = score;
            best_center_x = bx + int(std::lround(bw * frac));
            best_center_y = by + bh / 2;
            best = line;
        }
        if (best.is_null())
            throw std::runtime_error("menu_label_not_found: " + target);
        const double minScore = profile.value("ocrMinScore", 0.4);
        if (best_score < minScore)
            throw std::runtime_error("menu_label_score_below_threshold");
        const Json point = {{"x", best_center_x}, {"y", best_center_y}};

        phase = "click";
        dispatched = true;
        call("input.click",
             {{"windowRef", window},          {"coordinateSpace", "window_relative"},
              {"x", best_center_x},           {"y", best_center_y},
              {"expectedSize", host.at("bounds")}});
        const int settle = profile.value("menuSettleMs", 120);
        if (settle) sleep(settle);
        return {{"status", "ok"},
                {"action", action},
                {"menu", target},
                {"ocrScore", best_score},
                {"clickPoint", point},
                {"nativeCalls", calls},
                {"verification", "ocr_match_and_click_dispatched"},
                {"dispatch", "returned"},
                {"elapsedMs", std::chrono::duration<double, std::milli>(
                                  std::chrono::steady_clock::now() - started)
                                  .count()}};
    } catch (const std::exception& error) {
        return {{"status", "error"},
                {"action", action},
                {"phase", phase},
                {"dispatch", dispatched ? "possibly_partial" : "not_started"},
                {"nativeCalls", calls},
                {"message", error.what()},
                {"retryable", !dispatched}};
    }
}

} // namespace dp
