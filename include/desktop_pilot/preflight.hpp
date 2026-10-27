#pragma once
#include <desktop_pilot/core.hpp>

namespace dp {
// Pure classification: diagnostics are collected on the executor's thread, not the client.
Json desktop_preflight(const Json& session);
// Explicit allowlist; application writes are not approved for locked sessions.
bool background_operation(const std::string& operation);
// Empty object means permitted; failures preserve dispatch/resume diagnostics.
Json desktop_operation_access(const std::string& operation,const Json& preflight);
// Called under the backend's session mutex. A transition invalidates old observations.
class DesktopSessionTracker {
public:
    Json observe(const Json& session);
private:
    Json signature_;
    uint64_t generation_=0;
};
bool requires_interactive_desktop(const std::string& operation);
}
