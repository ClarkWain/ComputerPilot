#pragma once
#include <desktop_pilot/semantic.hpp>
namespace dp {
bool profile_supports_dpi(const Json& profile,int dpi);
std::filesystem::path profiles_directory();
// Discovery is read-only. A matching executable alone never proves UI compatibility.
Json discover_profiles(const std::filesystem::path& directory, const std::string& window,
                       const SemanticCall& call);
Json execute_profile_actions(const std::filesystem::path& directory,const Json& args,const SemanticCall& call);
Json load_profile(const std::filesystem::path& directory, const std::string& id);
}
