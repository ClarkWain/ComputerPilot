#pragma once
#include <desktop_pilot/desktop.hpp>
#include <desktop_pilot/detector.hpp>
#include <desktop_pilot/ocr.hpp>
#include <map>
namespace dp {
inline bool operation_failed(const Json &value) {
    return value.is_object() && (value.value("status", std::string{}) == "error" ||
        value.value("status", std::string{}) == "timeout" ||
        value.value("status", std::string{}) == "partial" ||
        value.value("verification", std::string{}) == "failed");
}
class Service {
public:
    Json execute(const std::string& operation,const Json& args);
    static bool read_only(const std::string& operation);
private:
    Json perform(const std::string& operation,const Json& args);
    std::map<std::string,std::pair<Json,Json>> receipts_;
    Desktop desktop_;
    std::unique_ptr<Detector> detector_;
    std::unique_ptr<Ocr> ocr_;
    std::string detector_path_,ocr_path_;
    std::map<std::string,Json> images_;
    size_t capture_serial_=0;
};
}
