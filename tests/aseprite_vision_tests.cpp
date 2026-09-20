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
        // Fake OCR output: "View" at (400, 8) 40x18 in strip coords.
        Json ocrLines = Json::array(
            {{{"text", "File"}, {"bounds", {{"x", 40}, {"y", 8}, {"width", 30}, {"height", 18}}},
              {"recognitionScore", 0.92}},
             {{"text", "View"}, {"bounds", {{"x", 400}, {"y", 8}, {"width", 40}, {"height", 18}}},
              {"recognitionScore", 0.88}},
             {{"text", "junk"}, {"bounds", {{"x", 800}, {"y", 8}, {"width", 40}, {"height", 18}}},
              {"recognitionScore", 0.2}}});

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
        // --- 4. openMenu happy path clicks the OCR-located label.
        {
            captures = ocrs = clicks = 0;
            Json req = {{"windowRef", "w1"},
                        {"action", "aseprite.openMenu"},
                        {"args", {{"name", "View"}}}};
            auto r = dp::run_semantic(req, profile, mock, [](int) {});
            require(r.at("status") == "ok", r.dump().c_str());
            require(captures == 1 && ocrs == 1 && clicks == 1,
                    "openMenu did not follow capture->ocr->click");
            // Expected click: center of View bounds = 400+40/2=420, 8+18/2=17.
            require(lastClickAt.at("x") == 420 && lastClickAt.at("y") == 17,
                    "click point does not match OCR bounds center");
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
        std::cout << "aseprite-vision tests passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
