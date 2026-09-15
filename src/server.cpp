#include <chrono>
#include <desktop_pilot/detector.hpp>
#include <desktop_pilot/ocr.hpp>
#include <desktop_pilot/service.hpp>
#include <desktop_pilot/worker.hpp>
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
Json resolve_step_refs(const Json &value, const std::map<std::string, Json> &steps) {
    if (value.is_object() && value.contains("fromStep")) {
        auto id = value.at("fromStep").get<std::string>();
        auto found = steps.find(id);
        if (found == steps.end())
            throw std::invalid_argument("Missing earlier step: " + id);
        return found->second.at(Json::json_pointer(value.value("path", std::string{})));
    }
    Json result = value;
    if (result.is_array() || result.is_object())
        for (auto &child : result)
            child = resolve_step_refs(child, steps);
    return result;
}
std::string base64_file(const std::string &file) {
    std::ifstream stream(std::filesystem::u8path(file), std::ios::binary);
    if (!stream)
        throw std::runtime_error("Cannot open captured PNG");
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
Json tool_list() {
    Json rows = Json::array();
    for (auto &[name, description] : std::map<std::string, std::string>{
             {"computer_inspect",
              "Read desktop/window/UIA state. operation and args use the registry from computer_runtime."},
             {"computer_query", "Run a read-only registry operation. Use session-local windowRef/elementRef "
                                "from previous results. UI queries support format:compact, stopAfterLimit, queryTimeoutMs and metrics."},
             {"computer_act", "Execute one native desktop action. Coordinates are physical virtual-screen "
                              "pixels. ui.fill replaces and verifies text with a compact receipt; args: elementRef, text, method:auto/value/keyboard, timeoutMs. Returns dispatch and verification separately."},
             {"computer_batch", "Execute steps sequentially; each step has operation and args. Not atomic. "
                                "Per-step delayMs waits before execution. Steps may use tool:computer_wait with arguments. "
                                "before/after are read-only equality checks (operation,args,pointer,equals,timeoutMs). "
                                "inputDefaults supplies shared input args such as windowRef and coordinateSpace. "
                                "output:summary returns only completion or failure details. Stops on first error or check timeout."},
             {"computer_wait",
              "Poll a read-only operation until a JSON Pointer equals the requested value or timeout."},
             {"computer_runtime", "Discover implemented operations and native runtime capabilities."}}) {
        Json properties = {{"operation", {{"type", "string"}}}, {"args", {{"type", "object"}}}};
        Json required = Json::array();
        properties["includeImage"] = {{"type", "boolean"}, {"default", false}};
        properties["requestId"] = {
            {"type", "string"},
            {"description",
             "Session-local action deduplication id; reuse only for identical operation/args"}};
        if (name == "computer_batch") {
            properties = {{"steps", {{"type", "array"}, {"items", {{"type", "object"}}}}}};
            properties["metrics"] = {{"type", "boolean"}, {"default", false}};
            properties["output"] = {{"type", "string"}, {"enum", {"all", "last", "summary"}}, {"default", "all"}};
            properties["inputDefaults"] = {{"type", "object"}};
            required.push_back("steps");
        } else if (name == "computer_wait") {
            properties["output"] = {{"type", "string"}, {"enum", {"all", "summary"}}, {"default", "all"}};
            properties["pointer"] = {{"type", "string"}};
            properties["equals"] = Json::object();
            properties["timeoutMs"] = {{"type", "integer"}, {"minimum", 0}, {"maximum", 60000}};
            required = {"operation", "pointer", "equals"};
        } else if (name != "computer_runtime")
            required.push_back("operation");
        rows.push_back({{"name", name},
                        {"description", description},
                        {"inputSchema",
                         {{"type", "object"},
                          {"properties", properties},
                          {"required", required},
                          {"additionalProperties", false}}},
                        {"annotations",
                         {{"readOnlyHint", name == "computer_query" || name == "computer_wait"},
                          {"destructiveHint", name == "computer_act" || name == "computer_batch"},
                          {"idempotentHint", name != "computer_act" && name != "computer_batch"},
                          {"openWorldHint", true}}}});
    }
    return rows;
}
using Dispatch = std::function<Json(const std::string &, const Json &)>;
Json call(const Dispatch &dispatch, const std::string &name, const Json &args, const std::function<void()> &checkCancelled) {
    if (name == "computer_runtime") {
        auto op = args.value("operation", std::string("runtime.capabilities"));
        if (op != "runtime.capabilities" && op != "runtime.describe" && op != "action.status")
            throw std::invalid_argument(
                "computer_runtime supports capabilities, describe, action.status and runtime.cancel");
        return dispatch(op, args.value("args", Json::object()));
    }
    if (name == "computer_batch") {
        const auto started = std::chrono::steady_clock::now();
        const bool metrics = args.value("metrics", false);
        Json timings = Json::array();
        auto finish = [&](Json result) {
            if (metrics) result["metrics"] = {{"elapsedMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()}, {"steps", timings}};
            return result;
        };
        const auto output = args.value("output", std::string("all"));
        if (output != "all" && output != "last" && output != "summary") throw std::invalid_argument("output must be all, last or summary");
        if (args.contains("inputDefaults") && !args.at("inputDefaults").is_object())
            throw std::invalid_argument("inputDefaults must be an object");
        // Validate delays before dispatching any actions.
        for (const auto &step : args.at("steps")) {
            for (const auto *phase : {"before", "after"}) {
                if (!step.contains(phase)) continue;
                const auto &condition = step.at(phase);
                if (!condition.is_object() || !condition.contains("operation") ||
                    !Service::read_only(condition.at("operation").get<std::string>()) ||
                    !condition.contains("pointer") || !condition.contains("equals"))
                    throw std::invalid_argument("Batch checks require a read-only operation, pointer and equals");
                Json::json_pointer pointer(condition.at("pointer").get<std::string>());
                const auto timeout = condition.value("timeoutMs", 0);
                if (timeout < 0 || timeout > 60000) throw std::invalid_argument("Check timeout outside 0..60000");
            }
            if (step.contains("tool") && step.at("tool") != "computer_wait")
                throw std::invalid_argument("Batch step tool must be computer_wait; otherwise use operation");
            if (step.contains("delayMs") && (!step["delayMs"].is_number_integer() ||
                step["delayMs"].get<int64_t>() < 0 || step["delayMs"].get<int64_t>() > 60000))
                throw std::invalid_argument("delayMs must be an integer in 0..60000");
        }
        Json rows = Json::array();
        std::map<std::string, Json> completed;
        for (const auto &step : args.at("steps")) {
            const auto stepStart = std::chrono::steady_clock::now();
            auto dispatchStart = stepStart;
            std::string phase = "before";
            bool dispatched = false;
            auto failure = [&](Json detail) {
                if (output == "summary") return finish(Json{{"status", "partial"}, {"completed", rows.size()},
                    {"failedStep", step.value("id", std::to_string(rows.size()))}, {"phase", phase},
                    {"dispatchAttempted", dispatched}, {"error", detail}});
                rows.push_back(std::move(detail));
                return finish(Json{{"status", "partial"}, {"steps", rows}, {"completed", rows.size() - 1}});
            };
            try {
                auto id = step.value("id", std::to_string(rows.size()));
                if (completed.contains(id))
                    throw std::invalid_argument("Duplicate step id: " + id);
                auto resolved = resolve_step_refs(step, completed);
                const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(resolved.value("delayMs", 0));
                while (std::chrono::steady_clock::now() < until) {
                    checkCancelled();
                    std::this_thread::sleep_for(std::min(std::chrono::milliseconds(25),
                        std::chrono::duration_cast<std::chrono::milliseconds>(until - std::chrono::steady_clock::now())));
                }
                dispatchStart = std::chrono::steady_clock::now();
                checkCancelled();
                auto check = [&](const char *key) {
                    phase = key;
                    if (!resolved.contains(key)) return;
                    auto condition = resolved.at(key);
                    condition["output"] = "summary";
                    if (!condition.contains("timeoutMs")) condition["timeoutMs"] = 0;
                    if (operation_failed(call(dispatch, "computer_wait", condition, checkCancelled)))
                        throw std::runtime_error(std::string("batch_condition_failed: ") + key);
                };
                check("before");
                phase = "action";
                if (resolved.value("operation", std::string{}).starts_with("input.")) {
                    auto defaults = resolve_step_refs(args.value("inputDefaults", Json::object()), completed);
                    defaults.update(resolved.value("args", Json::object()));
                    resolved["args"] = std::move(defaults);
                }
                dispatched = true;
                auto value = resolved.value("tool", std::string{}) == "computer_wait"
                    ? call(dispatch, "computer_wait", resolved.at("arguments"), checkCancelled)
                    : dispatch(resolved.at("operation"), resolved.value("args", Json::object()));
                if (metrics) timings.push_back({{"id", id},
                    {"beforeDispatchMs", std::chrono::duration<double, std::milli>(dispatchStart - stepStart).count()},
                    {"dispatchMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - dispatchStart).count()}});
                if (operation_failed(value)) {
                    return failure({{"status", "error"}, {"result", value}});
                }
                check("after");
                rows.push_back({{"status", "ok"}, {"result", value}});
                completed[id] = rows.back();
            } catch (const std::exception &e) {
                if (metrics && timings.size() > rows.size()) timings.erase(timings.size() - 1);
                if (metrics) timings.push_back({{"id", step.value("id", std::to_string(rows.size()))},
                    {"failed", true}, {"elapsedMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - stepStart).count()}});
                return failure({{"status", "error"}, {"message", e.what()}});
            }
        }
        if (output == "summary") return finish({{"status", "ok"}, {"completed", rows.size()}});
        if (output == "last") return finish({{"status", "ok"}, {"completed", rows.size()},
            {"result", rows.empty() ? Json(nullptr) : rows.back()["result"]}});
        return finish({{"status", "ok"}, {"steps", rows}, {"completed", rows.size()}});
    }
    auto op = args.at("operation").get<std::string>();
    auto a = args.value("args", Json::object());
    if (args.contains("requestId"))
        a["requestId"] = args["requestId"];
    if (name == "computer_query" || name == "computer_inspect" || name == "computer_wait") {
        if (!Service::read_only(op) &&
            !(name == "computer_inspect" && (op.starts_with("capture.") || op == "inspect.hybrid")))
            throw std::invalid_argument(
                "This tool only accepts read-only operations; use computer_act for "
                "actions; computer_inspect also accepts capture and hybrid inspection");
    } else if (name != "computer_act")
        throw std::invalid_argument("Unknown tool");
    if (name == "computer_wait") {
        const auto output = args.value("output", std::string("all"));
        if (output != "all" && output != "summary") throw std::invalid_argument("wait output must be all or summary");
        int timeout = args.value("timeoutMs", 5000);
        if (timeout < 0 || timeout > 60000)
            throw std::invalid_argument("timeoutMs outside 0..60000");
        auto start = std::chrono::steady_clock::now();
        Json last;
        size_t polls = 0;
        auto result = [&](bool matched) {
            Json value = {{"status", matched ? "ok" : "timeout"}, {"matched", matched}};
            if (output == "all") value["result"] = last;
            else {
                value["polls"] = polls;
                value["elapsedMs"] = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
            }
            return value;
        };
        do {
            checkCancelled();
            last = dispatch(op, a);
            ++polls;
            Json::json_pointer pointer(args.at("pointer").get<std::string>());
            if (last.contains(pointer) && last.at(pointer) == args.at("equals"))
                return result(true);
            if (std::chrono::steady_clock::now() - start >= std::chrono::milliseconds(timeout))
                break;
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        } while (true);
        return result(false);
    }
    return dispatch(op, a);
}
} // namespace
int serve(bool mcp) {
    std::unique_ptr<Service> local;
    std::unique_ptr<Worker> worker;
    if (mcp)
        worker = std::make_unique<Worker>();
    else
        local = std::make_unique<Service>();
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
    Dispatch dispatch = [&](const std::string &op, const Json &args) {
        checkCancelled();
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
                        bool runtime =
                            method == "tools/call" &&
                            params.value("name", std::string{}) == "computer_runtime" &&
                            params.value("arguments", Json::object()).value("operation", std::string{}) ==
                                "runtime.cancel";
                        if (notification || runtime) {
                            Json target = notification ? params.value("requestId", Json(nullptr))
                                                       : params.value("arguments", Json::object())
                                                             .value("args", Json::object())
                                                             .value("id", Json(nullptr));
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
                            if (runtime && message.contains("id")) {
                                Json value = {{"status", "cancel_requested"}, {"targetRequestId", target}};
                                emit({{"jsonrpc", "2.0"},
                                      {"id", message["id"]},
                                      {"result",
                                       {{"content",
                                         Json::array({{{"type", "text"}, {"text", dump_json(value)}}})},
                                        {"structuredContent", value},
                                        {"isError", false}}}});
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
                              {"serverInfo", {{"name", "desktop-pilot"}, {"version", "0.3.0"}}},
                              {"instructions",
                               "Call computer_runtime to discover supported operations. References "
                               "only exist in this server session. Window capture returns visible "
                               "screen pixels, including occluding windows."}};
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
                            auto value = call(dispatch, name, params.value("arguments", Json::object()), checkCancelled);
                            result = {
                                {"content", Json::array({{{"type", "text"}, {"text", dump_json(value)}}})},
                                {"structuredContent", value},
                                {"isError",
                                 operation_failed(value)}};
                            if (params.value("arguments", Json::object()).value("includeImage", false)) {
                                Json captured = value.contains("capture") ? value["capture"] : value;
                                if (captured.contains("path") && captured.contains("imageRef"))
                                    result["content"].push_back(
                                        {{"type", "image"},
                                         {"mimeType", "image/png"},
                                         {"data", base64_file(captured["path"].get<std::string>())}});
                            }
                        } catch (const std::exception &e) {
                            Json error = {{"status", "error"}, {"message", e.what()}};
                            result = {
                                {"content", Json::array({{{"type", "text"}, {"text", dump_json(error)}}})},
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
