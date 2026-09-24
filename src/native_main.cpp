#include <desktop_pilot/desktop.hpp>
#include <desktop_pilot/preflight.hpp>
#include <algorithm>
#include <fcntl.h>
#include <io.h>
#include <iostream>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>
#include <windows.h>

namespace {
using dp::Json;

// Keep one Desktop on this thread: its UIA references and COM apartment cannot
// be transferred to another request thread. The Node parent owns timeouts.
Json inspect_environment(dp::Desktop& desktop) {
    return dp::desktop_preflight(desktop.execute("system.session", Json::object()));
}

bool needs_desktop(const std::string& operation) {
    return dp::requires_interactive_desktop(operation) ||
        operation == "window.prepare" || operation == "ui.click";
}

Json native_operations() {
    auto operations = dp::Desktop::operations();
    // Single-control click/fill/message_text stay native: their UIA/Win32
    // fallback, selection and readback depend on platform behavior. A form
    // spanning multiple controls belongs in Node orchestration.
    const std::set<std::string> orchestrated = {
        "ui.fill_form", "runtime.capabilities"
    };
    operations.erase(std::remove_if(operations.begin(), operations.end(),
        [&](const Json& operation) { return orchestrated.contains(operation.get<std::string>()); }), operations.end());
    operations.push_back("system.preflight");
    return operations;
}

Json error_response(const Json& id, const std::string& code, const std::string& message) {
    return {{"id", id}, {"error", {{"code", code}, {"message", message}}}};
}

DWORD process_integrity_rid(DWORD pid) {
    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process) throw std::runtime_error("OpenProcess for target integrity failed: " + std::to_string(GetLastError()));
    struct ProcessGuard { HANDLE handle; ~ProcessGuard() { CloseHandle(handle); } } processGuard{process};
    HANDLE token = nullptr;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token))
        throw std::runtime_error("OpenProcessToken for target integrity failed: " + std::to_string(GetLastError()));
    ProcessGuard tokenGuard{token};
    DWORD bytes = 0;
    GetTokenInformation(token, TokenIntegrityLevel, nullptr, 0, &bytes);
    if (!bytes) throw std::runtime_error("Target integrity size unavailable: " + std::to_string(GetLastError()));
    std::vector<BYTE> buffer(bytes);
    if (!GetTokenInformation(token, TokenIntegrityLevel, buffer.data(), bytes, &bytes))
        throw std::runtime_error("Target integrity unavailable: " + std::to_string(GetLastError()));
    const auto sid = reinterpret_cast<TOKEN_MANDATORY_LABEL*>(buffer.data())->Label.Sid;
    if (!IsValidSid(sid) || *GetSidSubAuthorityCount(sid) == 0)
        throw std::runtime_error("Target integrity SID is invalid");
    return *GetSidSubAuthority(sid, *GetSidSubAuthorityCount(sid) - 1);
}

std::vector<DWORD> input_target_pids(dp::Desktop& desktop, const std::string& operation, const Json& args) {
    // Clipboard and process launch have no existing target window to compare.
    if (operation == "clipboard.write" || operation == "app.launch") return {};
    std::vector<DWORD> pids;
    auto add = [&](const Json& row) {
        if (!row.is_object() || !row.contains("pid") || !row["pid"].is_number_integer())
            throw std::runtime_error("Target process identity unavailable");
        const auto rawPid = row["pid"].get<int64_t>();
        if (rawPid <= 0 || rawPid > UINT32_MAX)
            throw std::runtime_error("Target process identity unavailable");
        const DWORD pid = static_cast<DWORD>(rawPid);
        if (std::find(pids.begin(), pids.end(), pid) == pids.end()) pids.push_back(pid);
    };
    if (args.contains("windowRef"))
        add(desktop.execute("window.get", {{"windowRef", args["windowRef"]}}));
    if (args.contains("elementRef"))
        add(desktop.execute("ui.get", {{"elementRef", args["elementRef"]}}));
    if (pids.empty() && operation.starts_with("input.")) {
        if (args.value("coordinateSpace", std::string("screen_physical")) != "screen_physical")
            throw std::invalid_argument("Relative input requires windowRef");
        auto at_point = [&](LONG x, LONG y) {
            const HWND child = WindowFromPoint({x, y});
            const HWND target = child ? GetAncestor(child, GA_ROOT) : nullptr;
            DWORD pid = 0;
            if (target) GetWindowThreadProcessId(target, &pid);
            if (!pid) throw std::runtime_error("Target under input point unavailable");
            if (std::find(pids.begin(), pids.end(), pid) == pids.end()) pids.push_back(pid);
        };
        if (operation == "input.click" || operation == "input.drag" || operation == "input.move") {
            if (args.contains("points")) {
                for (const auto& pair : args["points"])
                    at_point(pair.at(0).get<LONG>(), pair.at(1).get<LONG>());
            } else {
                at_point(args.at("x").get<LONG>(), args.at("y").get<LONG>());
                if (operation == "input.drag")
                    at_point(args.at("toX").get<LONG>(), args.at("toY").get<LONG>());
            }
        } else if (operation == "input.scroll") {
            POINT cursor{};
            if (!GetCursorPos(&cursor)) throw std::runtime_error("Cursor position unavailable");
            at_point(cursor.x, cursor.y);
        } else {
            add(desktop.execute("window.foreground", Json::object()));
        }
    }
    if (pids.empty() && operation.starts_with("ui."))
        add(desktop.execute("window.foreground", Json::object()));
    return pids;
}

