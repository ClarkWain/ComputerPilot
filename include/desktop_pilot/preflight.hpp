#pragma once
#include <desktop_pilot/core.hpp>

namespace dp {
// Pure classification: diagnostics are collected on the executor's thread, not the client.
Json desktop_preflight(const Json& session);
bool requires_interactive_desktop(const std::string& operation);
}
