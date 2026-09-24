#include <chrono>
#include <desktop_pilot/detector.hpp>
#include <desktop_pilot/ocr.hpp>
#include <desktop_pilot/service.hpp>
#include <desktop_pilot/worker.hpp>
#include <desktop_pilot/preflight.hpp>
#include <desktop_pilot/agent_api.hpp>
#include <iostream>
#include <fstream>
#include <map>
#include <thread>
#include <condition_variable>
#include <deque>
#include <functional>
#include <mutex>
#include <set>

namespace dp {
namespace {
std::string base64_file(const std::string &file) {
    std::ifstream stream(std::filesystem::u8path(file), std::ios::binary);
    if (!stream)
        throw std::runtime_error("Cannot open captured image");
    std::string input((std::istreambuf_iterator<char>(stream)), {}), output;
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    for (size_t n = 0; n < input.size(); n += 3) {
        unsigned bits = static_cast<unsigned char>(input[n]) << 16;
        if (n + 1 < input.size())
            bits |= static_cast<unsigned char>(input[n + 1]) << 8;
        if (n + 2 < input.size())
            bits |= static_cast<unsigned char>(input[n + 2]);
        output += alphabet[(bits >> 18) & 63];
        output += alphabet[(bits >> 12) & 63];
        output += n + 1 < input.size() ? alphabet[(bits >> 6) & 63] : '=';
        output += n + 2 < input.size() ? alphabet[bits & 63] : '=';
    }
    return output;
}
Json tool_list() { return AgentApi::tools(); }
using Dispatch = std::function<Json(const std::string &, const Json &)>;
Json call(AgentApi& agent,const Dispatch& dispatch,const std::string& name,const Json& args,const std::function<void()>& checkCancelled) {
    checkCancelled();return agent.call(name,args,dispatch);
}
} // namespace
int serve(bool mcp) {
    AgentApi agent;
    std::unique_ptr<Service> local;
    std::unique_ptr<Worker> worker;
    if (mcp)
        worker = std::make_unique<Worker>();
    else
        local = std::make_unique<Service>();
    auto inspectEnvironment = [&]() -> Json {
        try {
            auto result = mcp ? worker->execute("system.preflight", Json::object())
                             : local->execute("system.preflight", Json::object());
            if (result.contains("ready") && result["ready"].is_boolean()) return result;
            auto failure = desktop_preflight(Json::object());
            failure["diagnosticError"] = result;
            return failure;
        } catch (const std::exception& e) {
            auto result = desktop_preflight(Json::object());
            result["diagnosticError"] = e.what();
            return result;
        }
    };
    const auto startupEnvironment = inspectEnvironment();
    if (!startupEnvironment.value("ready", false))
        std::cerr << "DesktopPilot DESKTOP ENVIRONMENT ERROR: " << dump_json(startupEnvironment) << '\n' << std::flush;
    std::mutex queue_mutex, output_mutex;
    std::condition_variable arrived;
    std::deque<std::string> queue;
    bool eof = false;
    Json active_id = nullptr;
    std::set<std::string> cancelled_ids;
    auto checkCancelled = [&] {
        {
            std::lock_guard lock(queue_mutex);
            if (cancelled_ids.contains(active_id.dump()))
                throw std::runtime_error("Request cancelled; remaining steps not dispatched");
        }
    };
    // One fresh check per RPC/batch, not per pixel. The worker also checks each
    // native request, so a restart or a desktop transition is not hidden by this cache.
    Json requestEnvironment;
    Dispatch dispatch = [&](const std::string &op, const Json &args) {
        checkCancelled();
        if (requires_interactive_desktop(op)) {
            if (requestEnvironment.is_null()) requestEnvironment = inspectEnvironment();
            if (!requestEnvironment.value("ready", false))
                return Json{{"status", "error"}, {"code", "desktop_environment_not_ready"},
                    {"dispatch", "not_started"}, {"verification", "not_attempted"},
                    {"message", requestEnvironment.value("message", std::string("Desktop preflight failed"))},
                    {"preflight", requestEnvironment}};
        }
        return mcp ? worker->execute(op, args) : local->execute(op, args);
    };
    auto emit = [&](const Json &response) {
        std::lock_guard lock(output_mutex);
        std::cout << dump_json(response) << '\n' << std::flush;
    };
    std::thread reader([&] {
        std::string input;
        while (std::getline(std::cin, input)) {
            if (mcp)
                try {
                    auto message = Json::parse(input);
                    if (message.value("jsonrpc", std::string{}) == "2.0") {
                        auto method = message.value("method", std::string{});
                        if (method == "ping" && message.contains("id")) {
                            emit({{"jsonrpc", "2.0"}, {"id", message["id"]}, {"result", Json::object()}});
                            continue;
                        }
                        bool notification = method == "notifications/cancelled";
                        auto params = message.value("params", Json::object());
                        if (notification) {
                            Json target=params.value("requestId",Json(nullptr));
                            {
                                std::lock_guard lock(queue_mutex);
                                if (target.is_null())
                                    target = active_id;
                                bool pending = !target.is_null() && target == active_id;
                                for (const auto &queued : queue)
                                    try {
                                        if (Json::parse(queued).value("id", Json(nullptr)) == target &&
                                            !target.is_null())
                                            pending = true;
                                    } catch (...) {
                                    }
                                if (pending)
                                    cancelled_ids.insert(target.dump());
                                if (target == active_id && !active_id.is_null())
                                    worker->cancel();
                            }
                            continue;
                        }
                    }
                } catch (...) { /* Normal parser returns the protocol error on the worker thread. */
                }
            {
                std::lock_guard lock(queue_mutex);
                queue.push_back(std::move(input));
            }
            arrived.notify_one();
        }
        {
            std::lock_guard lock(queue_mutex);
            eof = true;
        }
        arrived.notify_one();
    });
    bool initialized = false, ready = false;
    std::string line;
    while (true) {
        {
            std::unique_lock lock(queue_mutex);
            arrived.wait(lock, [&] { return eof || !queue.empty(); });
            if (queue.empty())
                break;
            line = std::move(queue.front());
            queue.pop_front();
        }
        Json request, id = nullptr, response;
        requestEnvironment = nullptr;
        try {
            request = Json::parse(line);
            if (!request.is_object())
                throw std::invalid_argument("Request must be an object");
            id = request.value("id", Json(nullptr));
            {
                std::lock_guard lock(queue_mutex);
                active_id = id;
                if (worker)
                    worker->reset_cancel();
                if (cancelled_ids.contains(id.dump()))
                    throw std::runtime_error("Request cancelled before execution");
            }
            if (!mcp) {
                auto result = dispatch(request.at("operation"), request.value("args", Json::object()));
                response = {{"id", id}, {"result", result}};
            } else {
                if (request.value("jsonrpc", std::string{}) != "2.0")
                    throw std::invalid_argument("jsonrpc must be 2.0");
                auto method = request.at("method").get<std::string>();
                if (!request.contains("id")) {
                    if (method == "notifications/initialized" && initialized)
                        ready = true;
                    continue;
                }
                Json result;
                if (method == "initialize") {
                    if (initialized)
                        throw std::invalid_argument("Already initialized");
                    initialized = true;
                    result = {{"protocolVersion", "2025-06-18"},
                              {"capabilities", {{"tools", {{"listChanged", false}}}}},
                              {"serverInfo", {{"name", "desktop-pilot"}, {"version", "0.4.0"}}},
                              {"instructions",
                               "DESKTOP PREREQUISITE: DesktopPilot must run in the SAME Windows session and input desktop as the target app, without restricted execution tokens. "
                               "If desktopPreflight.ready is false, stop UI actions and fix the launch context; never keep retrying clicks. "
                               "Use list_windows, get_window_state, then execute_semantic for a matching profile or execute_batch for basic input. Observe the result. Focus and state bookkeeping are automatic. "
                               "Profiles and their action examples are returned for the actual window; do not guess profile support. "
                               "References are session-local. Dispatch success is not visible-result verification. "
                               "Startup desktopPreflight: " + dump_json(Json{{"ready", startupEnvironment["ready"]},
                                   {"reasons", startupEnvironment["reasons"]}, {"nextAction", startupEnvironment["nextAction"]}})},
                              {"_meta", {{"desktopPilot/desktopPreflight", startupEnvironment}}}};
                } else if (method == "ping")
                    result = Json::object();
                else if (!ready)
                    throw std::invalid_argument("Initialize and send notifications/initialized first");
                else if (method == "tools/list")
                    result = {{"tools", tool_list()}};
                else if (method == "tools/call") {
                    auto params = request.at("params");
                    auto name = params.at("name").get<std::string>();
                    bool exists = false;
                    for (auto &t : tool_list())
                        if (t["name"] == name)
                            exists = true;
                    if (!exists) {
                        response = {{"jsonrpc", "2.0"},
                                    {"id", id},
                                    {"error", {{"code", -32602}, {"message", "Unknown tool"}}}};
                    } else {
                        try {
                            auto value = call(agent, dispatch, name, params.value("arguments", Json::object()), checkCancelled);
                            result = {
                                {"content", Json::array()},
                                {"structuredContent", value},
                                {"isError",
                                 operation_failed(value)}};
                            if (name=="get_window_state" || name=="execute_semantic") {
                                Json detail=value;
                                for(int depth=0;depth<8 && detail.contains("failure");++depth)detail=Json(detail["failure"]);
                                Json captured=detail.contains("capture")?detail["capture"]:detail;
                                if (captured.contains("path") && captured.contains("imageRef") &&
                                    captured.value("delivery",std::string("inline"))=="inline")
                                    result["content"].push_back(
                                        {{"type", "image"},
                                         {"mimeType", captured.value("mimeType",std::string("image/png"))},
                                         {"data", base64_file(captured["path"].get<std::string>())}});
                            }
                        } catch (const std::exception &e) {
                            Json error = {{"status", "error"}, {"message", e.what()}};
                            result = {
                                {"content", Json::array()},
                                {"structuredContent", error},
                                {"isError", true}};
                        }
                    }
                } else {
                    response = {{"jsonrpc", "2.0"},
                                {"id", id},
                                {"error", {{"code", -32601}, {"message", "Method not found"}}}};
                }
                if (response.is_null())
                    response = {{"jsonrpc", "2.0"}, {"id", id}, {"result", result}};
            }
        } catch (const Json::parse_error &e) {
            response = {{"id", nullptr}, {"error", {{"code", -32700}, {"message", e.what()}}}};
            if (mcp)
                response["jsonrpc"] = "2.0";
        } catch (const std::exception &e) {
            response = {{"id", id}, {"error", {{"code", -32602}, {"message", e.what()}}}};
            if (mcp)
                response["jsonrpc"] = "2.0";
        }
        emit(response);
        {
            std::lock_guard lock(queue_mutex);
            cancelled_ids.erase(id.dump());
            active_id = nullptr;
        }
    }
    reader.join();
    return 0;
}
} // namespace dp
