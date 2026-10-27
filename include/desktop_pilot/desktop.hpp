#pragma once
#include <desktop_pilot/core.hpp>
#include <memory>

namespace dp {
// One instance belongs to one executor thread (COM MTA on Windows). References are session-local.
class Desktop {
public:
    Desktop();
    ~Desktop();
    Desktop(const Desktop&)=delete;
    Desktop& operator=(const Desktop&)=delete;
    Json execute(const std::string& operation,const Json& args);
    static Json operations();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
int serve(bool mcp);
}
