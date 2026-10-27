#include <desktop_pilot/platform.hpp>
#include <desktop_pilot/worker.hpp>
#include <chrono>
#include <iostream>
#include <thread>
#include <stdexcept>
DP_MAIN(pilot_main) {
    if (argc > 1 && std::wstring(argv[1]) == L"jsonl") {
        std::string line;
        while (std::getline(std::cin, line)) {
            auto request = dp::Json::parse(line);
            if (request["operation"] == "test.block")
                std::this_thread::sleep_for(std::chrono::seconds(30));
            std::cout << dp::Json({{"result", {{"status", "ok"}, {"value", 42}}}}).dump() << '\n'
                      << std::flush;
        }
        return 0;
    }
    try {
        dp::Worker worker;
        auto first = worker.execute("test.echo", dp::Json::object());
        if (first["value"] != 42)
            throw std::runtime_error("Worker echo failed");
        auto start = std::chrono::steady_clock::now();
        auto timeout =
            worker.execute("test.block", {{"providerTimeoutMs", 100}, {"requestId", "timeout-write"}});
        if (timeout["status"] != "error" || timeout["referencesInvalidated"] != true ||
            std::chrono::steady_clock::now() - start > std::chrono::seconds(5))
            throw std::runtime_error("Provider deadline failed");
        auto replay =
            worker.execute("test.block", {{"providerTimeoutMs", 100}, {"requestId", "timeout-write"}});
        if (replay["replayed"] != true)
            throw std::runtime_error("Unknown write redispatched");
        auto restarted = worker.execute("test.echo", dp::Json::object());
        if (restarted["value"] != 42 || restarted["workerGeneration"] == first["workerGeneration"])
            throw std::runtime_error("Worker recovery failed");
        std::thread cancel([&] {
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
            worker.cancel();
        });
        auto cancelled = worker.execute("test.block", {{"providerTimeoutMs", 10000}});
        cancel.join();
        if (cancelled["status"] != "error" ||
            cancelled["message"].get<std::string>().find("cancelled") == std::string::npos)
            throw std::runtime_error("Worker cancellation failed");
        worker.reset_cancel();
        if (worker.execute("test.echo", dp::Json::object())["value"] != 42)
            throw std::runtime_error("Recovery after cancel failed");
        std::cout << "Worker timeout, hard cancel, recovery, unknown-write dedup: PASS\n";
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
