#pragma once
#include <desktop_pilot/semantic.hpp>
namespace dp {
bool profile_supports_dpi(const Json& profile,int dpi);
std::string profile_geometry_issue(const Json& profile,const Json& window);
std::filesystem::path profiles_directory();
// Discovery is read-only. A matching executable alone never proves UI compatibility.
// inspection receives the attempted UI query, including exceptions converted to
// structured failure, so callers never repeat a failed scan just to observe it.
Json discover_profiles(const std::filesystem::path& directory, const std::string& window,
                       const SemanticCall& call, Json* inspection = nullptr);
Json execute_profile_actions(const std::filesystem::path& directory,const Json& args,const SemanticCall& call,
                             const SemanticDispatch& dispatch = {});
Json load_profile(const std::filesystem::path& directory, const std::string& id);
}
