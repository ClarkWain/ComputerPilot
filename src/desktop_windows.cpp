#include <Windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <UIAutomation.h>
#include <wtsapi32.h>
#include <algorithm>
#include <chrono>
#include <desktop_pilot/desktop.hpp>
#include <desktop_pilot/text_diff.hpp>
#include <desktop_pilot/fill_form.hpp>
#include <desktop_pilot/message_input.hpp>
#include <map>
#include <stdexcept>
#include <thread>
#include <tlhelp32.h>
#include <wrl/client.h>

namespace dp {
namespace {
using Microsoft::WRL::ComPtr;
struct InputLock {
    HANDLE mutex = nullptr;
    InputLock() {
        mutex = CreateMutexW(nullptr, FALSE, L"Local\\DesktopPilot.InputDispatch");
        if (!mutex)
            throw std::runtime_error("Cannot create input dispatch lock");
        auto wait = WaitForSingleObject(mutex, 10000);
        if (wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED) {
            CloseHandle(mutex);
            mutex = nullptr;
            throw std::runtime_error("Input busy in another DesktopPilot session");
        }
    }
    ~InputLock() {
        if (mutex) {
            ReleaseMutex(mutex);
            CloseHandle(mutex);
        }
    }
};
void check(HRESULT hr, const char *what) {
    if (FAILED(hr))
        throw std::runtime_error(std::string(what) +
                                 " HRESULT=" + std::to_string(static_cast<unsigned long>(hr)));
}
std::wstring wide(const std::string &s) {
    if (s.empty())
        return {};
    int n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), int(s.size()), nullptr, 0);
    if (!n)
        throw std::invalid_argument("Invalid UTF-8");
    std::wstring r(n, 0);
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s.data(), int(s.size()), r.data(), n);
    return r;
}
std::string bstr(BSTR s) {
    auto r = s ? utf8(std::wstring_view(s, SysStringLen(s))) : std::string{};
    SysFreeString(s);
    return r;
}
Json rect(RECT r) {
    return {{"x", r.left},
            {"y", r.top},
            {"width", r.right - r.left},
            {"height", r.bottom - r.top},
            {"coordinateSpace", "screen_physical"}};
}
int bounded(const Json &a, const char *key, int fallback, int lo, int hi) {
    int n = a.value(key, fallback);
    if (n < lo || n > hi)
        throw std::invalid_argument(std::string(key) + " out of range");
    return n;
}
const std::map<std::string, PATTERNID> patterns = {{"invoke", UIA_InvokePatternId},
                                                   {"value", UIA_ValuePatternId},
                                                   {"text", UIA_TextPatternId},
                                                   {"legacy", UIA_LegacyIAccessiblePatternId},
                                                   {"scrollItem", UIA_ScrollItemPatternId},
                                                   {"toggle", UIA_TogglePatternId},
                                                   {"selectionItem", UIA_SelectionItemPatternId},
                                                   {"expandCollapse", UIA_ExpandCollapsePatternId},
                                                   {"scroll", UIA_ScrollPatternId},
                                                   {"rangeValue", UIA_RangeValuePatternId}};
const std::map<std::string, CONTROLTYPEID> roles = {
    {"Button", UIA_ButtonControlTypeId},      {"Edit", UIA_EditControlTypeId},
    {"Text", UIA_TextControlTypeId},          {"Window", UIA_WindowControlTypeId},
    {"CheckBox", UIA_CheckBoxControlTypeId},  {"ComboBox", UIA_ComboBoxControlTypeId},
    {"List", UIA_ListControlTypeId},          {"ListItem", UIA_ListItemControlTypeId},
    {"MenuItem", UIA_MenuItemControlTypeId},  {"TabItem", UIA_TabItemControlTypeId},
    {"Pane", UIA_PaneControlTypeId},          {"Document", UIA_DocumentControlTypeId},
    {"Hyperlink", UIA_HyperlinkControlTypeId}};
