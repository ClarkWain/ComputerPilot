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
Letterbox Letterbox::make(int width, int height, int size) {
    if (width <= 0 || height <= 0 || size < 32 || size > 2048)
        throw std::invalid_argument("Image dimensions must be positive; detector size must be 32..2048");
    int target = (size + 31) / 32 * 32;
    double scale = std::min(double(target) / width, double(target) / height);
    int rw = std::max(1, int(width * scale)), rh = std::max(1, int(height * scale));
    return {width, height, target, target, rw, rh, (target-rw)/2, (target-rh)/2, scale};
}
Box Letterbox::to_source(Box b, bool clip) const {
    b = {float((b.x1-left)/scale), float((b.y1-top)/scale),
         float((b.x2-left)/scale), float((b.y2-top)/scale)};
    if (clip) {
        b.x1 = std::clamp(b.x1, 0.f, float(source_width));
        b.x2 = std::clamp(b.x2, 0.f, float(source_width));
        b.y1 = std::clamp(b.y1, 0.f, float(source_height));
        b.y2 = std::clamp(b.y2, 0.f, float(source_height));
    }
    return b;
}
static float area(Box b) { return std::max(0.f,b.x2-b.x1)*std::max(0.f,b.y2-b.y1); }
float iou(Box a, Box b) {
    float intersect = area({std::max(a.x1,b.x1),std::max(a.y1,b.y1),std::min(a.x2,b.x2),std::min(a.y2,b.y2)});
    float united = area(a) + area(b) - intersect;
    return united > 0 ? intersect/united : 0;
}
std::vector<Detection> nms(std::vector<Detection> items, float threshold, size_t max_count) {
    if (!std::isfinite(threshold) || threshold < 0 || threshold > 1)
        throw std::invalid_argument("NMS threshold must be 0..1");
    std::erase_if(items, [](const auto& v) {
        return !std::isfinite(v.score) || !std::isfinite(v.box.x1) || !std::isfinite(v.box.x2) ||
            !std::isfinite(v.box.y1) || !std::isfinite(v.box.y2) || area(v.box) <= 0;
    });
    std::stable_sort(items.begin(), items.end(), [](auto& a, auto& b) { return a.score > b.score; });
    std::vector<Detection> selected;
    for (const auto& item : items) {
        if (selected.size() >= max_count) break;
        bool overlaps = std::any_of(selected.begin(), selected.end(), [&](auto& other) {
            return item.class_id == other.class_id && iou(item.box, other.box) > threshold;
        });
        if (!overlaps) selected.push_back(item);
    }
    return selected;
}

// Separable antialiased Lanczos-3, with per-pass 8-bit rounding. This is an
// independent implementation; bitwise parity with Pillow has not been claimed.
static double lanczos(double x) {
    x = std::abs(x);
    if (x < 1e-12) return 1;
    if (x >= 3) return 0;
    constexpr double pi = 3.14159265358979323846;
    return std::sin(pi*x)*std::sin(pi*x/3)/(pi*pi*x*x/3);
}
struct Filter { int begin; std::vector<double> weights; };
static std::vector<Filter> filters(int source, int target) {
    std::vector<Filter> result;
    double scale = double(source)/target, support_scale = std::max(1.0, scale);
    for (int i=0; i<target; ++i) {
        double center = (i+0.5)*scale;
        int begin = std::max(0, int(std::floor(center-3*support_scale+0.5)));
        int end = std::min(source, int(std::floor(center+3*support_scale+0.5)));
        Filter f{begin,{}}; double sum=0;
        for (int k=begin; k<end; ++k) { double w=lanczos((k+0.5-center)/support_scale); f.weights.push_back(w); sum+=w; }
        if (std::abs(sum)<1e-12) throw std::runtime_error("Degenerate resize filter");
        for (auto& w:f.weights) w/=sum;
        result.push_back(std::move(f));
    }
    return result;
}
static uint8_t quantize(double v) { return static_cast<uint8_t>(std::clamp(std::floor(v+0.5),0.0,255.0)); }
std::vector<float> preprocess(const Image& image, const Letterbox& l) {
    image.validate();
    if (image.width != l.source_width || image.height != l.source_height)
        throw std::invalid_argument("Letterbox source does not match image");
    auto fx=filters(image.width,l.resized_width), fy=filters(image.height,l.resized_height);
    std::vector<uint8_t> tmp(size_t(l.resized_width)*image.height*3);
    for(int y=0;y<image.height;++y) for(int x=0;x<l.resized_width;++x) for(int c=0;c<3;++c) {
        double v=0; auto& f=fx[x];
        for(size_t k=0;k<f.weights.size();++k) v+=image.rgb[(size_t(y)*image.width+f.begin+k)*3+c]*f.weights[k];
        tmp[(size_t(y)*l.resized_width+x)*3+c]=quantize(v);
    }
    size_t plane=size_t(l.target_width)*l.target_height;
    std::vector<float> out(plane*3,114.f/255.f);
    for(int y=0;y<l.resized_height;++y) for(int x=0;x<l.resized_width;++x) for(int c=0;c<3;++c) {
        double v=0; auto& f=fy[y];
        for(size_t k=0;k<f.weights.size();++k) v+=tmp[((f.begin+k)*l.resized_width+x)*3+c]*f.weights[k];
        out[c*plane+size_t(y+l.top)*l.target_width+x+l.left]=quantize(v)/255.f;
    }
    return out;
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
Json detection_json(std::span<const Detection> items, const std::string& image_ref) {
    Json result=Json::array();
    for(size_t i=0;i<items.size();++i) {
        auto& d=items[i]; auto b=d.box;
        result.push_back({{"nodeRef",image_ref+":r"+std::to_string(i+1)}, {"nativeRef",nullptr},
            {"visualRef",{{"imageRef",image_ref},{"regionId","r"+std::to_string(i+1)}}},
            {"bounds",{{"space","image_px"},{"x",b.x1},{"y",b.y1},{"width",b.x2-b.x1},{"height",b.y2-b.y1}}},
            {"point",{{"space","image_px"},{"x",(b.x1+b.x2)/2},{"y",(b.y1+b.y2)/2},{"kind","candidate"}}},
            {"classId",d.class_id},{"detectorScore",d.score},{"text",nullptr},
            {"evidence",{{"region","omniparser.icon_detect_v3"}}},
            {"nativePatterns",Json::array()},{"state",{{"enabled","unknown"},{"occluded","unknown"}}}});
    }
    return result;
}
}
