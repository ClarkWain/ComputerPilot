// Mock-driven tests for the aseprite-vision adapter. No real Aseprite or
// OCR runtime is required; the test double replays scripted responses for
// system.session / window.get / capture.region / vision.ocr / input.click.

#include <desktop_pilot/semantic.hpp>
#include <fstream>
#include <iostream>

using dp::Json;
void require(bool ok, const char* message) {
    if (!ok) throw std::runtime_error(message);
}

int main(int argc, char** argv) {
    try {
        require(argc == 2, "profile path required");
        std::ifstream f(argv[1]);
        auto profile = Json::parse(f);
        require(profile.at("adapter") == "aseprite-vision", "wrong adapter under test");
        // Inject a fake OCR path so resolve_ocr_models does not walk the
        // filesystem; the mock intercepts vision.ocr before the path is used.
        profile["ocrModels"] = "C:\\tmp\\fake-ocr-models";

        // Scripted mock state.
        int calls = 0, keySends = 0, clicks = 0, captures = 0, ocrs = 0;
        bool desktopBlocked = false, wrongDpi = false, minimized = false;
        std::string lastKey, phase;
        Json lastClickAt;
        // Simulate PP-OCRv4's actual behavior on the Aseprite menu bar: it
        // merges all labels into one line, then the adapter substring-matches
        // and interpolates a click point along the bounds. Line text is "File
        // Edit Sprite Layer Frame Select View Help" (44 chars) with bounds
        // starting at x=10 in the capture, width=500. Target "View" starts at
        // index 34 (0-based inclusive) so the mock click should land near
        // x = 10 + 500 * ((34 + 4/2) / 44) = 10 + 500 * 36/44 ≈ 419, y = center.
        Json ocrLines = Json::array(
            {{{"text", "File Edit Sprite Layer Frame Select View Help"},
              {"bounds", {{"x", 10}, {"y", 30}, {"width", 500}, {"height", 20}}},
              {"recognitionScore", 0.98}},
             {{"text", "Home"},
              {"bounds", {{"x", 10}, {"y", 60}, {"width", 60}, {"height", 20}}},
              {"recognitionScore", 0.9}}});

        auto mock = [&](const std::string& op, const Json& a) -> Json {
            ++calls;
            if (op == "system.session")
                return {{"inputDesktopAccessible", !desktopBlocked},
                        {"lockState", desktopBlocked ? "locked" : "unlocked"}};
            if (op == "window.get")
                return {{"dpi", wrongDpi ? 200 : 96},
                        {"bounds", {{"x", 100}, {"y", 50}, {"width", 1600}, {"height", 1000}}},
                        {"enabled", true},
                        {"minimized", minimized},
                        {"foreground", true}};
            if (op == "window.activate") return {{"status", "ok"}};
            if (op == "input.key_chord") {
                ++keySends;
                lastKey = a.at("keys")[0].get<std::string>();
                return {{"status", "ok"}};
            }
            if (op == "capture.region") {
                ++captures;
                // Region must sit at window top-left; verify expected inputs.
                require(a.at("x") == 100 && a.at("y") == 50,
                        "capture.region must originate at window top-left");
                require(a.at("width") == 1600, "capture.region width must equal window width");
                require(a.at("height").get<int>() > 0 && a.at("height").get<int>() < 200,
                        "menu strip height sanity");
                return {{"status", "ok"}, {"path", "C:\\tmp\\fake.png"}};
            }
            if (op == "vision.ocr") {
                ++ocrs;
                require(a.at("image") == "C:\\tmp\\fake.png",
                        "vision.ocr must consume the captured strip path");
                require(a.contains("ocrModels"), "vision.ocr must receive an ocrModels path");
                require(a.contains("ocrMaxSide"),
                        "vision.ocr must pass an ocrMaxSide override");
                return {{"status", "ok"}, {"textLines", ocrLines}};
            }
            if (op == "input.click") {
                ++clicks;
                lastClickAt = {{"x", a.at("x")}, {"y", a.at("y")}};
                require(a.at("coordinateSpace") == "window_relative",
                        "menu click must use window_relative");
                return {{"status", "ok"}};
            }
            return {{"status", "ok"}};
        };

        // --- 1. keyChord happy path.
        {
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.keyChord"},
                        {"args", {{"keys", Json::array({"B"})}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "ok" && keySends == 1 && lastKey == "B",
                    "keyChord failed");
        }
        // --- 2. keyChord rejects unknown key without any dispatch.
        {
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.keyChord"},
                        {"args", {{"keys", Json::array({"lowercase"})}}}};
            bool rejected = false;
            try {
                dp::run_semantic(req, profile, mock, [](int) {});
            } catch (const std::invalid_argument&) {
                rejected = true;
            }
            require(rejected, "keyChord accepted invalid key");
        }
        // --- 3. keyChord rejects unsupported extra argument.
        {
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.keyChord"},
                        {"args", {{"keys", Json::array({"B"})}, {"extra", true}}}};
            bool rejected = false;
            try {
                dp::run_semantic(req, profile, mock, [](int) {});
            } catch (const std::invalid_argument&) {
                rejected = true;
            }
            require(rejected, "keyChord accepted extra argument");
        }
        // --- 4. openMenu happy path clicks the OCR-interpolated position.
        {
            captures = ocrs = clicks = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.openMenu"},
                        {"args", {{"name", "View"}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "ok", r.dump().c_str());
            require(captures == 1 && ocrs == 1 && clicks == 1,
                    "openMenu did not follow capture->ocr->click");
            // Line: "File Edit Sprite Layer Frame Select View Help" (45 chars).
            // "View" starts at index 36, target size 4. Fraction = (36+2)/45 =
            // 0.8444. bounds x=10 w=500 → click x = 10 + round(500*38/45) =
            // 10 + 422 = 432. y = 30 + 20/2 = 40.
            require(lastClickAt.at("x") == 432 && lastClickAt.at("y") == 40,
                    "click position does not match substring interpolation");
            require(r.value("ocrScore", 0.0) > 0.5, "score not surfaced");
        }
        // --- 5. openMenu rejects unknown menu name before any dispatch.
        {
            captures = ocrs = clicks = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.openMenu"},
                        {"args", {{"name", "Bogus"}}}};
            bool rejected = false;
            try {
                dp::run_semantic(req, profile, mock, [](int) {});
            } catch (const std::invalid_argument&) {
                rejected = true;
            }
            require(rejected && captures == 0 && ocrs == 0 && clicks == 0,
                    "unknown menu produced side effects");
        }
        // --- 6. openMenu reports error when target not seen in OCR output.
        {
            auto save = ocrLines;
            ocrLines = Json::array({{{"text", "unrelated"},
                                     {"bounds",
                                      {{"x", 10}, {"y", 8}, {"width", 40}, {"height", 18}}},
                                     {"recognitionScore", 0.9}}});
            captures = ocrs = clicks = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.openMenu"},
                        {"args", {{"name", "View"}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "error" && clicks == 0 &&
                        std::string(r.at("message")).find("menu_label_not_found") !=
                            std::string::npos,
                    "missing OCR match should not click");
            ocrLines = save;
        }
        // --- 7. Refuses to run when interactive desktop is blocked.
        {
            desktopBlocked = true;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.keyChord"},
                        {"args", {{"keys", Json::array({"B"})}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "error" && r.at("dispatch") == "not_started",
                    "locked desktop must not dispatch input");
            desktopBlocked = false;
        }
        // --- 8. Refuses to run when DPI unsupported by profile.
        {
            wrongDpi = true;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.keyChord"},
                        {"args", {{"keys", Json::array({"B"})}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "error" && r.at("dispatch") == "not_started",
                    "mismatched DPI must not dispatch");
            wrongDpi = false;
        }
        // --- 9. Unsupported action fails validation.
        {
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.drawPixel"},
                        {"args", Json::object()}};
            bool rejected = false;
            try {
                dp::run_semantic(req, profile, mock, [](int) {});
            } catch (const std::invalid_argument&) {
                rejected = true;
            }
            require(rejected, "unimplemented action must be rejected");
        }
        // --- 10. selectTool dispatches the mapped hotkey.
        {
            keySends = 0;
            lastKey.clear();
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.selectTool"},
                        {"args", {{"tool", "paintBucket"}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "ok" && keySends == 1 && lastKey == "G",
                    "selectTool paintBucket must press G");
            require(r.value("hotkey", std::string{}) == "G",
                    "selectTool must surface hotkey");
        }
        // --- 11. selectTool rejects unknown tool without dispatch.
        {
            keySends = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.selectTool"},
                        {"args", {{"tool", "airbrush"}}}};
            bool rejected = false;
            try {
                dp::run_semantic(req, profile, mock, [](int) {});
            } catch (const std::invalid_argument&) {
                rejected = true;
            }
            require(rejected && keySends == 0, "unknown tool must not dispatch");
        }
        // --- 12. zoom dispatches the mapped hotkey.
        {
            keySends = 0;
            lastKey.clear();
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.zoom"},
                        {"args", {{"percent", 400}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "ok" && keySends == 1 && lastKey == "3",
                    "zoom 400% must press 3");
            require(r.value("percent", 0) == 400, "zoom must surface percent");
        }
        // --- 13. zoom rejects unsupported percent without dispatch.
        {
            keySends = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.zoom"},
                        {"args", {{"percent", 150}}}};
            bool rejected = false;
            try {
                dp::run_semantic(req, profile, mock, [](int) {});
            } catch (const std::invalid_argument&) {
                rejected = true;
            }
            require(rejected && keySends == 0, "unsupported zoom must not dispatch");
        }
        // --- 14. click passes window-relative coordinates through.
        {
            clicks = 0;
            lastClickAt = Json();
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.click"},
                        {"args", {{"x", 1230}, {"y", 920}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "ok" && clicks == 1,
                    "click must dispatch a single input.click");
            require(lastClickAt.at("x") == 1230 && lastClickAt.at("y") == 920,
                    "click coordinates must pass through unchanged");
        }
        // --- 15. click rejects out-of-window coordinates without dispatch.
        {
            clicks = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.click"},
                        {"args", {{"x", 5000}, {"y", 100}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "error" && clicks == 0 &&
                        std::string(r.at("message")).find("click_point_outside_window") !=
                            std::string::npos,
                    "out-of-window click must be rejected before dispatch");
        }
        // --- 16. click accepts button and count overrides.
        {
            clicks = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.click"},
                        {"args", {{"x", 500}, {"y", 400}, {"button", "right"}, {"count", 2}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "ok" && clicks == 1, "double right-click must dispatch");
        }
        std::cout << "aseprite-vision tests passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