std::string role(CONTROLTYPEID id) {
    for (auto &[n, i] : roles)
        if (i == id)
            return n;
    return std::to_string(id);
}
template <class T> ComPtr<T> pattern(IUIAutomationElement *e, PATTERNID id) {
    ComPtr<IUnknown> p;
    check(e->GetCurrentPattern(id, &p), "GetCurrentPattern");
    if (!p)
        throw std::runtime_error("pattern_not_supported");
    ComPtr<T> out;
    check(p.As(&out), "Pattern interface");
    return out;
}
Json receipt(const std::string &method) {
    return {{"status", "ok"},
            {"methodUsed", method},
            {"dispatch", "returned"},
            {"verification", "not_requested"}};
}
void send(std::vector<INPUT> &events) {
    if (events.empty())
        return;
    auto n = SendInput(UINT(events.size()), events.data(), sizeof(INPUT));
    if (n != events.size())
        throw std::runtime_error(
            "SendInput incomplete: inserted=" + std::to_string(n) +
            "; outcome_unknown; check desktop and process integrity levels before retry");
}
void send(std::initializer_list<INPUT> items) { std::vector<INPUT> events(items); send(events); }
INPUT key(WORD vk, DWORD flags = 0, WORD scan = 0) {
    INPUT i{};
    i.type = INPUT_KEYBOARD;
    i.ki.wVk = vk;
    i.ki.wScan = scan;
    i.ki.dwFlags = flags;
    return i;
}
WORD vk(const std::string &s) {
    static const std::map<std::string, WORD> m = {
        {"CTRL", VK_CONTROL},  {"SHIFT", VK_SHIFT}, {"ALT", VK_MENU},    {"WIN", VK_LWIN},
        {"ENTER", VK_RETURN},  {"TAB", VK_TAB},     {"ESC", VK_ESCAPE},  {"BACKSPACE", VK_BACK},
        {"DELETE", VK_DELETE}, {"LEFT", VK_LEFT},   {"RIGHT", VK_RIGHT}, {"UP", VK_UP},
        {"DOWN", VK_DOWN},     {"HOME", VK_HOME},   {"END", VK_END},     {"SPACE", VK_SPACE}};
    auto it = m.find(s);
    if (it != m.end())
        return it->second;
    if (s.size() == 1 && ((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= '0' && s[0] <= '9')))
        return WORD(s[0]);
    throw std::invalid_argument("Unknown key; use uppercase key names");
}
} // namespace
struct Desktop::Impl {
    ComPtr<IUIAutomation> automation;
    struct Window {
        HWND hwnd;
        DWORD pid;
        std::wstring klass;
    };
    std::map<std::string, Window> windows;
    std::map<std::string, ComPtr<IUIAutomationElement>> elements;
    size_t serial = 0;
    const std::string reference_prefix =
        std::to_string(GetCurrentProcessId()) + "-" + std::to_string(GetTickCount64()) + "-";
    Impl() {
        check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "COM MTA initialization");
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        check(CoCreateInstance(CLSID_CUIAutomation, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&automation)),
              "Create UIAutomation");
    }
    ~Impl() {
        elements.clear();
        automation.Reset();
        CoUninitialize();
    }
    std::string window_ref(HWND h) {
        DWORD pid = 0;
        GetWindowThreadProcessId(h, &pid);
        wchar_t cls[256]{};
        GetClassNameW(h, cls, 256);
        for (auto &[id, w] : windows)
            if (w.hwnd == h && w.pid == pid && w.klass == cls)
                return id;
        auto id = "w" + reference_prefix + std::to_string(++serial);
        windows[id] = {h, pid, cls};
        return id;
    }
    HWND window(const Json &a) {
        auto id = a.at("windowRef").get<std::string>();
        auto it = windows.find(id);
        if (it == windows.end())
            throw std::invalid_argument("Unknown windowRef; list windows in this session");
        DWORD pid = 0;
        GetWindowThreadProcessId(it->second.hwnd, &pid);
        wchar_t cls[256]{};
        GetClassNameW(it->second.hwnd, cls, 256);
        if (!IsWindow(it->second.hwnd) || pid != it->second.pid || it->second.klass != cls)
            throw std::runtime_error("stale_window_ref");
        return it->second.hwnd;
    }
    Json window_json(HWND h) {
        wchar_t name[4096]{};
        GetWindowTextW(h, name, 4096);
        RECT r{};
        GetWindowRect(h, &r);
        DWORD pid = 0;
        GetWindowThreadProcessId(h, &pid);
        return {{"windowRef", window_ref(h)},
                {"title", utf8(name)},
                {"pid", pid},
                {"hwnd", reinterpret_cast<uintptr_t>(h)},
                {"bounds", rect(r)},
                {"visible", bool(IsWindowVisible(h))},
                {"minimized", bool(IsIconic(h))},
                {"foreground", h == GetForegroundWindow()},
                {"dpi", GetDpiForWindow(h)}};
    }
    ComPtr<IUIAutomationElement> element(const Json &a) {
        ComPtr<IUIAutomationElement> e;
        if (a.contains("elementRef")) {
            auto it = elements.find(a.at("elementRef").get<std::string>());
            if (it == elements.end())
                throw std::invalid_argument("Unknown elementRef; query in this session");
            e = it->second;
            int id;
            check(e->get_CurrentProcessId(&id), "stale_element_ref");
        } else if (a.contains("windowRef"))
            check(automation->ElementFromHandle(window(a), &e), "ElementFromHandle");
        else
            check(automation->GetRootElement(&e), "GetRootElement");
        return e;
    }
    Json describe(IUIAutomationElement *e, bool details = true) {
        std::string id;
        for (auto &[ref, old] : elements) {
            BOOL same = FALSE;
            if (SUCCEEDED(automation->CompareElements(e, old.Get(), &same)) && same) {
                id = ref;
                break;
            }
        }
        if (id.empty()) {
            id = "e" + reference_prefix + std::to_string(++serial);
            elements[id] = e;
        }
        BSTR s = nullptr;
        check(e->get_CurrentName(&s), "element name");
        auto name = bstr(s);
        s = nullptr;
        e->get_CurrentAutomationId(&s);
        auto aid = bstr(s);
        CONTROLTYPEID type = 0;
        e->get_CurrentControlType(&type);
        RECT r{};
        e->get_CurrentBoundingRectangle(&r);
        BOOL enabled = FALSE, off = TRUE;
        e->get_CurrentIsEnabled(&enabled);
        e->get_CurrentIsOffscreen(&off);
        int pid = 0;
        e->get_CurrentProcessId(&pid);
        Json ps = Json::array();
        if (details) for (auto &[n, p] : patterns) {
            ComPtr<IUnknown> obj;
            if (SUCCEEDED(e->GetCurrentPattern(p, &obj)) && obj)
                ps.push_back(n);
        }
        POINT pt{};
        BOOL got = FALSE;
        if (details) e->GetClickablePoint(&pt, &got);
        Json value = nullptr;
        if (std::find(ps.begin(), ps.end(), "value") != ps.end()) {
            try {
                s = nullptr;
                check(pattern<IUIAutomationValuePattern>(e, UIA_ValuePatternId)->get_CurrentValue(&s),
                      "value");
                value = bstr(s);
            } catch (...) {
            }
        }
        return {
            {"elementRef", id},
            {"name", name},
            {"automationId", aid},
            {"role", role(type)},
            {"controlType", type},
            {"pid", pid},
            {"bounds", rect(r)},
            {"enabled", bool(enabled)},
            {"offscreen", bool(off)},
            {"supportedPatterns", ps},
            {"value", value},
            {"clickablePoint",
             got ? Json{{"x", pt.x}, {"y", pt.y}, {"source", "uia"}, {"coordinateSpace", "screen_physical"}}
                 : Json(nullptr)}};
    }
    bool matches(const Json &e, const Json &s) {
        for (auto name : {"name", "automationId", "role", "pid"})
            if (s.contains(name) && e.at(name) != s.at(name))
                return false;
        if (s.contains("nameContains") && e.at("name").get<std::string>().find(
                                              s.at("nameContains").get<std::string>()) == std::string::npos)
            return false;
        return true;
    }
    Json query(const Json &a) {
        const auto started = std::chrono::steady_clock::now();
        const auto format = a.value("format", std::string("full"));
        if (format != "full" && format != "compact")
            throw std::invalid_argument("format must be full or compact");
        const bool early = a.value("stopAfterLimit", false);
        const int timeout = bounded(a, "queryTimeoutMs", 60000, 1, 600000);
        auto root = element(a);
        int limit = bounded(a, "limit", 50, 1, 10000), offset = bounded(a, "offset", 0, 0, 100000),
            depth = bounded(a, "depth", 8, 0, 64), budget = bounded(a, "nodeBudget", 5000, 1, 100000);
        ComPtr<IUIAutomationTreeWalker> walker;
        check(automation->get_ControlViewWalker(&walker), "Control walker");
        struct Node {
            ComPtr<IUIAutomationElement> e;
            int depth;
            std::string parent;
        };
        std::vector<Node> stack{{root, 0, ""}};
        Json rows = Json::array();
        int visited = 0, matched = 0;
        bool truncated = false;
        std::string stopReason = "complete";
        auto selector = a.value("selector", Json::object());
        while (!stack.empty()) {
            if (visited >= budget || std::chrono::steady_clock::now() - started >= std::chrono::milliseconds(timeout)) {
                truncated = true;
                stopReason = visited >= budget ? "nodeBudget" : "timeout";
                break;
            }
            ++visited;
            auto node = std::move(stack.back());
            stack.pop_back();
            Json row;
            try {
                row = describe(node.e.Get(), false);
            } catch (...) {
                truncated = true;
                stopReason = "providerError";
                continue;
            }
            row["depth"] = node.depth;
            row["parentRef"] = node.parent;
            if (matches(row, selector)) {
                if (matched++ >= offset && rows.size() < size_t(limit)) {
                    if (format == "full") {
                        auto detail = describe(node.e.Get());
                        detail["depth"] = node.depth;
                        detail["parentRef"] = node.parent;
                        row = std::move(detail);
                    } else {
                        BSTR value = nullptr;
                        ComPtr<IUIAutomationValuePattern> vp;
                        if (SUCCEEDED(node.e->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&vp))) && vp &&
                            SUCCEEDED(vp->get_CurrentValue(&value))) row["value"] = bstr(value);
                        for (auto key : {"automationId", "controlType", "pid", "supportedPatterns", "clickablePoint"}) row.erase(key);
                    }
                    rows.push_back(row);
                    if (early && rows.size() == size_t(limit)) {
                        truncated = true;
                        stopReason = "limit";
                        break;
                    }
                }
            }
            if (node.depth < depth) {
                std::vector<ComPtr<IUIAutomationElement>> children;
                ComPtr<IUIAutomationElement> child;
                if (SUCCEEDED(walker->GetFirstChildElement(node.e.Get(), &child)))
                    while (child) {
                        if (std::chrono::steady_clock::now() - started >= std::chrono::milliseconds(timeout)) {
                            truncated = true;
                            stopReason = "timeout";
                            break;
                        }
                        children.push_back(child);
                        ComPtr<IUIAutomationElement> next;
                        if (FAILED(walker->GetNextSiblingElement(child.Get(), &next))) {
                            truncated = true;
                            stopReason = "providerError";
                            break;
                        }
                        child = next;
                        if (children.size() >= size_t(budget)) {
                            truncated = true;
                            stopReason = "nodeBudget";
                            break;
                        }
                    }
                else { truncated = true; stopReason = "providerError"; }
                for (auto it = children.rbegin(); it != children.rend(); ++it)
                    stack.push_back({*it, node.depth + 1, row["elementRef"]});
            }
        }
        bool more = matched > offset + int(rows.size()) || truncated;
        Json out = {{"elements", rows},   {"matched", matched},
                    {"visited", visited}, {"truncated", truncated},
                    {"has_more", more},   {"next_offset", more ? Json(offset + rows.size()) : Json(nullptr)}};
        out["uniqueRef"] =
            matched == 1 && !truncated && rows.size() == 1 ? rows[0]["elementRef"] : Json(nullptr);
        out["stopReason"] = stopReason;
        if (a.value("metrics", false)) {
            const auto bytes = dump_json(out).size();
            out["metrics"] = {{"queryMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()},
                              {"payloadBytes", bytes}};
        }
        return out;
    }
    Json capture(const std::string &op, const Json &a) {
        RECT r{};
        HWND capture_window = nullptr;
        if (op == "capture.window") {
            auto h = window(a);
            capture_window = h;
            if (IsIconic(h))
                throw std::runtime_error(
                    "Window minimized; restore explicitly before visible-screen capture");
            GetWindowRect(h, &r);
        } else if (op == "capture.element") {
            check(element(a)->get_CurrentBoundingRectangle(&r), "element bounds");
        } else if (op == "capture.region") {
            r.left = a.at("x");
            r.top = a.at("y");
            r.right = r.left + bounded(a, "width", 0, 1, 32000);
            r.bottom = r.top + bounded(a, "height", 0, 1, 32000);
        } else {
            r.left = GetSystemMetrics(SM_XVIRTUALSCREEN);
            r.top = GetSystemMetrics(SM_YVIRTUALSCREEN);
            r.right = r.left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
            r.bottom = r.top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
        }
        int w = r.right - r.left, h = r.bottom - r.top;
        if (w <= 0 || h <= 0 || int64_t(w) * h > 64000000)
            throw std::invalid_argument("Invalid capture dimensions");
        auto screen = GetDC(nullptr);
        auto dc = CreateCompatibleDC(screen);
        BITMAPINFO info{};
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h;
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;
        void *bits = nullptr;
        auto bitmap = CreateDIBSection(screen, &info, DIB_RGB_COLORS, &bits, nullptr, 0);
        if (!bitmap || !dc) {
            if (bitmap)
                DeleteObject(bitmap);
            if (dc)
                DeleteDC(dc);
            ReleaseDC(nullptr, screen);
            throw std::runtime_error("Capture allocation failed");
        }
        auto old = SelectObject(dc, bitmap);
        auto requested_method = a.value("method", std::string("screen"));
        if (requested_method != "screen" && requested_method != "printWindow") {
            SelectObject(dc, old);
            DeleteObject(bitmap);
            DeleteDC(dc);
            ReleaseDC(nullptr, screen);
            throw std::invalid_argument("Capture method must be screen or printWindow");
        }
        if (requested_method == "printWindow" && !capture_window) {
            SelectObject(dc, old);
            DeleteObject(bitmap);
            DeleteDC(dc);
            ReleaseDC(nullptr, screen);
            throw std::invalid_argument("printWindow requires capture.window");
        }
        BOOL ok = requested_method == "printWindow"
                      ? PrintWindow(capture_window, dc, 2)
                      : BitBlt(dc, 0, 0, w, h, screen, r.left, r.top, SRCCOPY | CAPTUREBLT);
        DWORD capture_error = ok ? 0 : GetLastError();
        Image image{w, h, std::vector<uint8_t>(size_t(w) * h * 3)};
        if (ok) {
            auto *p = static_cast<uint8_t *>(bits);
            for (size_t i = 0; i < size_t(w) * h; ++i) {
                image.rgb[i * 3] = p[i * 4 + 2];
                image.rgb[i * 3 + 1] = p[i * 4 + 1];
                image.rgb[i * 3 + 2] = p[i * 4];
            }
        }
        SelectObject(dc, old);
        DeleteObject(bitmap);
        DeleteDC(dc);
        ReleaseDC(nullptr, screen);
        if (!ok)
            throw std::runtime_error("Capture failed: method=" + requested_method +
                                     "; win32=" + std::to_string(capture_error) +
                                     "; screen capture requires an available interactive desktop");
        auto output = std::filesystem::path(wide(a.at("output").get<std::string>()));
        save_png(image, output);
        return {{"path", utf8(std::filesystem::absolute(output).wstring())},
                {"imageRef", "img-sha256-" + file_sha256(output)},
                {"bounds", rect(r)},
                {"width", w},
                {"height", h},
                {"method", requested_method == "printWindow" ? "win32.PrintWindow" : "win32.BitBlt"},
                {"content", requested_method == "printWindow"
                                ? "application_rendered_window; some GPU applications may render blank"
                                : "visible_screen_pixels_including_occluders"},
                {"capturedAtUnixMs", std::chrono::duration_cast<std::chrono::milliseconds>(
                                         std::chrono::system_clock::now().time_since_epoch())
                                         .count()}};
    }
};
Desktop::Desktop() : impl_(std::make_unique<Impl>()) {}
Desktop::~Desktop() = default;
Json Desktop::operations() {
    auto result = Json::parse(
        R"(["system.info","process.list","display.list","window.list","window.get","window.foreground","window.activate","window.move","window.resize","window.minimize","window.maximize","window.restore","window.close","ui.tree","ui.find","ui.get","ui.at_point","ui.text","ui.focus","ui.invoke","ui.set_value","ui.fill","ui.select","ui.toggle","ui.expand","ui.collapse","ui.scroll","ui.set_range_value","capture.desktop","capture.window","capture.region","capture.element","input.move","input.click","input.scroll","input.drag","input.key_chord","input.type_text","clipboard.read","clipboard.write","runtime.capabilities"])");
    for (auto op : {"app.launch", "capture.display", "ui.selection", "clipboard.formats", "ui.fill_form", "ui.reveal", "window.children", "ui.message_text", "ui.context_menu", "system.session"})
        result.push_back(op);
    return result;
}
Json Desktop::execute(const std::string &op, const Json &a) {
    auto &p = *impl_;
    auto supported = operations();
    if (std::find(supported.begin(), supported.end(), op) == supported.end())
        throw std::invalid_argument("Unknown operation: " + op);
    if (!a.is_object())
        throw std::invalid_argument("args must be an object");
    if (op == "app.launch") {
        auto executable = wide(a.at("executable").get<std::string>());
        auto quote = [](const std::wstring &input) {
            std::wstring out = L"\"";
            size_t slashes = 0;
            for (auto c : input) {
                if (c == L'\\') {
                    ++slashes;
                    continue;
                }
                if (c == L'\"') {
                    out.append(slashes * 2 + 1, L'\\');
                    out += c;
                } else {
                    out.append(slashes, L'\\');
                    out += c;
                }
                slashes = 0;
            }
            out.append(slashes * 2, L'\\');
            return out + L"\"";
        };
        auto command = quote(executable);
        for (auto &arg : a.value("arguments", Json::array()))
            command += L" " + quote(wide(arg.get<std::string>()));
        auto working = wide(a.value("workingDirectory", std::string{}));
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = a.value("hidden", false) ? SW_HIDE : SW_SHOWNORMAL;
        PROCESS_INFORMATION child{};
        if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
                            a.value("hidden", false) ? CREATE_NO_WINDOW : 0, nullptr,
                            working.empty() ? nullptr : working.c_str(), &startup, &child))
            throw std::runtime_error("CreateProcess failed: " + std::to_string(GetLastError()));
        auto result = receipt("win32.CreateProcess");
        result["pid"] = child.dwProcessId;
        CloseHandle(child.hProcess);
        CloseHandle(child.hThread);
        return result;
    }
    if (op == "capture.display") {
        auto displays = execute("display.list", Json::object())["displays"];
        for (auto &display : displays)
            if (display["name"] == a.at("displayName")) {
                auto args = a;
                for (auto key : {"x", "y", "width", "height"})
                    args[key] = display["bounds"][key];
                return p.capture("capture.region", args);
            }
        throw std::invalid_argument("Unknown displayName; query display.list");
    }
    if (op == "clipboard.formats") {
        if (!OpenClipboard(nullptr))
            throw std::runtime_error("Clipboard busy");
        Json formats = Json::array();
        UINT format = 0;
        while ((format = EnumClipboardFormats(format)) != 0) {
            wchar_t name[256]{};
            GetClipboardFormatNameW(format, name, 256);
            formats.push_back(
                {{"id", format}, {"name", format == CF_UNICODETEXT ? "CF_UNICODETEXT" : utf8(name)}});
        }
        CloseClipboard();
        return {{"formats", formats}};
    }
    if (op == "runtime.capabilities")
        return {{"operations", operations()},
                {"coordinateSpace", "screen_physical"},
                {"captureMethod", "visible screen BitBlt"},
                {"references", "session-local; UIA live elements"},
                {"pythonRequired", false}};
    if (op == "system.session") {
        Json out = {{"sessionId", nullptr}, {"lockState", "unknown"},
                    {"connectionState", nullptr}, {"threadDesktop", nullptr},
                    {"inputDesktop", nullptr}, {"inputDesktopAccessible", false},
                    {"threadOnInputDesktop", nullptr}};
        Json errors = Json::object();
        DWORD sessionId = 0;
        if (ProcessIdToSessionId(GetCurrentProcessId(), &sessionId)) {
            out["sessionId"] = sessionId;
            LPWSTR buffer = nullptr;
            DWORD bytes = 0;
            if (WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, sessionId,
                                           WTSSessionInfoEx, &buffer, &bytes)) {
                if (buffer && bytes >= sizeof(WTSINFOEXW)) {
                    auto info = reinterpret_cast<const WTSINFOEXW *>(buffer);
                    if (info->Level == 1) {
                        auto &level = info->Data.WTSInfoExLevel1;
                        out["connectionState"] = static_cast<int>(level.SessionState);
                        if (level.SessionFlags == WTS_SESSIONSTATE_LOCK)
                            out["lockState"] = "locked";
                        else if (level.SessionFlags == WTS_SESSIONSTATE_UNLOCK)
                            out["lockState"] = "unlocked";
                    } else {
                        errors["sessionInfoLevel"] = info->Level;
                    }
                } else {
                    errors["sessionInfoBytes"] = bytes;
                }
                WTSFreeMemory(buffer);
            } else {
                errors["sessionQuery"] = GetLastError();
            }
        } else {
            errors["sessionId"] = GetLastError();
        }
        auto desktopName = [&](HDESK desktop, const char *key) {
            DWORD bytes = 0;
            GetUserObjectInformationW(desktop, UOI_NAME, nullptr, 0, &bytes);
            if (!bytes) {
                errors[key] = GetLastError();
                return;
            }
            std::vector<wchar_t> name(bytes / sizeof(wchar_t) + 1, 0);
            if (GetUserObjectInformationW(desktop, UOI_NAME, name.data(), bytes, &bytes))
                out[key] = utf8(name.data());
            else
                errors[key] = GetLastError();
        };
        auto threadDesktop = GetThreadDesktop(GetCurrentThreadId());
        if (threadDesktop) {
            desktopName(threadDesktop, "threadDesktop");
            BOOL onInput = FALSE;
            DWORD bytes = 0;
            if (GetUserObjectInformationW(threadDesktop, UOI_IO, &onInput, sizeof(onInput), &bytes))
                out["threadOnInputDesktop"] = onInput != FALSE;
            else
                errors["threadOnInputDesktop"] = GetLastError();
        } else {
            errors["threadDesktop"] = GetLastError();
        }
        auto inputDesktop = OpenInputDesktop(0, FALSE, DESKTOP_READOBJECTS);
        if (inputDesktop) {
            out["inputDesktopAccessible"] = true;
            desktopName(inputDesktop, "inputDesktop");
            CloseDesktop(inputDesktop);
        } else {
            errors["inputDesktop"] = GetLastError();
        }
        if (!errors.empty())
            out["errors"] = std::move(errors);
        return out;
    }
    if (op == "system.info") {
        SYSTEM_INFO i{};
        GetNativeSystemInfo(&i);
        POINT pt{};
        GetCursorPos(&pt);
        return {{"processors", i.dwNumberOfProcessors},
                {"architecture", i.wProcessorArchitecture},
                {"pointer", {{"x", pt.x}, {"y", pt.y}}},
                {"foreground", GetForegroundWindow() ? p.window_json(GetForegroundWindow()) : Json(nullptr)}};
    }
    if (op == "process.list") {
        HANDLE h = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (h == INVALID_HANDLE_VALUE)
            throw std::runtime_error("Process snapshot failed");
        PROCESSENTRY32W e{};
        e.dwSize = sizeof(e);
        Json rows = Json::array();
        if (Process32FirstW(h, &e))
            do {
                rows.push_back({{"pid", e.th32ProcessID},
                                {"parentPid", e.th32ParentProcessID},
                                {"name", utf8(e.szExeFile)}});
            } while (Process32NextW(h, &e));
        CloseHandle(h);
        return {{"processes", rows}};
    }
    if (op == "display.list") {
        Json rows = Json::array();
        EnumDisplayMonitors(
            nullptr, nullptr,
            [](HMONITOR h, HDC, LPRECT, LPARAM arg) -> BOOL {
                MONITORINFOEXW m{};
                m.cbSize = sizeof(m);
                if (GetMonitorInfoW(h, &m))
                    reinterpret_cast<Json *>(arg)->push_back(
                        {{"name", utf8(m.szDevice)},
                         {"bounds", rect(m.rcMonitor)},
                         {"workArea", rect(m.rcWork)},
                         {"primary", bool(m.dwFlags & MONITORINFOF_PRIMARY)}});
                return TRUE;
            },
            reinterpret_cast<LPARAM>(&rows));
        return {{"displays", rows}};
    }
    if (op == "window.children") {
        const auto parent = p.window(a);
        std::vector<HWND> children;
        EnumChildWindows(parent, [](HWND h, LPARAM data) -> BOOL {
            reinterpret_cast<std::vector<HWND>*>(data)->push_back(h); return TRUE;
        }, reinterpret_cast<LPARAM>(&children));
        Json rows = Json::array();
        for (auto h : children) {
            wchar_t cls[256]{};
            GetClassNameW(h, cls, 256);
            const auto klass = utf8(cls);
            if (a.contains("className") && klass != a["className"].get<std::string>()) continue;
            auto row = p.window_json(h);
            row["className"] = klass;
            row["threadId"] = GetWindowThreadProcessId(h, nullptr);
            rows.push_back(row);
        }
        return {{"windows", rows}};
    }
    if (op == "window.list") {
        std::vector<HWND> handles;
        EnumWindows(
            [](HWND h, LPARAM arg) -> BOOL {
                reinterpret_cast<std::vector<HWND> *>(arg)->push_back(h);
                return TRUE;
            },
            reinterpret_cast<LPARAM>(&handles));
        Json rows = Json::array();
        auto query = a.value("titleContains", std::string{});
        for (auto h : handles) {
            if (!a.value("includeHidden", false) && !IsWindowVisible(h))
                continue;
            auto row = p.window_json(h);
            if (a.contains("pid") && row["pid"] != a["pid"])
                continue;
            if (row["title"].get<std::string>().find(query) != std::string::npos)
                rows.push_back(row);
        }
        return {{"windows", rows}};
    }
    if (op == "window.foreground")
        return GetForegroundWindow() ? p.window_json(GetForegroundWindow()) : Json(nullptr);
    if (op == "window.get")
        return p.window_json(p.window(a));
    if (op.starts_with("window.")) {
        if (a.value("preserveWindowGeometry", false) && (op == "window.move" || op == "window.resize" ||
                                                         op == "window.maximize" || op == "window.restore"))
            throw std::invalid_argument(
                "preserveWindowGeometry conflicts with requested window geometry change");
        auto h = p.window(a);
        if (op == "window.activate") {
            if (!SetForegroundWindow(h))
                throw std::runtime_error("Foreground request denied by Windows");
        } else if (op == "window.close") {
            if (!PostMessageW(h, WM_CLOSE, 0, 0))
                throw std::runtime_error("WM_CLOSE dispatch failed");
        } else if (op == "window.minimize")
            ShowWindowAsync(h, SW_MINIMIZE);
        else if (op == "window.maximize")
            ShowWindowAsync(h, SW_MAXIMIZE);
        else if (op == "window.restore")
            ShowWindowAsync(h, SW_RESTORE);
        else if (op == "window.move" || op == "window.resize") {
            if (a.value("preserveWindowGeometry", false))
                throw std::invalid_argument("preserveWindowGeometry conflicts with move/resize");
            RECT r{};
            GetWindowRect(h, &r);
            bool move = op == "window.move";
            if (!SetWindowPos(h, nullptr, move ? a.at("x").get<int>() : r.left,
                              move ? a.at("y").get<int>() : r.top,
                              move ? r.right - r.left : bounded(a, "width", 0, 1, 32000),
                              move ? r.bottom - r.top : bounded(a, "height", 0, 1, 32000),
                              SWP_NOZORDER | SWP_NOACTIVATE))
                throw std::runtime_error("SetWindowPos failed");
        } else
            throw std::invalid_argument("Unknown window operation");
        auto r = receipt("win32");
        r["target"] = p.window_json(h);
        return r;
    }
    if (op == "ui.tree" || op == "ui.find")
        return p.query(a);
    if (op == "ui.fill_form") {
        InputLock lock;
        return fill_form(a, [&](const std::string& operation, const Json& args) { return execute(operation, args); },
            [](int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); });
    }
    if (op == "ui.at_point") {
        ComPtr<IUIAutomationElement> e;
        POINT pt{a.at("x"), a.at("y")};
        check(p.automation->ElementFromPoint(pt, &e), "ElementFromPoint");
        return p.describe(e.Get());
    }
    if (op.starts_with("ui.")) {
        auto e = p.element(a);
        if (op == "ui.context_menu") {
            ComPtr<IUIAutomationElement3> extended;
            check(e.As(&extended), "Context menu interface");
            check(extended->ShowContextMenu(), "Show context menu");
            return {{"status", "ok"}, {"verification", "not_requested"}};
        }
        if (op == "ui.message_text") {
            InputLock lock;
            const auto started = std::chrono::steady_clock::now();
            const auto host = p.window(a);
            int elementPid = 0;
            DWORD hostPid = 0;
            check(e->get_CurrentProcessId(&elementPid), "Message target process");
            GetWindowThreadProcessId(host, &hostPid);
            if (hostPid != DWORD(elementPid)) throw std::invalid_argument("Window and element belong to different processes");
            const auto text = a.at("text").get<std::string>();
            if (text.find('\0') != std::string::npos || text.size() > 65536)
                throw std::invalid_argument("Message text must be NUL-free and at most 65536 bytes");
            const auto placement = a.value("placement", std::string("append"));
            if (placement != "append" && placement != "replace") throw std::invalid_argument("placement must be append or replace");
            const int deleteTail = bounded(a, "deleteTail", 0, 0, 4096);
            const int verifyTimeout = bounded(a, "verifyTimeoutMs", 3000, 0, 10000);
            if (deleteTail && placement != "append") throw std::invalid_argument("deleteTail requires append placement");
            auto vp = pattern<IUIAutomationValuePattern>(e.Get(), UIA_ValuePatternId);
            auto read = [&] { BSTR s = nullptr; check(vp->get_CurrentValue(&s), "Message text readback"); return bstr(s); };
            const auto before = read();
            if (a.contains("expectedSuffix") && !before.ends_with(a.at("expectedSuffix").get<std::string>()))
                return {{"status", "error"}, {"verification", "failed"},
                        {"message", "Expected suffix changed; no messages sent"}, {"sentUtf16Units", 0}};
            const size_t retained = utf8_tail_offset(before, size_t(deleteTail));
            const auto expected = placement == "append" ? before.substr(0, retained) + text : text;
            auto tp = pattern<IUIAutomationTextPattern>(e.Get(), UIA_TextPatternId);
            ComPtr<IUIAutomationTextRange> document;
            check(tp->get_DocumentRange(&document), "Message text range");
            if (placement == "append")
                check(document->MoveEndpointByRange(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_End), "Message append position");
            check(e->SetFocus(), "Message text focus");
            check(document->Select(), "Message text selection");
            const auto selectionDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
            bool selectionReady = false;
            Json selectionDiagnostic;
            do {
                ComPtr<IUIAutomationTextRangeArray> selected;
                check(tp->GetSelection(&selected), "Message selection readback");
                int count = 0; check(selected->get_Length(&count), "Message selection count");
                if (count == 1) {
                    ComPtr<IUIAutomationTextRange> range;
                    check(selected->GetElement(0, &range), "Message selected range");
                    int start = 1, end = 1;
                    check(range->CompareEndpoints(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_Start, &start), "Message selection start");
                    check(range->CompareEndpoints(TextPatternRangeEndpoint_End, document.Get(), TextPatternRangeEndpoint_End, &end), "Message selection end");
                    BSTR selectedText = nullptr, targetText = nullptr;
                    check(range->GetText(4096, &selectedText), "Message selection text");
                    check(document->GetText(4096, &targetText), "Message target text");
                    const auto selectedValue = bstr(selectedText), targetValue = bstr(targetText);
                    selectionDiagnostic = {{"startComparison", start}, {"endComparison", end},
                        {"selectedBytes", selectedValue.size()}, {"targetBytes", targetValue.size()}};
                    selectionReady = start == 0 && end == 0;
                    if (!selectionReady && placement == "append" && selectedValue.empty()) {
                        int collapsed = 1;
                        check(range->CompareEndpoints(TextPatternRangeEndpoint_Start, range.Get(), TextPatternRangeEndpoint_End, &collapsed), "Message caret collapsed");
                        if (!collapsed && start == end) {
                            ComPtr<IUIAutomationTextRange> gap;
                            check(document->Clone(&gap), "Message boundary gap");
                            if (start > 0)
                                check(gap->MoveEndpointByRange(TextPatternRangeEndpoint_End, range.Get(), TextPatternRangeEndpoint_Start), "Message gap end");
                            else
                                check(gap->MoveEndpointByRange(TextPatternRangeEndpoint_Start, range.Get(), TextPatternRangeEndpoint_Start), "Message gap start");
                            BSTR gapText = nullptr;
                            check(gap->GetText(4096, &gapText), "Message gap text");
                            const auto gapValue = bstr(gapText);
                            selectionDiagnostic["gapBytes"] = gapValue.size();
                            // Providers may represent the same visual caret with adjacent
                            // empty boundary nodes. Only accept an exactly empty text gap.
                            selectionReady = gapValue.empty();
                        }
                    }
                }
                if (selectionReady) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
            } while (std::chrono::steady_clock::now() < selectionDeadline);
            if (!selectionReady) return {{"status", "error"}, {"verification", "failed"},
                {"message", "Selection not confirmed; no messages sent"}, {"selection", selectionDiagnostic}, {"sentUtf16Units", 0}};
            BOOL focused = FALSE;
            check(e->get_CurrentHasKeyboardFocus(&focused), "Message focus verification");
            if (!focused) throw std::runtime_error("Target does not have keyboard focus; no messages sent");
            size_t sent = 0;
            const auto w = wide(text);
            std::string error;
            size_t deleted = 0;
            for (int i = 0; i < deleteTail; ++i) {
                if (!send_editing_key(host, VK_BACK, L'\b')) {
                    error = "Backspace message dispatch failed"; break;
                }
                ++deleted;
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            if (deleteTail) {
                const auto deletionDeadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(verifyTimeout);
                auto actual = read();
                while (error.empty() && actual != before.substr(0, retained) && std::chrono::steady_clock::now() < deletionDeadline) {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100)); actual = read();
                }
                if (actual != before.substr(0, retained)) error = "Tail deletion not verified; insertion skipped";
            }
            for (auto ch : w) {
                if (!error.empty()) break;
                DWORD_PTR ignored = 0;
                if (ch == L'\n') {
                    if (!send_editing_key(host, VK_RETURN, L'\r')) {
                        error = "Enter message dispatch failed"; break;
                    }
                    ++sent;
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                    continue;
                }
                if (!SendMessageTimeoutW(host, WM_CHAR, ch == L'\n' ? L'\r' : ch, 1,
                    SMTO_ABORTIFHUNG | SMTO_BLOCK, 500, &ignored)) {
                    error = "WM_CHAR dispatch failed: " + std::to_string(GetLastError()); break;
                }
                ++sent;
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }
            const auto until = std::chrono::steady_clock::now() + std::chrono::milliseconds(error.empty() ? verifyTimeout : 0);
            auto actual = read();
            while (actual != expected && std::chrono::steady_clock::now() < until) {
                std::this_thread::sleep_for(std::chrono::milliseconds(100)); actual = read();
            }
            const bool ok = error.empty() && actual == expected;
            Json result = {{"status", ok ? "ok" : "error"}, {"verification", ok ? "passed" : "failed"},
                {"methodUsed", "win32.WM_CHAR"}, {"sentUtf16Units", sent}, {"diff", text_diff(expected, actual)},
                {"backspacesSent", deleted},
                {"expectedBytes", expected.size()}, {"actualBytes", actual.size()},
                {"elapsedMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()}};
            if (!error.empty()) result["message"] = error;
            return result;
        }
        if (op == "ui.reveal") {
            ComPtr<IUIAutomationScrollItemPattern> item;
            if (SUCCEEDED(e->GetCurrentPatternAs(UIA_ScrollItemPatternId, IID_PPV_ARGS(&item))) && item)
                check(item->ScrollIntoView(), "Scroll item into view");
            else {
                auto tp = pattern<IUIAutomationTextPattern>(e.Get(), UIA_TextPatternId);
                ComPtr<IUIAutomationTextRange> document;
                check(tp->get_DocumentRange(&document), "Reveal text range");
                check(document->ScrollIntoView(TRUE), "Reveal text");
            }
            return {{"status", "ok"}, {"verification", "not_requested"}};
        }
        if (op == "ui.fill") {
            InputLock input_lock;
            const auto started = std::chrono::steady_clock::now();
            const auto text = a.at("text").get<std::string>();
            if (text.find('\0') != std::string::npos) throw std::invalid_argument("Text contains NUL");
            auto method = a.value("method", std::string("auto"));
            if (method != "auto" && method != "value" && method != "keyboard" && method != "legacy")
                throw std::invalid_argument("method must be auto, value, legacy or keyboard");
            const int timeout = bounded(a, "timeoutMs", 10000, 1, 60000);
            const int delay = bounded(a, "charDelayMs", 0, 0, 100);
            const auto deadline = started + std::chrono::milliseconds(timeout);
            // Native multiline controls expose CRLF; compare logical line breaks, not layout bytes.
            auto normalize = [](const std::string &s) {
                std::string out;
                for (size_t i = 0; i < s.size(); ++i) {
                    if (s[i] == '\r') { out += '\n'; if (i + 1 < s.size() && s[i + 1] == '\n') ++i; }
                    else out += s[i];
                }
                return out;
            };
            const auto expected = normalize(text);
            const auto diagnosticPath = a.value("diagnosticPath", std::string{});
            Json samples = Json::array();
            size_t polls = 0, sentUnits = 0;
            std::string selectionMethod = "not_needed";
            ComPtr<IUIAutomationValuePattern> vp;
            e->GetCurrentPatternAs(UIA_ValuePatternId, IID_PPV_ARGS(&vp));
            if (vp) { BOOL readOnly = TRUE; check(vp->get_CurrentIsReadOnly(&readOnly), "ReadOnly");
                if (readOnly) throw std::runtime_error("Target is read-only"); }
            auto read = [&]() {
                BSTR value = nullptr;
                // Classic Win32 Edit providers may expose only a truncated ValuePattern.
                UIA_HWND native{};
                if (SUCCEEDED(e->get_CurrentNativeWindowHandle(&native)) && native) {
                    HWND h = reinterpret_cast<HWND>(native);
                    wchar_t className[128]{};
                    GetClassNameW(h, className, 128);
                    if (_wcsicmp(className, L"Edit") == 0 || _wcsnicmp(className, L"RichEdit", 8) == 0) {
                        DWORD_PTR length = 0, copied = 0;
                        if (!SendMessageTimeoutW(h, WM_GETTEXTLENGTH, 0, 0, SMTO_ABORTIFHUNG, 250, &length))
                            throw std::runtime_error("Native text length timed out");
                        if (length > 10000000) throw std::runtime_error("Native text exceeds readback budget");
                        std::wstring buffer(size_t(length) + 1, L'\0');
                        if (!SendMessageTimeoutW(h, WM_GETTEXT, buffer.size(), reinterpret_cast<LPARAM>(buffer.data()),
                                                 SMTO_ABORTIFHUNG, 250, &copied))
                            throw std::runtime_error("Native text readback timed out");
                        buffer.resize(size_t(copied));
                        return normalize(utf8(buffer));
                    }
                }
                ComPtr<IUIAutomationTextPattern> tp;
                if (SUCCEEDED(e->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&tp))) && tp) {
                    ComPtr<IUIAutomationTextRange> document, range;
                    check(tp->get_DocumentRange(&document), "Fill text range");
                    check(document->Clone(&range), "Fill range clone");
                    check(range->MoveEndpointByRange(TextPatternRangeEndpoint_End, range.Get(), TextPatternRangeEndpoint_Start), "Fill collapse range");
                    std::string full;
                    for (;;) {
                        int remaining = 0;
                        check(range->CompareEndpoints(TextPatternRangeEndpoint_Start, document.Get(), TextPatternRangeEndpoint_End, &remaining), "Fill range remaining");
                        if (remaining >= 0) break;
                        int moved = 0;
                        check(range->MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, 1024, &moved), "Fill advance range");
                        if (!moved) throw std::runtime_error("Text provider made no readback progress");
                        int beyond = 0;
                        check(range->CompareEndpoints(TextPatternRangeEndpoint_End, document.Get(), TextPatternRangeEndpoint_End, &beyond), "Fill range boundary");
                        if (beyond > 0)
                            check(range->MoveEndpointByRange(TextPatternRangeEndpoint_End, document.Get(), TextPatternRangeEndpoint_End), "Fill clamp to document");
                        check(range->GetText(-1, &value), "Fill text readback");
                        full += bstr(value);
                        value = nullptr;
                        check(range->MoveEndpointByRange(TextPatternRangeEndpoint_Start, range.Get(), TextPatternRangeEndpoint_End), "Fill consume range");
                    }
                    return normalize(full);
                } else if (vp) check(vp->get_CurrentValue(&value), "Fill readback");
                else throw std::runtime_error("No text readback available");
                return normalize(bstr(value));
            };
            auto actual = read(); // Require a verifiable target before mutating it.
            const auto initial = actual;
            std::string used = "unchanged";
            auto verifyUntil = [&](auto end) {
                do {
                    actual = read();
                    ++polls;
                    if (!diagnosticPath.empty() && samples.size() < 16)
                        samples.push_back({{"elapsedMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()}, {"bytes", actual.size()}, {"diff", text_diff(expected, actual)}});
                    if (actual == expected) return true;
                    if (std::chrono::steady_clock::now() >= end) break;
                    std::this_thread::sleep_for(std::chrono::milliseconds(25));
                } while (true);
                return false;
            };
            if (actual != expected && method == "legacy") {
                used = "legacy";
                auto lp = pattern<IUIAutomationLegacyIAccessiblePattern>(e.Get(), UIA_LegacyIAccessiblePatternId);
                const auto w = wide(text);
                check(lp->SetValue(w.c_str()), "Legacy SetValue");
                verifyUntil(deadline);
            }
            if (actual != expected && (method == "auto" || method == "value")) {
                if (vp) {
                    used = "value";
                    const auto w = wide(text);
                    BSTR value = SysAllocStringLen(w.data(), UINT(w.size()));
                    if (!value) throw std::bad_alloc();
                    const auto hr = vp->SetValue(value);
                    SysFreeString(value);
                    if (method == "value") check(hr, "Fill SetValue");
                    if (SUCCEEDED(hr)) verifyUntil(method == "value" ? deadline :
                        std::min(deadline, std::chrono::steady_clock::now() + std::chrono::milliseconds(500)));
                } else if (method == "value") throw std::runtime_error("ValuePattern unavailable");
            }
            if (actual != expected && (method == "auto" || method == "keyboard") && std::chrono::steady_clock::now() < deadline) {
                BOOL enabled = FALSE;
                check(e->get_CurrentIsEnabled(&enabled), "Fill enabled");
                if (!enabled) throw std::runtime_error("Target is disabled");
                check(e->SetFocus(), "Fill focus");
                auto focused = [&] {
                    ComPtr<IUIAutomationElement> f;
                    BOOL same = FALSE;
                    check(p.automation->GetFocusedElement(&f), "Fill focused element");
                    check(p.automation->CompareElements(e.Get(), f.Get(), &same), "Fill compare focus");
                    if (!same) throw std::runtime_error("Fill interrupted: target lost focus; inspect before retry");
                };
                focused();
                used = "keyboard";
                UIA_HWND native{};
                wchar_t className[128]{};
                e->get_CurrentNativeWindowHandle(&native);
                if (native) GetClassNameW(reinterpret_cast<HWND>(native), className, 128);
                if (native && (_wcsicmp(className, L"Edit") == 0 || _wcsnicmp(className, L"RichEdit", 8) == 0)) {
                    selectionMethod = "native";
                    DWORD_PTR ignored = 0;
                    if (!SendMessageTimeoutW(reinterpret_cast<HWND>(native), EM_SETSEL, 0, -1, SMTO_ABORTIFHUNG, 250, &ignored))
                        throw std::runtime_error("Native text selection timed out");
                } else {
                    // Rich editors may process Ctrl+A asynchronously. Prefer selecting the
                    // document through their accessibility provider when supported.
                    ComPtr<IUIAutomationTextPattern> tp;
                    ComPtr<IUIAutomationTextRange> document;
                    const bool selected = SUCCEEDED(e->GetCurrentPatternAs(UIA_TextPatternId, IID_PPV_ARGS(&tp))) && tp &&
                        SUCCEEDED(tp->get_DocumentRange(&document)) && document && SUCCEEDED(document->Select());
                    selectionMethod = selected ? "text_pattern" : "keyboard";
                    if (!selected) send({key(VK_CONTROL), key('A'), key('A', KEYEVENTF_KEYUP), key(VK_CONTROL, KEYEVENTF_KEYUP)});
                }
                std::this_thread::sleep_for(std::chrono::milliseconds(30));
                const auto w = wide(expected);
                if (w.empty()) send({key(VK_BACK), key(VK_BACK, KEYEVENTF_KEYUP)});
                for (size_t i = 0; i < w.size();) {
                    if (std::chrono::steady_clock::now() >= deadline) break;
                    focused();
                    std::vector<INPUT> events;
                    const auto end = std::min(w.size(), i + (delay ? size_t(1) : size_t(32)));
                    do {
                        const auto ch = w[i++];
                        events.push_back(ch == L'\n' ? key(VK_RETURN) : key(0, KEYEVENTF_UNICODE, ch));
                        events.push_back(ch == L'\n' ? key(VK_RETURN, KEYEVENTF_KEYUP) : key(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, ch));
                        // Keep UTF-16 surrogate pairs together even at a chunk boundary.
                    } while (i < w.size() && (i < end || (w[i - 1] >= 0xD800 && w[i - 1] <= 0xDBFF && w[i] >= 0xDC00 && w[i] <= 0xDFFF)));
                    send(events);
                    sentUnits = i;
                    if (delay) std::this_thread::sleep_for(std::chrono::milliseconds(delay));
                }
                verifyUntil(deadline);
            }
            const bool ok = actual == expected;
            Json result = {{"status", ok ? "ok" : "error"}, {"verification", ok ? "passed" : "failed"},
                    {"methodUsed", used}, {"elementRef", a.at("elementRef")},
                    {"expectedBytes", expected.size()}, {"actualBytes", actual.size()},
                    {"expectedLines", expected.empty() ? 0 : 1 + std::count(expected.begin(), expected.end(), '\n')},
                    {"actualLines", actual.empty() ? 0 : 1 + std::count(actual.begin(), actual.end(), '\n')},
                    {"elapsedMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count()}};
            if (!ok) {
                result["diff"] = text_diff(expected, actual);
                result["selectionMethod"] = selectionMethod;
                result["sentUtf16Units"] = sentUnits;
                result["polls"] = polls;
            }
            if (!ok && !diagnosticPath.empty()) {
                try {
                    write_json(diagnosticPath, {{"initial", initial}, {"expected", expected}, {"actual", actual},
                        {"samples", samples}, {"result", result}});
                    result["diagnosticPath"] = diagnosticPath;
                } catch (const std::exception& error) {
                    result["diagnosticError"] = error.what();
                }
            }
            return result;
        }
        if (op == "ui.selection") {
            Json selected = Json::array();
            ComPtr<IUnknown> available;
            if (SUCCEEDED(e->GetCurrentPattern(UIA_TextPatternId, &available)) && available) {
                ComPtr<IUIAutomationTextRangeArray> ranges;
                check(pattern<IUIAutomationTextPattern>(e.Get(), UIA_TextPatternId)->GetSelection(&ranges),
                      "Text selection");
                int length = 0;
                check(ranges->get_Length(&length), "Selection length");
                for (int i = 0; i < length; ++i) {
                    ComPtr<IUIAutomationTextRange> range;
                    check(ranges->GetElement(i, &range), "Selection range");
                    BSTR s = nullptr;
                    check(range->GetText(bounded(a, "maxLength", 65536, 1, 10000000), &s), "Selection text");
                    selected.push_back(bstr(s));
                }
                return {{"textRanges", selected}};
            }
            ComPtr<IUIAutomationElementArray> items;
            check(pattern<IUIAutomationSelectionPattern>(e.Get(), UIA_SelectionPatternId)
                      ->GetCurrentSelection(&items),
                  "Item selection");
            int length = 0;
            check(items->get_Length(&length), "Selection length");
            for (int i = 0; i < length; ++i) {
                ComPtr<IUIAutomationElement> item;
                check(items->GetElement(i, &item), "Selection element");
                selected.push_back(p.describe(item.Get()));
            }
            return {{"elements", selected}};
        }
        if (op == "ui.get")
            return p.describe(e.Get());
        if (op == "ui.text") {
            auto text = pattern<IUIAutomationTextPattern>(e.Get(), UIA_TextPatternId);
            ComPtr<IUIAutomationTextRange> range;
            check(text->get_DocumentRange(&range), "DocumentRange");
            BSTR s = nullptr;
            check(range->GetText(bounded(a, "maxLength", 65536, 1, 10000000), &s), "GetText");
            return {{"text", bstr(s)}};
        }
        if (op == "ui.focus")
            check(e->SetFocus(), "SetFocus");
        else if (op == "ui.invoke")
            check(pattern<IUIAutomationInvokePattern>(e.Get(), UIA_InvokePatternId)->Invoke(), "Invoke");
        else if (op == "ui.set_value") {
            auto text = wide(a.at("value").get<std::string>());
            auto value_pattern = pattern<IUIAutomationValuePattern>(e.Get(), UIA_ValuePatternId);
            BSTR value = SysAllocStringLen(text.data(), UINT(text.size()));
            if (!value)
                throw std::bad_alloc();
            auto hr = value_pattern->SetValue(value);
            SysFreeString(value);
            check(hr, "SetValue");
            const auto until = std::chrono::steady_clock::now() +
                std::chrono::milliseconds(bounded(a, "verifyTimeoutMs", 1000, 0, 60000));
            do {
                BSTR current = nullptr;
                check(value_pattern->get_CurrentValue(&current), "SetValue readback");
                if (bstr(current) == a.at("value").get<std::string>()) break;
                if (std::chrono::steady_clock::now() >= until) break;
                std::this_thread::sleep_for(std::chrono::milliseconds(25));
            } while (true);
        } else if (op == "ui.toggle")
            check(pattern<IUIAutomationTogglePattern>(e.Get(), UIA_TogglePatternId)->Toggle(), "Toggle");
        else if (op == "ui.select")
            check(pattern<IUIAutomationSelectionItemPattern>(e.Get(), UIA_SelectionItemPatternId)->Select(),
                  "Select");
        else if (op == "ui.expand" || op == "ui.collapse") {
            auto v = pattern<IUIAutomationExpandCollapsePattern>(e.Get(), UIA_ExpandCollapsePatternId);
            check(op == "ui.expand" ? v->Expand() : v->Collapse(), "ExpandCollapse");
        } else if (op == "ui.set_range_value")
            check(pattern<IUIAutomationRangeValuePattern>(e.Get(), UIA_RangeValuePatternId)
                      ->SetValue(a.at("value").get<double>()),
                  "SetRangeValue");
        else if (op == "ui.scroll")
            check(pattern<IUIAutomationScrollPattern>(e.Get(), UIA_ScrollPatternId)
                      ->SetScrollPercent(a.value("horizontal", -1.0), a.value("vertical", -1.0)),
                  "SetScrollPercent");
        else
            throw std::invalid_argument("Unknown UI operation");
        auto r = receipt(op);
        r["target"] = p.describe(e.Get());
        if (op == "ui.set_value")
            r["verification"] = r["target"]["value"] == a["value"] ? "passed" : "failed";
        return r;
    }
    if (op.starts_with("capture."))
        return p.capture(op, a);
    if (op == "clipboard.read" || op == "clipboard.write") {
        if (!OpenClipboard(nullptr))
            throw std::runtime_error("Clipboard busy");
        struct Guard {
            ~Guard() { CloseClipboard(); }
        } guard;
        if (op == "clipboard.read") {
            auto h = GetClipboardData(CF_UNICODETEXT);
            if (!h)
                return {{"text", nullptr}, {"format", "CF_UNICODETEXT"}};
            auto *s = static_cast<wchar_t *>(GlobalLock(h));
            if (!s)
                throw std::runtime_error("Clipboard lock failed");
            auto text = utf8(s);
            GlobalUnlock(h);
            return {{"text", text}, {"format", "CF_UNICODETEXT"}};
        }
        auto value = wide(a.at("text").get<std::string>());
        auto h = GlobalAlloc(GMEM_MOVEABLE, (value.size() + 1) * sizeof(wchar_t));
        if (!h)
            throw std::bad_alloc();
        auto *ptr = GlobalLock(h);
        if (!ptr) {
            GlobalFree(h);
            throw std::runtime_error("Clipboard allocation lock failed");
        }
        memcpy(ptr, value.c_str(), (value.size() + 1) * sizeof(wchar_t));
        GlobalUnlock(h);
        if (!EmptyClipboard() || !SetClipboardData(CF_UNICODETEXT, h)) {
            GlobalFree(h);
            throw std::runtime_error("Clipboard write failed");
        }
        return receipt("win32.clipboard");
    }
    if (op.starts_with("input.")) {
        InputLock input_lock;
        // Bind input to a live window. Do not steal focus when a modal/user intervenes.
        auto inputArgs = a;
        const auto space = a.value("coordinateSpace", std::string("screen_physical"));
        if (space != "screen_physical" && space != "window_relative" && space != "client_relative")
            throw std::invalid_argument("Unsupported native coordinateSpace");
        if (space != "screen_physical" && !a.contains("windowRef"))
            throw std::invalid_argument("Relative input requires windowRef");
        if (a.contains("windowRef")) {
            const auto target = p.window(a);
            if (!IsWindowVisible(target) || IsIconic(target) || !IsWindowEnabled(target))
                throw std::runtime_error("input_target_unavailable: hidden, minimized or blocked by modal");
            if (GetForegroundWindow() != target)
                throw std::runtime_error("input_target_not_foreground: inspect before continuing");
            RECT bounds{};
            if (!GetWindowRect(target, &bounds)) throw std::runtime_error("Cannot read target bounds");
            if (a.contains("expectedSize") &&
                (a.at("expectedSize").at("width") != bounds.right - bounds.left ||
                 a.at("expectedSize").at("height") != bounds.bottom - bounds.top))
                throw std::runtime_error("input_target_resized: reobserve layout");
            POINT origin{bounds.left, bounds.top};
            RECT area{0, 0, bounds.right - bounds.left, bounds.bottom - bounds.top};
            if (space == "client_relative") {
                origin = {0, 0};
                if (!GetClientRect(target, &area) || !ClientToScreen(target, &origin))
                    throw std::runtime_error("Cannot read client geometry");
            }
            auto translate = [&](const char *xKey, const char *yKey) {
                POINT point{a.at(xKey).get<LONG>(), a.at(yKey).get<LONG>()};
                if (space != "screen_physical") {
                    if (point.x < 0 || point.y < 0 || point.x >= area.right || point.y >= area.bottom)
                        throw std::invalid_argument("Point outside target bounds");
                    point.x += origin.x; point.y += origin.y;
                }
                if (GetAncestor(WindowFromPoint(point), GA_ROOT) != target)
                    throw std::runtime_error("input_point_occluded: reobserve target");
                inputArgs[xKey] = point.x; inputArgs[yKey] = point.y;
            };
            if (a.contains("x") || a.contains("y")) translate("x", "y");
            if (op == "input.drag") translate("toX", "toY");
        }
        std::vector<INPUT> events;
        if (op == "input.type_text") {
            auto text = wide(a.at("text").get<std::string>());
            for (auto ch : text) {
                events.push_back(key(0, KEYEVENTF_UNICODE, ch));
                events.push_back(key(0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, ch));
            }
            send(events);
        } else if (op == "input.key_chord") {
            std::vector<WORD> keys;
            for (auto &name : a.at("keys"))
                keys.push_back(vk(name.get<std::string>()));
            for (auto k : keys)
                events.push_back(key(k));
            for (auto it = keys.rbegin(); it != keys.rend(); ++it)
                events.push_back(key(*it, KEYEVENTF_KEYUP));
            try {
                send(events);
            } catch (...) {
                events.clear();
                for (auto it = keys.rbegin(); it != keys.rend(); ++it)
                    events.push_back(key(*it, KEYEVENTF_KEYUP));
                SendInput(UINT(events.size()), events.data(), sizeof(INPUT));
                throw;
            }
        } else {
            std::vector<WORD> modifiers;
            for (auto &modifier : a.value("modifiers", Json::array()))
                modifiers.push_back(vk(modifier.get<std::string>()));
            for (auto modifier : modifiers)
                events.push_back(key(modifier));
            auto mouse = [&](DWORD f, LONG x = 0, LONG y = 0, DWORD data = 0) {
                INPUT i{};
                i.type = INPUT_MOUSE;
                i.mi.dwFlags = f;
                i.mi.dx = x;
                i.mi.dy = y;
                i.mi.mouseData = data;
                events.push_back(i);
            };
            auto move = [&](int x, int y) {
                int left = GetSystemMetrics(SM_XVIRTUALSCREEN), top = GetSystemMetrics(SM_YVIRTUALSCREEN),
                    w = GetSystemMetrics(SM_CXVIRTUALSCREEN), h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
                if (x < left || y < top || x >= left + w || y >= top + h)
                    throw std::invalid_argument("Point outside virtual screen");
                mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                      LONG((int64_t(x - left) * 65535) / (w - 1)),
                      LONG((int64_t(y - top) * 65535) / (h - 1)));
            };
            if (op == "input.scroll")
                mouse(a.value("horizontal", false) ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, 0, 0,
                      DWORD(a.at("delta").get<int>()));
            else {
                move(inputArgs.at("x"), inputArgs.at("y"));
                if (op == "input.click" || op == "input.drag") {
                    auto button = a.value("button", std::string("left"));
                    if (button != "left" && button != "right" && button != "middle")
                        throw std::invalid_argument("Unknown mouse button");
                    DWORD down = button == "right"    ? MOUSEEVENTF_RIGHTDOWN
                                 : button == "middle" ? MOUSEEVENTF_MIDDLEDOWN
                                                      : MOUSEEVENTF_LEFTDOWN;
                    DWORD up = button == "right"    ? MOUSEEVENTF_RIGHTUP
                               : button == "middle" ? MOUSEEVENTF_MIDDLEUP
                                                    : MOUSEEVENTF_LEFTUP;
                    int count = bounded(a, "count", 1, 1, 2);
                    for (int n = 0; n < count; ++n) {
                        mouse(down);
                        if (op == "input.drag")
                            move(inputArgs.at("toX"), inputArgs.at("toY"));
                        mouse(up);
                    }
                } else if (op != "input.move")
                    throw std::invalid_argument("Unknown input operation");
            }
            for (auto it = modifiers.rbegin(); it != modifiers.rend(); ++it)
                events.push_back(key(*it, KEYEVENTF_KEYUP));
            try {
                send(events);
            } catch (...) {
                events.clear();
                for (auto it = modifiers.rbegin(); it != modifiers.rend(); ++it)
                    events.push_back(key(*it, KEYEVENTF_KEYUP));
                mouse(MOUSEEVENTF_LEFTUP | MOUSEEVENTF_RIGHTUP | MOUSEEVENTF_MIDDLEUP);
                SendInput(UINT(events.size()), events.data(), sizeof(INPUT));
                throw;
            }
        }
        return receipt("win32.SendInput");
    }
    throw std::invalid_argument("Unknown operation: " + op);
}
} // namespace dp
