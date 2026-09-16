#pragma once
#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace dp {
using Json = nlohmann::json;
struct Image {
    int width = 0, height = 0;
    std::vector<uint8_t> rgb;
    void validate() const;
};
struct Box { float x1 = 0, y1 = 0, x2 = 0, y2 = 0; };
struct Detection { Box box; float score = 0; int class_id = 0; };
struct Letterbox {
    int source_width, source_height, target_width, target_height;
    int resized_width, resized_height, left, top;
    double scale;
    static Letterbox make(int width, int height, int requested_size);
    Box to_source(Box box, bool clamp = true) const;
};
float iou(Box a, Box b);
std::vector<Detection> nms(std::vector<Detection> candidates, float threshold, size_t max_count);
std::vector<float> preprocess(const Image& image, const Letterbox& layout);
Image load_image(const std::filesystem::path& path);
void save_png(const Image& image, const std::filesystem::path& path);
bool webp_available();
void save_webp(const Image& image, const std::filesystem::path& path, bool lossless=false);
Image resize_image(const Image& image, int max_edge);
Image draw_overlay(const Image& image, std::span<const Detection> detections);
Image make_fixture();
std::string utf8(std::wstring_view text);
std::string file_sha256(const std::filesystem::path& path);
// Serialize without changing stored values: at most four fractional digits,
// trailing zeros removed; invalid UTF-8 is replaced as in CLI error output.
std::string dump_json(const Json& value, int indent = -1);
void write_json(const std::filesystem::path& path, const Json& result);
void ensure_distinct_paths(std::span<const std::filesystem::path> paths);
Json detection_json(std::span<const Detection> detections, const std::string& image_ref);
}
