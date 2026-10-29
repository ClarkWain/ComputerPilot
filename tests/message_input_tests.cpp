#include <desktop_pilot/message_input.hpp>
#include <iostream>
#include <string>

int main() {
    // A never-shown fixture: no global input, focus change, or clipboard access.
    HWND parent = CreateWindowExW(0, L"STATIC", L"ComputerPilot message test", 0,
                                  0, 0, 400, 200, nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
    HWND edit = CreateWindowExW(0, L"EDIT", L"abc测试", WS_CHILD | ES_MULTILINE | ES_WANTRETURN,
                                0, 0, 300, 100, parent, nullptr, GetModuleHandleW(nullptr), nullptr);
    if (!parent || !edit) { if (parent) DestroyWindow(parent); return 2; }
    const HWND foreground = GetForegroundWindow();
    auto read = [&] { wchar_t value[256]{}; GetWindowTextW(edit, value, 256); return std::wstring(value); };
    auto expect = [&](const wchar_t *wanted, const char *stage) {
        if (read() == wanted) return true;
        std::cerr << stage << " actual UTF-16:";
        for (auto ch : read()) std::cerr << ' ' << static_cast<unsigned>(ch);
        std::cerr << '\n';
        return false;
    };
    const int end = GetWindowTextLengthW(edit);
    SendMessageW(edit, EM_SETSEL, end, end);
    bool passed = dp::send_editing_key(edit, VK_BACK, L'\b') && expect(L"abc测", "backspace");
    passed = dp::send_editing_key(edit, VK_RETURN, L'\r') && expect(L"abc测\r\n", "enter") && passed;
    SendMessageW(edit, WM_CHAR, L'末', 1);
    passed = expect(L"abc测\r\n末", "unicode") && passed;
    // Selection replacement and blank lines must survive the same event path.
    SendMessageW(edit, EM_SETSEL, 0, -1);
    passed = dp::send_editing_key(edit, VK_BACK, L'\b') && expect(L"", "selection-delete") && passed;
    passed = dp::send_editing_key(edit, VK_RETURN, L'\r') && passed;
    passed = dp::send_editing_key(edit, VK_RETURN, L'\r') && expect(L"\r\n\r\n", "blank-lines") && passed;
    passed = GetForegroundWindow() == foreground && passed;
    DestroyWindow(parent);
    std::cout << (passed ? "MESSAGE INPUT PASS" : "MESSAGE INPUT FAILED") << '\n';
    return passed ? 0 : 1;
}
