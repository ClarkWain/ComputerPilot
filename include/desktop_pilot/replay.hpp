#pragma once
#include <desktop_pilot/core.hpp>
#include <functional>

namespace dp {
using ReplayCall=std::function<Json(const std::string&,const Json&)>;
using ReplayProgress=std::function<void(const Json&)>;
// Fully validate the document before any desktop calls or output creation.
Json validate_replay(const Json& recipe);
// The caller must first discover a fresh target in the same AgentApi session.
Json run_replay(const Json& recipe,const std::string& window_id,const ReplayCall& call,
                const ReplayProgress& progress={});
int replay_cli(const std::filesystem::path& file,const std::filesystem::path& output,bool execute);
}
