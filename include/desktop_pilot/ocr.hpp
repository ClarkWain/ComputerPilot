#pragma once
#include "core.hpp"
#include <array>
#include <memory>

namespace dp {
struct Point { float x=0, y=0; };
struct TextLine {
    Box box;
    std::array<Point,4> polygon;
    std::string text;
    float score=0, detection_score=0;
};
struct OcrOptions {
    int threads=4, max_side=960;
    float pixel_threshold=0.3f, box_threshold=0.5f, text_threshold=0.5f;
    size_t max_lines=1000;
    void validate() const;
};
struct OcrResult {
    std::vector<TextLine> lines;
    Json timings_ms;
    size_t candidate_count=0, rejected_count=0;
    bool truncated=false;
};
struct DecodedText { std::string text; float confidence=0; };
DecodedText decode_ctc(std::span<const float> data, size_t steps, std::span<const std::string> dictionary);
Json text_lines_json(std::span<const TextLine> lines,const std::string& image_ref);
Json fuse_text(std::span<const Detection> detections,std::span<const TextLine> lines,const std::string& image_ref);
class Ocr {
public:
    Ocr(const std::filesystem::path& model_dir,OcrOptions options={});
    ~Ocr();
    Ocr(const Ocr&)=delete;
    Ocr& operator=(const Ocr&)=delete;
    OcrResult run(const Image& image);
    Json metadata() const;
    static bool available();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
