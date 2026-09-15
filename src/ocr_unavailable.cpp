#include <desktop_pilot/ocr.hpp>
#include <stdexcept>
namespace dp {
struct Ocr::Impl {};
Ocr::Ocr(const std::filesystem::path&,OcrOptions){throw std::runtime_error("OCR backend unavailable; build with DP_WITH_OCR=ON");}
Ocr::~Ocr()=default;
bool Ocr::available(){return false;}
OcrResult Ocr::run(const Image&){throw std::runtime_error("OCR backend unavailable");}
Json Ocr::metadata() const{return {{"available",false}};}
}
