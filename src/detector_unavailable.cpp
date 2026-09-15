#include <desktop_pilot/detector.hpp>
#include <stdexcept>
namespace dp {
struct Detector::Impl {};
void DetectorOptions::validate() const {}
Detector::Detector(const std::filesystem::path&,DetectorOptions){throw std::runtime_error("Detector unavailable: build with DP_WITH_TORCH=ON and provide LibTorch");}
Detector::~Detector()=default;
bool Detector::available(){return false;}
DetectionResult Detector::run(const Image&){throw std::runtime_error("Detector unavailable");}
Json Detector::metadata() const {return {{"available",false}};}
}
