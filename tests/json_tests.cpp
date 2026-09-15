#include <desktop_pilot/core.hpp>
#include <desktop_pilot/text_diff.hpp>
#include <desktop_pilot/fill_form.hpp>
#include <cmath>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>

namespace {
int checks = 0;
void require(bool condition, const char* reason) {
    ++checks;
    if (!condition) throw std::runtime_error(reason);
}
void expect(double value, const std::string& expected) {
    const dp::Json original = value;
    const std::string before = original.dump();
    const std::string actual = dp::dump_json(original);
    require(actual == expected, "decimal formatting");
    require(dp::Json::parse(actual).is_number(), "number remains a JSON number");
    require(original.dump() == before, "serialization must not mutate stored precision");
}
}

int main() {
    using namespace dp;
    try {
        {
        std::string clipboard = "original", value = "before";
        bool failPaste = false;
        auto mock = [&](const std::string& op, const Json& a) -> Json {
            if (op == "ui.get") return {{"value", value}};
            if (op == "clipboard.read") return {{"text", clipboard}};
            if (op == "clipboard.write") clipboard = a.at("text");
            if (op == "input.key_chord" && a.at("keys")[1] == "V") {
                if (failPaste) throw std::runtime_error("paste failed");
                value = clipboard;
            }
            return {{"status", "ok"}};
        };
        const Json form = {{"fields", {{{"elementRef", "edit"}, {"text", "new"}}}}, {"verifyTimeoutMs", 0}};
        auto filled = fill_form(form, mock, [](int) {});
        require(filled["verified"] == 1 && clipboard == "original" && value == "new", "Form fill/restore");
        value = "before"; failPaste = true;
        filled = fill_form(form, mock, [](int) {});
        require(filled["status"] == "partial" && filled["verified"] == 0 && clipboard == "original", "Form failure cleanup");
        }
        require(text_diff("abc", "abc")["equal"] == true, "Equal text diff");
        require(text_diff("abc", "abXc")["actualChangedBytes"] == 1, "Insertion diff");
        require(text_diff("abc", "ac")["expectedChangedBytes"] == 1, "Deletion diff");
        require(text_diff("", "x")["firstDifferenceByte"] == 0, "Empty diff");
        require(text_diff("中文", "中文多")["actualChangedBytes"] == 3, "UTF8 byte diff");
        require(utf8_tail_offset("abc测试", 2) == 3, "Chinese tail count");
        require(utf8_tail_offset("a\xF0\x9F\x98\x80", 1) == 1, "Emoji tail boundary");
        require(utf8_tail_offset("", 0) == 0, "Empty tail");
        bool rejectedTail = false;
        try { utf8_tail_offset("a", 2); } catch (const std::invalid_argument&) { rejectedTail = true; }
        require(rejectedTail, "Oversized deletion rejected");
        expect(0.03750000149011612, "0.0375");
        expect(double(0.0375f), "0.0375");
        expect(1.0, "1");
        expect(100.0, "100");
        expect(1.23456, "1.2346");
        expect(-1.23456, "-1.2346");
        expect(1.23454, "1.2345");
        expect(9.99999, "10");
        expect(-9.99999, "-10");
        expect(0.0, "0");
        expect(-0.0, "0");
        expect(0.000049, "0");
        expect(-0.000049, "0");
        expect(0.000051, "0.0001");
        expect(-0.000051, "-0.0001");
        expect(std::numeric_limits<double>::min(), "0");
        expect(std::numeric_limits<double>::denorm_min(), "0");
        expect(1e20, "100000000000000000000");

        for (double v : {std::numeric_limits<double>::max(), -std::numeric_limits<double>::max()}) {
            auto text = dump_json(v);
            require(text.find('.') == std::string::npos && text.find('e') == std::string::npos,
                    "largest double supports fixed format without buffer overflow");
            require(Json::parse(text).get<double>() == v, "largest double roundtrip");
        }
        require(dump_json(std::numeric_limits<int64_t>::min()) == "-9223372036854775808", "signed integer precision");
        require(dump_json(std::numeric_limits<uint64_t>::max()) == "18446744073709551615", "unsigned integer precision");
        for (double v : {std::numeric_limits<double>::quiet_NaN(), std::numeric_limits<double>::infinity(),
                         -std::numeric_limits<double>::infinity()})
            require(dump_json(v) == "null", "nonfinite values retain nlohmann JSON null behavior");

        Json value = {{"nested", Json::array({0.03750000149011612, {{"x", -0.00001}, {"y", 1.23456}}})},
                      {"text", "中文🎵\n\"\\\t"}, {"empty", Json::array()}, {"flag", true}, {"missing", nullptr}};
        const std::string before = value.dump();
        auto expected = value;
        expected["nested"][0] = 0.0375;
        expected["nested"][1]["x"] = 0;
        expected["nested"][1]["y"] = 1.2346;
        for (int indent : {-2, -1, 0, 2, 4}) {
            auto text = dump_json(value, indent);
            require(Json::parse(text) == expected, "nested numeric JSON and Unicode roundtrip");
            require(value.dump() == before, "nested source precision remains intact");
        }
        Json no_floats = {{"中文", "hello\n\"\\"}, {"array", Json::array({1, false, nullptr, Json::object()})}};
        for (int indent : {-1, 0, 2, 4})
            require(dump_json(no_floats, indent) == no_floats.dump(indent), "existing compact/pretty formatting preserved");
        require(dump_json(Json::array()) == "[]" && dump_json(Json::object(), 2) == "{}", "empty containers");
        require(dump_json("1.000000") == "\"1.000000\"", "numeric-looking strings unchanged");
        const std::string invalid_utf8("bad\xff", 4);
        Json invalid = {{invalid_utf8, invalid_utf8}};
        require(dump_json(invalid) == invalid.dump(-1, ' ', false, Json::error_handler_t::replace),
                "invalid UTF-8 replacement preserved for values and keys");

        auto path = std::filesystem::current_path() / "json-test-artifacts" / "output.json";
        write_json(path, value);
        std::ifstream stream(path, std::ios::binary);
        std::string saved((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
        require(saved == dump_json(value, 2) + '\n', "file output uses the same serializer");
        std::cout << "PASS checks=" << checks << '\n';
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
