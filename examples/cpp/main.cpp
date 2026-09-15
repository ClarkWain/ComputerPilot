#include <desktop_pilot/service.hpp>
#include <iostream>

int main() {
    try {
        dp::Service service;
        std::cout << dp::dump_json(service.execute("runtime.capabilities", dp::Json::object())) << '\n';
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
