#pragma once
#include <desktop_pilot/core.hpp>
#include <functional>
namespace dp {
using SemanticCall = std::function<Json(const std::string&, const Json&)>;
Json run_app_semantic(const Json&, const Json&, const SemanticCall&, const std::function<void(int)>&, bool validateOnly = false);
Json run_semantic(const Json& request, const Json& profile, const SemanticCall& call,
                  const std::function<void(int)>& sleep);
}
