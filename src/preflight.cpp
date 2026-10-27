#include <desktop_pilot/preflight.hpp>
#include <algorithm>
#include <cctype>

namespace dp {
Json desktop_preflight(const Json& s) {
    if(s.value("platform",std::string{})=="macos") {
        Json reasons=Json::array();
        for(auto key:{"consoleSession","sameUserSession","accessibilityTrusted","screenCaptureAllowed","postEventAllowed"}) {
            if(!s.contains(key)||!s[key].is_boolean())reasons.push_back(std::string(key)+"_unknown");
            else if(!s[key].get<bool>())reasons.push_back(std::string(key)+"_required");
        }
        if(s.value("lockState",std::string("unknown"))!="unlocked")reasons.push_back("session_locked_or_unknown");
        if(s.value("secureInput",true))reasons.push_back("secure_input_enabled");
        bool ready=reasons.empty();
        Json background=Json::array();
        for(auto op:{"system.info","system.session","system.preflight","runtime.capabilities","runtime.describe","action.status","process.list","display.list","window.list","window.get","vision.parse","vision.ocr"})background.push_back(op);
        return {{"executionMode",ready?"interactive":"background_only"},
            {"capabilities",{{"backgroundOperations",background},{"lockedApplicationActions",Json::array()},
                {"lockedApplicationActionsValidation","none_validated"},{"interactive",ready}}},
            {"status",ready?"ready":"blocked"},{"ready",ready},{"attentionRequired",!ready},
            {"code",ready?"desktop_preflight_passed":"desktop_environment_not_ready"},{"reasons",reasons},{"session",s},
            {"message",ready?"macOS console session and desktop permissions are available. Verify target-app acceptance after input.":
                "Interactive desktop actions are paused. Background diagnostics and local image analysis remain available. Unlock the console session or correct desktop permissions before UI input."},
            {"nextAction",ready?"Select the target window, inspect it, act, then verify the visible result.":
                "Inspect reasons. After unlocking, get_window_state again before submitting only unfinished actions. No automatic replay. Restart after permission or launch-context changes."}};
    }
    Json reasons = Json::array();
    auto add = [&](const char* code) { reasons.push_back(code); };
    auto lower = [](std::string v) {
        std::transform(v.begin(), v.end(), v.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        return v;
    };
    auto hasBool = [&](const char* k) { return s.contains(k) && s[k].is_boolean(); };
    auto text = [&](const char* k) { return s.contains(k) && s[k].is_string() ? s[k].get<std::string>() : std::string{}; };
    if (s.value("lockState", std::string("unknown")) == "locked") add("session_locked");
    if (s.contains("sessionId") && s["sessionId"] == 0) add("noninteractive_session");
    if (hasBool("threadOnInputDesktop") && s["threadOnInputDesktop"] == false) add("desktop_mismatch");
    if (hasBool("inputDesktopAccessible") && s["inputDesktopAccessible"] == false) add("input_desktop_unavailable");
    if (!text("threadDesktop").empty() && !text("inputDesktop").empty() &&
        lower(text("threadDesktop")) != lower(text("inputDesktop"))) add("desktop_name_mismatch");
    if (!text("windowStation").empty() && lower(text("windowStation")) != "winsta0") add("noninteractive_window_station");
    if ((hasBool("restrictedToken") && s["restrictedToken"] == true) ||
        (hasBool("threadRestrictedToken") && s["threadRestrictedToken"] == true)) add("restricted_execution_token");
    if (s.contains("jobUiRestrictions") && s["jobUiRestrictions"].is_number_unsigned() &&
        s["jobUiRestrictions"].get<unsigned>() != 0) add("job_ui_restrictions");
    // Integer JSON constructed by clients/tests can be signed as well.
    else if (s.contains("jobUiRestrictions") && s["jobUiRestrictions"].is_number_integer() &&
        s["jobUiRestrictions"].get<int64_t>() != 0) add("job_ui_restrictions");
    bool unknown = !hasBool("threadOnInputDesktop") || !hasBool("inputDesktopAccessible") ||
                   !hasBool("restrictedToken") || text("threadDesktop").empty() ||
                   text("inputDesktop").empty() || text("windowStation").empty() ||
                   !s.contains("sessionId") || !s["sessionId"].is_number_integer() ||
                   (s.contains("inJob") && s["inJob"] == true && !s.contains("jobUiRestrictions"));
    if (unknown) add("desktop_evidence_incomplete");
    bool ready = reasons.empty();
    return {{"status", ready ? "ready" : "blocked"}, {"ready", ready}, {"attentionRequired", !ready},
        {"code", ready ? "desktop_preflight_passed" : "desktop_environment_not_ready"},
        {"reasons", reasons}, {"session", s},
        {"message", ready
            ? "Executor is on the accessible input desktop. This is an environment check, not proof of target-app input acceptance."
            : "STOP desktop actions: the executor is not in a supported interactive desktop environment. Start DesktopPilot in the SAME Windows user session and input desktop as the target app, using a permitted unrestricted launcher. Do not retry clicks or change coordinates."},
        {"nextAction", ready
            ? "Select the target window, inspect it, act, then verify the visible result."
            : "Inspect reasons and session. Unlock/reconnect if needed; correct the host launch context (not automatic elevation or desktop switching), restart the service, run system.preflight, and reacquire references. Read-only diagnostics remain available."}};
}
bool background_operation(const std::string& op) {
    return op=="system.info"||op=="system.session"||op=="system.preflight"||
        op=="runtime.capabilities"||op=="runtime.describe"||op=="action.status"||
        op=="process.list"||op=="display.list"||op=="window.list"||op=="window.get"||
        op=="vision.parse"||op=="vision.ocr";
}
Json desktop_operation_access(const std::string& op,const Json& preflight) {
    const auto s=preflight.value("session",Json::object());
    const bool mac=s.value("platform",std::string{})=="macos";
    if(mac?background_operation(op):!requires_interactive_desktop(op))return Json::object();
    if(preflight.value("ready",false))return Json::object();
    const bool locked=mac&&s.value("lockState",std::string{})=="locked"&&
        s.value("consoleSession",false)&&s.value("sameUserSession",false);
    Json failure={{"status","error"},{"code",locked?"desktop_locked":"desktop_environment_not_ready"},
        {"dispatch","not_started"},{"verification","not_attempted"},
        {"message",preflight.value("message",std::string("Desktop preflight failed"))},{"preflight",preflight}};
    if(mac) {
        failure["paused"]=true;failure["resumeRequiresObservation"]=true;
        failure["next"]="Restore an interactive session, call get_window_state, inspect any prior effects, then submit only unfinished actions. Nothing is automatically replayed.";
    }
    return failure;
}
Json DesktopSessionTracker::observe(const Json& session) {
    Json signature=Json::object();
    for(auto key:{"platform","consoleSession","sameUserSession","lockState","secureInput","accessibilityTrusted","screenCaptureAllowed","postEventAllowed"})
        signature[key]=session.value(key,Json(nullptr));
    if(signature_!=signature){signature_=std::move(signature);++generation_;}
    auto result=session;result["desktopGeneration"]=generation_;return result;
}
bool requires_interactive_desktop(const std::string& op) {
    return op.starts_with("input.") || op == "semantic.perform" || op == "semantic.execute" || op == "app.launch" ||
        op == "clipboard.write" || op == "window.activate" || op == "window.move" ||
        op == "window.resize" || op == "window.close" || op == "window.minimize" ||
        op == "window.maximize" || op == "window.restore" || op == "ui.set_range_value" ||
        op == "ui.click" || op == "ui.invoke" || op == "ui.set_value" || op == "ui.fill" || op == "ui.fill_form" ||
        op == "ui.focus" || op == "ui.select" || op == "ui.toggle" || op == "ui.expand" ||
        op == "ui.collapse" || op == "ui.scroll" || op == "ui.reveal" ||
        op == "ui.message_text" || op == "ui.context_menu";
}
}