Json dispatch(dp::Desktop& desktop, const Json& request, const Json& operations) {
    Json id = nullptr;
    if (request.is_object() && request.contains("id")) id = request["id"];
    if (!request.is_object() || !request.contains("id") ||
        !(id.is_string() || id.is_number_integer()) ||
        !request.contains("operation") || !request["operation"].is_string() ||
        !request.contains("args") || !request["args"].is_object())
        return error_response(id, "invalid_request", "Expected {id,operation,args}; id must be a string or integer, args an object");

    const auto operation = request["operation"].get<std::string>();
    auto failed_operation = [&](const std::string& code, const std::string& message) {
        auto response = error_response(id, code, message);
        // An exception after dispatch does not prove that no input was sent.
        if (needs_desktop(operation)) response["error"]["dispatch"] = "possibly_partial";
        return response;
    };
    try {
        if (operation == "native.hello") {
            return {{"id", id}, {"result", {{"protocolVersion", 1},
                {"operations", operations}, {"processId", GetCurrentProcessId()},
                {"preflight", inspect_environment(desktop)}}}};
        }
        if (std::find(operations.begin(), operations.end(), operation) == operations.end())
            return error_response(id, "unknown_operation", "Unknown native platform operation: " + operation);

        if (operation == "system.preflight")
            return {{"id", id}, {"result", inspect_environment(desktop)}};

        if (needs_desktop(operation)) {
            const auto preflight = inspect_environment(desktop);
            if (!preflight.value("ready", false)) {
                auto response = error_response(id, "desktop_environment_not_ready",
                    preflight.value("message", std::string("Desktop preflight failed")));
                response["error"]["dispatch"] = "not_started";
                response["error"]["preflight"] = preflight;
                return response;
            }
            try {
                const auto& session = preflight.at("session");
                if (!session.contains("integrityRid") || !session["integrityRid"].is_number_integer())
                    throw std::runtime_error("Worker integrity level unavailable");
                const DWORD workerRid = session["integrityRid"].get<DWORD>();
                const bool uiAccess = session.value("uiAccess", 0) != 0;
                for (const DWORD pid : input_target_pids(desktop, operation, request["args"])) {
                    const DWORD targetRid = process_integrity_rid(pid);
                    if (targetRid > workerRid && !uiAccess) {
                        auto response = error_response(id, "target_integrity_higher",
                            "Target window has a higher integrity level than this worker; start the worker in an appropriate user context");
                        response["error"]["dispatch"] = "not_started";
                        response["error"]["workerIntegrityRid"] = workerRid;
                        response["error"]["targetIntegrityRid"] = targetRid;
                        response["error"]["targetPid"] = pid;
                        return response;
                    }
                }
            } catch (const std::invalid_argument& error) {
                auto response = error_response(id, "target_reference_invalid", error.what());
                response["error"]["dispatch"] = "not_started";
                return response;
            } catch (const std::exception& error) {
                auto response = error_response(id, "target_integrity_unavailable", error.what());
                response["error"]["dispatch"] = "not_started";
                return response;
            }
        }
        return {{"id", id}, {"result", desktop.execute(operation, request["args"])}};
    } catch (const std::invalid_argument& error) {
        return failed_operation("invalid_arguments", error.what());
    } catch (const Json::exception& error) {
        return failed_operation("invalid_arguments", error.what());
    } catch (const std::exception& error) {
        return failed_operation("platform_operation_failed", error.what());
    }
}
}

int main() {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    try {
        dp::Desktop desktop;
        const auto operations = native_operations();
        const auto startup = inspect_environment(desktop);
        if (!startup.value("ready", false))
            std::cerr << "DesktopPilot native desktop unavailable: " << dp::dump_json(startup) << '\n';
        std::string line;
        while (std::getline(std::cin, line)) {
            Json response;
            try {
                response = dispatch(desktop, Json::parse(line), operations);
            } catch (const Json::parse_error& error) {
                response = error_response(nullptr, "invalid_json", error.what());
            } catch (const std::exception& error) {
                response = error_response(nullptr, "native_request_failed", error.what());
            }
            std::cout << dp::dump_json(response) << '\n' << std::flush;
        }
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "DesktopPilot native startup failed: " << error.what() << '\n';
        return 1;
    }
}
