#pragma once
#include <desktop_pilot/core.hpp>
#include <functional>
#include <map>

namespace dp {
// Shared chord normalization for API calls and replay preflight validation.
Json normalize_key_chord(const std::string& chord);
class AgentApi {
public:
    using Dispatch = std::function<Json(const std::string&, const Json&)>;
    static Json tools();
    Json call(const std::string& tool, const Json& args, const Dispatch& dispatch);
private:
    struct Observation { std::string id; Json window; Json capture; std::map<std::string,Json> controls; };
    std::map<std::string,Observation> observations_;
    std::map<std::string,Json> targets_;
    size_t serial_=0;
    Json desktopGeneration_;
};
}
