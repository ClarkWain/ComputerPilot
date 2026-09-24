#include <desktop_pilot/core.hpp>
#include <algorithm>
#include <array>
#include <charconv>
#include <cmath>
#include <cwctype>
#include <fstream>
#include <limits>
#include <stdexcept>

namespace dp {
void Image::validate() const {
    if (width <= 0 || height <= 0 || static_cast<uint64_t>(width) * height > 64000000ULL ||
        rgb.size() != static_cast<size_t>(width) * height * 3)
        throw std::invalid_argument("Invalid RGB image dimensions/buffer (limit: 64 million pixels)");
}
namespace {
void append_json(std::string& out, const Json& value, int indent, size_t depth) {
    if (value.is_number_float()) {
        const double number = value.get<double>();
        if (!std::isfinite(number)) { out += "null"; return; }
        // Enough for every finite double in fixed notation, plus sign and decimals.
        std::array<char, std::numeric_limits<double>::max_exponent10 + 16> buffer;
        const auto result = std::to_chars(buffer.data(), buffer.data() + buffer.size(),
                                          number, std::chars_format::fixed, 4);
        if (result.ec != std::errc{}) throw std::runtime_error("Cannot format JSON number");
        char* end = result.ptr;
        while (end != buffer.data() && end[-1] == '0') --end;
        if (end != buffer.data() && end[-1] == '.') --end;
        if (end - buffer.data() == 2 && buffer[0] == '-' && buffer[1] == '0')
            out += '0';
        else out.append(buffer.data(), end);
        return;
    }
    if (!value.is_array() && !value.is_object()) {
        out += value.dump(indent, ' ', false, Json::error_handler_t::replace);
        return;
    }
    const bool object = value.is_object();
    const bool pretty = indent >= 0;
    out += object ? '{' : '[';
    bool first = true;
    for (auto it = value.begin(); it != value.end(); ++it) {
        if (!first) out += ',';
        if (pretty) { out += '\n'; out.append((depth + 1) * size_t(indent), ' '); }
        if (object) {
            out += Json(it.key()).dump(-1, ' ', false, Json::error_handler_t::replace);
            out += pretty ? ": " : ":";
        }
        append_json(out, it.value(), indent, depth + 1);
        first = false;
    }
    if (pretty && !value.empty()) { out += '\n'; out.append(depth * size_t(indent), ' '); }
    out += object ? '}' : ']';
}
}
std::string dump_json(const Json& value, int indent) {
    std::string out;
    append_json(out, value, indent, 0);
    return out;
}
void write_json(const std::filesystem::path& path, const Json& result) {
    if (!path.parent_path().empty()) std::filesystem::create_directories(path.parent_path());
    std::ofstream stream(path, std::ios::binary|std::ios::trunc);
    stream << dump_json(result, 2) << '\n';
    stream.close();
    if (!stream) throw std::runtime_error("Cannot write JSON output");
}
void ensure_distinct_paths(std::span<const std::filesystem::path> paths) {
    for (size_t i=0;i<paths.size();++i) for(size_t j=i+1;j<paths.size();++j) {
        if (paths[i].empty() || paths[j].empty()) continue;
        auto a=std::filesystem::weakly_canonical(paths[i]).wstring();
        auto b=std::filesystem::weakly_canonical(paths[j]).wstring();
        std::transform(a.begin(),a.end(),a.begin(),[](wchar_t c){ return wchar_t(std::towlower(c)); });
        std::transform(b.begin(),b.end(),b.begin(),[](wchar_t c){ return wchar_t(std::towlower(c)); });
        bool same=a==b;
        if(!same && std::filesystem::exists(paths[i]) && std::filesystem::exists(paths[j]))
            same=std::filesystem::equivalent(paths[i],paths[j]);
        if(same) throw std::invalid_argument("Input, model and output paths must be distinct");
    }
}
}
