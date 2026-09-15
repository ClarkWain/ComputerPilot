#pragma once
#include "core.hpp"
#include <memory>

namespace dp {
struct DetectorOptions {
    int size = 640;
    int threads = 4;
    float confidence = 0.25f;
    float nms_iou = 0.7f;
    size_t max_detections = 300;
    void validate() const;
};
struct DetectionResult {
    std::vector<Detection> detections;
    Json tensor_shapes;
    Json timings_ms;
};
class Detector {
public:
    Detector(const std::filesystem::path& model, DetectorOptions options);
    ~Detector();
    Detector(const Detector&) = delete;
    Detector& operator=(const Detector&) = delete;
    DetectionResult run(const Image& image);
    Json metadata() const;
    static bool available();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
