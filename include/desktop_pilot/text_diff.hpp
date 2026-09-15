#pragma once
#include <desktop_pilot/core.hpp>
#include <string>

namespace dp {
inline size_t utf8_tail_offset(const std::string& text, size_t count) {
    size_t retained = text.size();
    for (size_t i = 0; i < count; ++i) {
        if (!retained) throw std::invalid_argument("deleteTail exceeds text length");
        do { --retained; } while (retained && (static_cast<unsigned char>(text[retained]) & 0xC0) == 0x80);
    }
    return retained;
}
// Byte offsets deliberately refer to the exact UTF-8 payload, not screen columns.
inline Json text_diff(const std::string& expected, const std::string& actual) {
    size_t prefix = 0, suffix = 0;
    while (prefix < expected.size() && prefix < actual.size() && expected[prefix] == actual[prefix]) ++prefix;
    while (suffix < expected.size() - prefix && suffix < actual.size() - prefix &&
           expected[expected.size() - 1 - suffix] == actual[actual.size() - 1 - suffix]) ++suffix;
    return {{"equal", expected == actual}, {"firstDifferenceByte", prefix},
            {"commonSuffixBytes", suffix}, {"expectedChangedBytes", expected.size() - prefix - suffix},
            {"actualChangedBytes", actual.size() - prefix - suffix}};
}
}
