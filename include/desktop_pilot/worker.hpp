#pragma once
#include <desktop_pilot/core.hpp>
#include <atomic>
#include <memory>
namespace dp {
class Worker {
public:
    Worker();~Worker();
    Json execute(const std::string& operation,const Json& args);
    void cancel();
    void reset_cancel();
private:
    struct Impl;std::unique_ptr<Impl> impl_;
};
}
