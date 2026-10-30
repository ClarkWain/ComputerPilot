#include <desktop_pilot/preflight.hpp>
#include <algorithm>
#include <cctype>

namespace dp {
Json desktop_preflight(const Json& s) {
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
            : "Inspect reasons and session. Unlock/reconnect if needed; correct the host launch context (not automatic elevation or desktop switching), reconnect MCP and check its startup desktopPreflight, then call list_windows and inspect the target again. Read-only diagnostics may remain available."}};
}
bool requires_interactive_desktop(const std::string& op) {
    return op.starts_with("input.") || op == "semantic.perform" || op == "semantic.execute" || op == "app.launch" ||
        op == "clipboard.write" || op == "window.activate" || op == "window.move" ||
        op == "window.resize" || op == "window.close" || op == "window.minimize" ||
        op == "window.maximize" || op == "window.restore" || op == "ui.set_range_value" ||
        op == "ui.invoke" || op == "ui.set_value" || op == "ui.fill" || op == "ui.fill_form" ||
        op == "ui.focus" || op == "ui.select" || op == "ui.toggle" || op == "ui.expand" ||
        op == "ui.collapse" || op == "ui.scroll" || op == "ui.reveal" ||
        op == "ui.message_text" || op == "ui.context_menu";
}
}
