#pragma once
#include <desktop_pilot/replay.hpp>

namespace dp {
size_t replay_prefix_strokes(const Json& recipe,size_t completed_steps);
void validate_replay_stop(const Json& recipe,size_t stop_after);
Json replay_observable_state(const Json& state,const Json& canvas_selector);
void verify_replay_document(const Json& window,const Json& application,
                            const std::filesystem::path& document,bool require_saved);
// Atomic replacement on the same filesystem; a crash cannot leave a truncated
// ready descriptor. An in_progress descriptor is deliberately not resumable.
void write_checkpoint_atomic(const std::filesystem::path& file,const Json& checkpoint);
// Offline, read-only integrity/cursor validation. Returns recipe + descriptor.
Json load_replay_checkpoint(const std::filesystem::path& run_directory);
bool replay_resume_not_started(const Json& result,size_t completed_steps,size_t completed_strokes);
}
