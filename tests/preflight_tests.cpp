#include <desktop_pilot/preflight.hpp>
#include <iostream>
#include <stdexcept>
using namespace dp;
int main() {
    int checks = 0;
    auto require = [&](bool yes, const char* message) { ++checks; if (!yes) throw std::runtime_error(message); };
    try {
        Json good = {{"sessionId", 2}, {"lockState", "unlocked"}, {"threadDesktop", "Default"},
            {"inputDesktop", "default"}, {"windowStation", "WinSta0"}, {"threadOnInputDesktop", true},
            {"inputDesktopAccessible", true}, {"restrictedToken", false}, {"jobUiRestrictions", 0}};
        require(desktop_preflight(good)["ready"] == true, "interactive session must pass");
        auto isolated = good; isolated["threadDesktop"] = "CodexSandboxDesktop"; isolated["threadOnInputDesktop"] = false;
        require(desktop_preflight(isolated)["ready"] == false, "isolated desktop must fail");
        auto restricted = good; restricted["restrictedToken"] = true;
        require(desktop_preflight(restricted)["ready"] == false, "same desktop with restricted token must fail");
        auto locked = good; locked["lockState"] = "locked";
        require(desktop_preflight(locked)["ready"] == false, "locked must fail even if stale desktop name matches");
        auto unknown = good; unknown["threadOnInputDesktop"] = nullptr;
        require(desktop_preflight(unknown)["ready"] == false, "unknown cannot count as ready");
        auto service = good; service["sessionId"] = 0;
        require(desktop_preflight(service)["ready"] == false, "service session must fail");
        auto inaccessible = good; inaccessible["inputDesktopAccessible"] = false;
        require(desktop_preflight(inaccessible)["ready"] == false, "input desktop inaccessible must fail");
        auto job = good; job["jobUiRestrictions"] = 1;
        require(desktop_preflight(job)["ready"] == false, "job UI restrictions must fail");
        // RDP session IDs need not equal the physical console session ID.
        auto rdp = good; rdp["sessionId"] = 8;
        require(desktop_preflight(rdp)["ready"] == true, "interactive RDP must not be rejected by session id");
        require(desktop_preflight(Json::object())["attentionRequired"] == true, "empty evidence needs attention");
        require(requires_interactive_desktop("input.drag"), "drag must be checked");
        require(requires_interactive_desktop("semantic.perform"), "semantic wrapper must be checked");
        require(requires_interactive_desktop("ui.fill_form"), "form must be checked");
        require(!requires_interactive_desktop("system.session"), "diagnostics remain available");
        require(!requires_interactive_desktop("capture.window"), "diagnostic capture remains available");
        Json mac={{"platform","macos"},{"consoleSession",true},{"sameUserSession",true},
            {"accessibilityTrusted",true},{"screenCaptureAllowed",true},{"postEventAllowed",true},
            {"lockState","unlocked"},{"secureInput",false}};
        require(desktop_preflight(mac)["ready"]==true,"macOS granted console session must pass");
        for(auto key:{"consoleSession","sameUserSession","accessibilityTrusted","screenCaptureAllowed","postEventAllowed"}) {
            auto denied=mac;denied[key]=false;require(desktop_preflight(denied)["ready"]==false,"missing macOS permission/session must block");
            denied.erase(key);require(desktop_preflight(denied)["ready"]==false,"unknown macOS permission must block");
        }
        auto secure=mac;secure["secureInput"]=true;require(desktop_preflight(secure)["ready"]==false,"Secure Input must block");
        auto macLocked=mac;macLocked["lockState"]="locked";require(desktop_preflight(macLocked)["ready"]==false,"macOS lock must block");
        macLocked.erase("lockState");require(desktop_preflight(macLocked)["ready"]==false,"unknown macOS lock must block");
        std::cout << "PASS checks=" << checks << '\n';
        return 0;
    } catch(const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
