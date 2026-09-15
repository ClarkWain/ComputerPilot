#pragma once
#include <desktop_pilot/core.hpp>
#include <chrono>
#include <functional>
#include <set>

namespace dp {
inline Json fill_form(const Json& args,
                     const std::function<Json(const std::string&, const Json&)>& call,
                     const std::function<void(int)>& sleep) {
    const auto started = std::chrono::steady_clock::now();
    const auto& fields = args.at("fields");
    const int timeout = args.value("verifyTimeoutMs", 8000);
    if (!fields.is_array() || fields.empty() || fields.size() > 32 || timeout < 0 || timeout > 60000)
        throw std::invalid_argument("Expected 1..32 fields and verifyTimeoutMs in 0..60000");
    Json targets = Json::array();
    std::set<std::string> refs;
    // Resolve all selectors before changing any field or clipboard.
    for (const auto& field : fields) {
        const auto text = field.at("text").get<std::string>();
        if (text.find('\0') != std::string::npos) throw std::invalid_argument("Text contains NUL");
        std::string ref;
        if (field.contains("elementRef")) ref = field.at("elementRef").get<std::string>();
        else {
            auto query = field.at("query");
            query["limit"] = 2;
            query["offset"] = 0;
            query["stopAfterLimit"] = true;
            query["format"] = "compact";
            const auto found = call("ui.find", query);
            if (found.value("truncated", false) || !found.contains("uniqueRef") || found["uniqueRef"].is_null())
                throw std::runtime_error("Field selector is not uniquely resolved");
            ref = found["uniqueRef"].get<std::string>();
        }
        if (!refs.insert(ref).second) throw std::invalid_argument("Duplicate field target");
        const auto current = call("ui.get", {{"elementRef", ref}});
        if (!current.contains("value") || !current["value"].is_string())
            throw std::runtime_error("Field does not expose a readable value");
        targets.push_back({{"elementRef", ref}, {"text", text}});
    }
    auto checked = [&](const std::string& op, const Json& a) {
        auto r = call(op, a);
        if (r.value("status", std::string{}) == "error" || r.value("status", std::string{}) == "partial")
            throw std::runtime_error("Form operation failed: " + op);
        return r;
    };
    const auto clipboard = checked("clipboard.read", Json::object());
    if (!clipboard.contains("text") || !clipboard["text"].is_string())
        throw std::runtime_error("Text clipboard unavailable; no changes made");
    Json result = {{"status", "ok"}, {"verified", 0}, {"clipboardRestored", false}, {"clipboardScope", "text"}};
    try {
        for (const auto& field : targets) {
            const Json target = {{"elementRef", field["elementRef"]}};
            // Matching fields are not written again on a resumed request.
            if (checked("ui.get", target).at("value") != field["text"]) {
                checked("clipboard.write", {{"text", field["text"]}});
                checked("ui.focus", target);
                sleep(200);
                checked("input.key_chord", {{"keys", {"CTRL", "A"}}});
                sleep(150);
                checked("input.key_chord", {{"keys", {"CTRL", "V"}}});
                sleep(1000);
                const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout);
                while (checked("ui.get", target).at("value") != field["text"]) {
                    if (std::chrono::steady_clock::now() >= until)
                        throw std::runtime_error("Field verification timed out; inspect before retry");
                    sleep(100);
                }
            }
            result["verified"] = result["verified"].get<size_t>() + 1;
        }
    } catch (const std::exception& e) {
        result["status"] = "partial";
        result["failedField"] = result["verified"];
        result["message"] = e.what();
    }
    try {
        checked("clipboard.write", {{"text", clipboard["text"]}});
        result["clipboardRestored"] = true;
    } catch (const std::exception& e) {
        result["status"] = "partial";
        result["cleanupError"] = e.what();
    }
    result["elapsedMs"] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    return result;
}
}
