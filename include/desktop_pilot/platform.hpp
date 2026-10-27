#pragma once
#include <desktop_pilot/core.hpp>
#include <cstdlib>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#else
#include <mach-o/dyld.h>
#include <unistd.h>
#include <codecvt>
#include <locale>
#endif
namespace dp {
inline unsigned long process_id() {
#ifdef _WIN32
    return GetCurrentProcessId();
#else
    return static_cast<unsigned long>(getpid());
#endif
}
inline std::filesystem::path executable_path() {
#ifdef _WIN32
    std::wstring buffer(32768, 0);
    auto n=GetModuleFileNameW(nullptr,buffer.data(),DWORD(buffer.size()));
    if(!n || n>=buffer.size())throw std::runtime_error("Cannot locate executable");
    buffer.resize(n);return buffer;
#else
    uint32_t size=0;_NSGetExecutablePath(nullptr,&size);
    std::string buffer(size,'\0');
    if(_NSGetExecutablePath(buffer.data(),&size))throw std::runtime_error("Cannot locate executable");
    return std::filesystem::canonical(buffer.c_str());
#endif
}
inline std::filesystem::path environment_path(const char* name) {
#ifdef _WIN32
    std::wstring key(name,name+std::char_traits<char>::length(name));
    auto n=GetEnvironmentVariableW(key.c_str(),nullptr,0);
    if(!n)return {};
    std::wstring buffer(n,0);auto copied=GetEnvironmentVariableW(key.c_str(),buffer.data(),n);
    if(!copied||copied>=n)throw std::runtime_error("Cannot read environment path");
    buffer.resize(copied);return buffer;
#else
    const char* value=std::getenv(name);return value?std::filesystem::path(value):std::filesystem::path{};
#endif
}
}
// Preserve Unicode Windows argv while sharing each command's implementation.
#ifdef _WIN32
#define DP_MAIN(name) int wmain(int argc, wchar_t** argv)
#else
#define DP_MAIN(name) \
static int name(int argc, wchar_t** argv); \
int main(int argc, char** args) { \
    std::vector<std::wstring> storage; std::vector<wchar_t*> argv; \
    std::wstring_convert<std::codecvt_utf8<wchar_t>> converter; \
    for(int i=0;i<argc;++i)storage.push_back(converter.from_bytes(args[i])); \
    for(auto& value:storage)argv.push_back(value.data());argv.push_back(nullptr); \
    return name(argc,argv.data()); \
} \
static int name(int argc, wchar_t** argv)
#endif
