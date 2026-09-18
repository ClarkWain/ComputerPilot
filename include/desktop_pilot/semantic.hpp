#pragma once
#include <desktop_pilot/core.hpp>
#include <functional>
namespace dp {
using SemanticCall = std::function<Json(const std::string&, const Json&)>;
// In-process evidence from this execution's profile discovery, never request JSON
// or a cache from a previous observation. The first drawing action rechecks it.
struct SemanticEvidence {
    std::string windowRef;
    Json window;
    Json session;
    Json tree;
};
using SemanticDispatch = std::function<Json(const Json&, const SemanticEvidence&)>;
bool semantic_evidence_current(const SemanticEvidence&, const std::string& windowRef, const Json& window, const Json& session);
Json run_app_semantic(const Json&, const Json&, const SemanticCall&, const std::function<void(int)>&, bool validateOnly = false,
                      const SemanticEvidence* evidence = nullptr);
Json run_semantic(const Json& request, const Json& profile, const SemanticCall& call,
                  const std::function<void(int)>& sleep, const SemanticEvidence* evidence = nullptr);
}
