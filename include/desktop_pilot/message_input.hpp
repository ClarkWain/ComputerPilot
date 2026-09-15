#pragma once
#include <Windows.h>

namespace dp {
// Sent messages do not pass through the receiver's TranslateMessage loop.
// Supply the character event explicitly for editing keys, and always attempt
// key-up even when an earlier send times out. Receipt is not content validation.
inline bool send_editing_key(HWND target, UINT key, wchar_t character) {
    DWORD_PTR ignored = 0;
    const LPARAM down = 1 | (LPARAM(MapVirtualKeyW(key, MAPVK_VK_TO_VSC)) << 16);
    constexpr UINT flags = SMTO_ABORTIFHUNG | SMTO_BLOCK;
    const bool pressed = SendMessageTimeoutW(target, WM_KEYDOWN, key, down, flags, 500, &ignored) != 0;
    const bool typed = pressed && SendMessageTimeoutW(target, WM_CHAR, character, down, flags, 500, &ignored) != 0;
    const bool released = SendMessageTimeoutW(target, WM_KEYUP, key, down | (LPARAM(3) << 30), flags, 500, &ignored) != 0;
    return pressed && typed && released;
}
}
