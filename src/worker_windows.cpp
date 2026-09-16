#include <desktop_pilot/worker.hpp>
#include <Windows.h>
#include <chrono>
#include <map>
#include <thread>
namespace dp {
struct Worker::Impl {
    HANDLE process = nullptr, input = nullptr, output = nullptr;
    std::atomic<bool> cancelled = false;
    unsigned generation = 0;
    std::map<std::string, std::pair<Json, Json>> receipts;
    void stop() {
        if (process) {
            if (WaitForSingleObject(process, 0) == WAIT_TIMEOUT)
                TerminateProcess(process, 1);
            WaitForSingleObject(process, 5000);
            CloseHandle(process);
        }
        if (input)
            CloseHandle(input);
        if (output)
            CloseHandle(output);
        process = input = output = nullptr;
    }
    ~Impl() { stop(); }
    void start() {
        SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        HANDLE read_input = nullptr, write_output = nullptr;
        if (!CreatePipe(&read_input, &input, &security, 0) ||
            !CreatePipe(&output, &write_output, &security, 0)) {
            if (read_input)
                CloseHandle(read_input);
            if (write_output)
                CloseHandle(write_output);
            stop();
            throw std::runtime_error("Worker pipe creation failed");
        }
        SetHandleInformation(input, HANDLE_FLAG_INHERIT, 0);
        SetHandleInformation(output, HANDLE_FLAG_INHERIT, 0);
        std::wstring executable(32768, 0);
        DWORD size = GetModuleFileNameW(nullptr, executable.data(), DWORD(executable.size()));
        executable.resize(size);
        std::wstring command = L"\"" + executable + L"\" jsonl";
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        // Bind each fresh worker to the interactive desktop instead of inheriting
        // a stale desktop association from a long-running launcher.
        wchar_t desktop[] = L"winsta0\\default";
        startup.lpDesktop = desktop;
        startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE;
        startup.hStdInput = read_input;
        startup.hStdOutput = write_output;
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        PROCESS_INFORMATION child{};
        BOOL ok = CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW,
                                 nullptr, nullptr, &startup, &child);
        CloseHandle(read_input);
        CloseHandle(write_output);
        if (!ok) {
            stop();
            throw std::runtime_error("Native worker start failed: " + std::to_string(GetLastError()));
        }
        process = child.hProcess;
        CloseHandle(child.hThread);
        ++generation;
    }
};
Worker::Worker() : impl_(std::make_unique<Impl>()) {}
Worker::~Worker() = default;
void Worker::cancel() { impl_->cancelled = true; }
void Worker::reset_cancel() { impl_->cancelled = false; }
Json Worker::execute(const std::string &operation, const Json &args) {
    auto &p = *impl_;
    auto id = args.value("requestId", std::string{});
    Json payload = {{"operation", operation}, {"args", args}};
    if (!id.empty()) {
        auto it = p.receipts.find(id);
        if (it != p.receipts.end()) {
            if (it->second.first != payload)
                throw std::invalid_argument("requestId_conflict");
            auto result = it->second.second;
            result["replayed"] = true;
            return result;
        }
    }
    if (operation == "action.status" && !args.contains("requestId")) {
        auto found = p.receipts.find(args.at("id").get<std::string>());
        if (found != p.receipts.end())
            return found->second.second;
    }
    int timeout = args.value("providerTimeoutMs", 60000);
    if (timeout < 1 || timeout > 600000)
        throw std::invalid_argument("providerTimeoutMs outside 1..600000");
    if (p.cancelled)
        return {{"status", "error"}, {"message", "cancelled before dispatch"}, {"dispatch", "not_started"}};
    if (!p.process)
        p.start();
    Json pending = {
        {"status", "unknown"}, {"dispatch", "unknown"}, {"verification", "unknown"}, {"requestId", id}};
    if (!id.empty())
        p.receipts[id] = {payload, pending};
    auto start = std::chrono::steady_clock::now();
    try {
        auto message = payload.dump() + "\n";
        DWORD written = 0;
        if (!WriteFile(p.input, message.data(), DWORD(message.size()), &written, nullptr) ||
            written != message.size())
            throw std::runtime_error("Worker request write failed; dispatch outcome unknown");
        std::string response;
        while (true) {
            if (p.cancelled)
                throw std::runtime_error(
                    "cancelled: provider stopped; prior side effects are not rolled back");
            if (std::chrono::steady_clock::now() - start >= std::chrono::milliseconds(timeout))
                throw std::runtime_error(
                    "provider_timeout: worker terminated; side effects may have occurred");
            DWORD available = 0;
            if (!PeekNamedPipe(p.output, nullptr, 0, nullptr, &available, nullptr))
                throw std::runtime_error("Worker response pipe closed");
            if (available) {
                char buffer[65536];
                DWORD received = 0;
                if (!ReadFile(p.output, buffer, std::min<DWORD>(available, sizeof(buffer)), &received,
                              nullptr))
                    throw std::runtime_error("Worker response read failed");
                response.append(buffer, received);
                if (response.find('\n') != std::string::npos)
                    break;
            } else if (WaitForSingleObject(p.process, 0) != WAIT_TIMEOUT)
                throw std::runtime_error("Worker exited before response");
            else
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
        auto envelope = Json::parse(response);
        Json result;
        if (envelope.contains("error")) {
            result = pending;
            result["status"] = "error";
            result["message"] = envelope["error"]["message"];
        } else
            result = envelope.at("result");
        if (result.is_object()) {
            result["workerGeneration"] = p.generation;
            if (operation == "runtime.capabilities") {
                result["providerIsolation"] = "worker_process";
                result["operations"].push_back("runtime.cancel");
            }
        }
        if (!id.empty())
            p.receipts[id].second = result;
        return result;
    } catch (const std::exception &e) {
        p.stop();
        auto result = pending;
        result["status"] = "error";
        result["message"] = e.what();
        result["referencesInvalidated"] = true;
        result["retryability"] =
            "re-observe; do not repeat a write with a new id until its outcome is checked";
        if (!id.empty())
            p.receipts[id].second = result;
        return result;
    }
}
} // namespace dp
