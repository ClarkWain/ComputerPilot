#include <Windows.h>
#include <objbase.h>
#include <oleauto.h>
#include <UIAutomation.h>
#include <atomic>
#include <desktop_pilot/service.hpp>
#include <future>
#include <iostream>
#include <thread>

namespace {
HWND edit = nullptr, status = nullptr;
std::atomic<int> invocations = 0;
std::atomic<int> pathDowns = 0, pathMoves = 0, pathUps = 0;
LRESULT CALLBACK window_proc(HWND h, UINT message, WPARAM w, LPARAM l) {
    if (message == WM_LBUTTONDOWN) ++pathDowns;
    if (message == WM_MOUSEMOVE && (w & MK_LBUTTON)) ++pathMoves;
    if (message == WM_LBUTTONUP) ++pathUps;
    if (message == WM_COMMAND && LOWORD(w) == 102) {
        ++invocations;
        SetWindowTextW(status, L"Created once");
        return 0;
    }
    if (message == WM_CLOSE) {
        DestroyWindow(h);
        return 0;
    }
    return DefWindowProcW(h, message, w, l);
}
void require(bool value, const char *message) {
    if (!value)
        throw std::runtime_error(message);
}
// A real out-of-process provider makes its Name property unresponsive. This tests UIA's
// provider transaction timeout rather than merely checking configuration values.
class SlowProvider final : public IRawElementProviderSimple {
    std::atomic<ULONG> refs_{1};
public:
    HWND window = nullptr;
    HANDLE entered = nullptr;
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IRawElementProviderSimple)) {
            *out = static_cast<IRawElementProviderSimple*>(this); AddRef(); return S_OK;
        }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs_; }
    ULONG STDMETHODCALLTYPE Release() override { const auto refs = --refs_; if (!refs) delete this; return refs; }
    HRESULT STDMETHODCALLTYPE get_ProviderOptions(ProviderOptions* value) override {
        *value = ProviderOptions_ServerSideProvider; return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPatternProvider(PATTERNID, IUnknown** value) override {
        *value = nullptr; return S_OK;
    }
    HRESULT STDMETHODCALLTYPE GetPropertyValue(PROPERTYID id, VARIANT* value) override {
        VariantInit(value);
        if (id == UIA_NamePropertyId) {
            if (entered) SetEvent(entered);
            Sleep(8000);
            value->vt = VT_BSTR; value->bstrVal = SysAllocString(L"Slow provider fixture");
        } else if (id == UIA_ControlTypePropertyId) { value->vt = VT_I4; value->lVal = UIA_WindowControlTypeId; }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE get_HostRawElementProvider(IRawElementProviderSimple** value) override {
        return UiaHostProviderFromHwnd(window, value);
    }
};
SlowProvider* slowProvider = nullptr;
LRESULT CALLBACK slow_window_proc(HWND window, UINT message, WPARAM w, LPARAM l) {
    if (message == WM_GETOBJECT && static_cast<LONG>(l) == UiaRootObjectId && slowProvider)
        return UiaReturnRawElementProvider(window, w, l, slowProvider);
    return DefWindowProcW(window, message, w, l);
}
int run_slow_provider(const wchar_t* eventName) {
    const auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(com)) return 2;
    auto entered = OpenEventW(EVENT_MODIFY_STATE, FALSE, eventName);
    if (!entered) return 2;
    auto ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, (std::wstring(eventName) + L"-ready").c_str());
    if (!ready) { CloseHandle(entered); return 2; }
    WNDCLASSW cls{};
    cls.lpfnWndProc = slow_window_proc; cls.hInstance = GetModuleHandleW(nullptr);
    cls.lpszClassName = L"ComputerPilotSlowProviderFixture";
    RegisterClassW(&cls);
    slowProvider = new SlowProvider;
    slowProvider->entered = entered;
    slowProvider->window = CreateWindowExW(WS_EX_TOOLWINDOW, cls.lpszClassName, L"ComputerPilot Slow Provider",
        WS_OVERLAPPEDWINDOW, 0, 0, 240, 120, nullptr, nullptr, cls.hInstance, nullptr);
    if (!slowProvider->window) return 2;
    SetEvent(ready);
    CloseHandle(ready);
    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    slowProvider->Release(); CloseHandle(entered); CoUninitialize(); return 0;
}
int verify_provider_timeout() {
    struct Child {
        PROCESS_INFORMATION process{};
        HANDLE entered = nullptr, ready = nullptr, stop = nullptr;
        std::thread watchdog;
        ~Child() {
            if (stop) SetEvent(stop);
            if (watchdog.joinable()) watchdog.join();
            if (process.hProcess) { TerminateProcess(process.hProcess, 0); WaitForSingleObject(process.hProcess, 2000); CloseHandle(process.hProcess); }
            if (process.hThread) CloseHandle(process.hThread);
            if (stop) CloseHandle(stop);
            if (entered) CloseHandle(entered);
            if (ready) CloseHandle(ready);
        }
    } child;
    try {
        wchar_t executable[32768]{};
        require(GetModuleFileNameW(nullptr, executable, 32768) != 0, "Cannot find fixture executable");
        auto eventName = L"Local\\ComputerPilotProviderTest-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64());
        child.entered = CreateEventW(nullptr, TRUE, FALSE, eventName.c_str());
        child.ready = CreateEventW(nullptr, TRUE, FALSE, (eventName + L"-ready").c_str());
        child.stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        require(child.entered && child.ready && child.stop, "Cannot create provider fixture events");
        std::wstring command = L"\"" + std::wstring(executable) + L"\" --slow-provider \"" + eventName + L"\"";
        STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
        require(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
            nullptr, nullptr, &startup, &child.process), "Cannot launch provider fixture");
        child.watchdog = std::thread([&] {
            if (WaitForSingleObject(child.stop, 10000) == WAIT_TIMEOUT) TerminateProcess(child.process.hProcess, 2);
        });
        // This is a console executable; WaitForInputIdle does not establish window readiness.
        const HANDLE startupEvents[] = {child.ready, child.process.hProcess};
        const auto readyResult = WaitForMultipleObjects(2, startupEvents, FALSE, 3000);
        require(readyResult != WAIT_OBJECT_0 + 1, "Slow provider fixture exited before creating its window");
        require(readyResult == WAIT_OBJECT_0, "Slow provider fixture did not signal window readiness");
        dp::Service service;
        auto windows = service.execute("window.list", {{"pid", child.process.dwProcessId}, {"includeHidden", true},
            {"titleContains", "ComputerPilot Slow Provider"}})["windows"];
        require(windows.size() == 1, "Slow provider fixture window not found");
        auto started = std::chrono::steady_clock::now();
        bool failed = false;
        dp::Json result;
        try {
            result = service.execute("ui.tree", {{"windowRef", windows[0]["windowRef"]}, {"format", "locator"},
                {"queryTimeoutMs", 5000}, {"metrics", true}});
            failed = !dp::ui_inspection_complete(result);
        } catch (const std::exception& error) { failed = true; result = {{"error", error.what()}}; }
        const auto elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
        require(WaitForSingleObject(child.entered, 0) == WAIT_OBJECT_0, "Slow UIA provider was not exercised");
        require(failed && elapsed < 6000, "Blocked provider was not rejected within the transaction timeout envelope");
        std::cout << "PASS: blocked provider rejected in " << elapsed << " ms: " << result.dump() << '\n';
        return 0;
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
void verify_path(dp::Service& d, const dp::Json& w, HWND window) {
    d.execute("window.activate", {{"windowRef",w}});
            const auto downBefore = pathDowns.load(), moveBefore = pathMoves.load(), upBefore = pathUps.load();
            d.execute("input.move", {{"windowRef",w},{"coordinateSpace","client_relative"},
                {"points",dp::Json::array({dp::Json::array({400,170}),dp::Json::array({420,180}),dp::Json::array({440,170})})},{"hold","left"}});
            for(int i=0;i<50 && pathUps.load()==upBefore;++i)std::this_thread::sleep_for(std::chrono::milliseconds(10));
            require(pathDowns==downBefore+1 && pathMoves>=moveBefore+2 && pathUps==upBefore+1,
                    "Continuous path lost held move events or did not release button");
            require(!(GetAsyncKeyState(VK_LBUTTON)&0x8000),"Continuous path left mouse pressed");
    POINT expected{440,170}, actual{};
    ClientToScreen(window,&expected); GetCursorPos(&actual);
    require(abs(actual.x-expected.x)<=2 && abs(actual.y-expected.y)<=2,"Path endpoint uses wrong coordinate space");
    const auto noPressBefore = pathDowns.load();
    d.execute("input.move", {{"windowRef",w},{"coordinateSpace","client_relative"},
        {"points",dp::Json::array({dp::Json::array({410,175}),dp::Json::array({430,180})})}});
    expected={430,180};ClientToScreen(window,&expected);
    // SendInput queues events; wait for the OS cursor to reach the final point.
    for(int i=0;i<50;++i) {
        GetCursorPos(&actual);
        if(abs(actual.x-expected.x)<=2 && abs(actual.y-expected.y)<=2)break;
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    require(abs(actual.x-expected.x)<=2 && abs(actual.y-expected.y)<=2,"Unheld path endpoint incorrect");
    require(pathDowns==noPressBefore && !(GetAsyncKeyState(VK_LBUTTON)&0x8000),"Unheld path pressed a button");
    bool rejected=false;
    try {
        d.execute("input.move", {{"windowRef",w},{"coordinateSpace","client_relative"},
            {"points",dp::Json::array({dp::Json::array({400,170}),dp::Json::array({9999,170})})},{"hold","left"}});
    } catch(const std::exception& e) { rejected=std::string(e.what()).find("outside target bounds")!=std::string::npos; }
    require(rejected && pathDowns==noPressBefore && !(GetAsyncKeyState(VK_LBUTTON)&0x8000),"Invalid path dispatched input before full validation");
}
} // namespace
int wmain(int argc, wchar_t **argv) {
    if (argc == 3 && std::wstring(argv[1]) == L"--slow-provider") return run_slow_provider(argv[2]);
    if (argc == 2 && std::wstring(argv[1]) == L"--provider-timeout") return verify_provider_timeout();
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    WNDCLASSW c{};
    c.lpfnWndProc = window_proc;
    c.hInstance = GetModuleHandleW(nullptr);
    c.lpszClassName = L"ComputerPilotVerificationFixture";
    c.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
    RegisterClassW(&c);
    HWND window =
        CreateWindowExW(WS_EX_TOOLWINDOW, c.lpszClassName, L"ComputerPilot Native Verification",
                        WS_OVERLAPPEDWINDOW, 80, 80, 520, 260, nullptr, nullptr, c.hInstance, nullptr);
    if (!window)
        return 2;
    edit = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"Initial", WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_AUTOVSCROLL, 20,
                           20, 350, 32, window, reinterpret_cast<HMENU>(101), c.hInstance, nullptr);
    CreateWindowExW(0, L"BUTTON", L"Create", WS_CHILD | WS_VISIBLE | BS_PUSHBUTTON, 20, 70, 120, 35, window,
                    reinterpret_cast<HMENU>(102), c.hInstance, nullptr);
    status = CreateWindowExW(0, L"STATIC", L"Not created", WS_CHILD | WS_VISIBLE, 20, 120, 350, 32, window,
                             reinterpret_cast<HMENU>(103), c.hInstance, nullptr);
    ShowWindow(window, SW_SHOWNOACTIVATE);
    UpdateWindow(window);
    HWND interruption=CreateWindowExW(WS_EX_TOOLWINDOW,c.lpszClassName,L"ComputerPilot Interruption Fixture",WS_OVERLAPPEDWINDOW,650,80,400,260,nullptr,nullptr,c.hInstance,nullptr);
    std::atomic<bool> done = false;
    int exit_code = 0;
    std::thread test([&] {
        try {
            require(dp::operation_failed({{"status", "ok"}, {"verification", "failed"}}), "Verification failure ignored");
            require(!dp::operation_failed({{"status", "ok"}, {"verification", "passed"}}), "Verified action rejected");
            require(dp::operation_failed({{"status", "timeout"}}), "Timeout ignored");
            dp::Service d;
            auto windows =
                d.execute("window.list", {{"pid", GetCurrentProcessId()},
                                          {"titleContains", "ComputerPilot Native Verification"}})["windows"];
            require(windows.size() == 1, "fixture window not unique");
            auto w = windows[0]["windowRef"];
            auto before = windows[0]["bounds"];
            if(argc==2 && std::wstring(argv[1])==L"--routing-only") {
                auto button=d.execute("ui.find",{{"windowRef",w},{"selector",{{"role","Button"},{"name","Create"}}}})["uniqueRef"];
                require(!button.is_null(),"fixture button missing");
                ShowWindow(interruption,SW_SHOW);
                auto others=d.execute("window.list",{{"pid",GetCurrentProcessId()},{"titleContains","Interruption Fixture"}})["windows"];
                auto popup=others[0]["windowRef"];d.execute("window.activate",{{"windowRef",popup}});
                POINT cursorBefore{},cursorAfter{};GetCursorPos(&cursorBefore);
                auto direct=d.execute("ui.click",{{"windowRef",w},{"elementRef",button}});
                for(int i=0;i<50&&!invocations.load();++i)Sleep(10);
                GetCursorPos(&cursorAfter);
                require(invocations==1&&direct["methodUsed"]=="uia.Invoke","direct control invocation failed");
                require(cursorBefore.x==cursorAfter.x&&cursorBefore.y==cursorAfter.y,"UIA click moved global cursor");
                d.execute("window.activate",{{"windowRef",popup}});
                auto prior=pathUps.load();
                d.execute("input.click",{{"windowRef",w},{"coordinateSpace","client_relative"},{"x",400},{"y",170},{"autoActivate",true}});
                for(int i=0;i<50&&pathUps.load()==prior;++i)Sleep(10);
                require(GetForegroundWindow()==window&&pathUps==prior+1,"focus theft was not recovered before input");
                EnableWindow(window,FALSE);bool blocked=false;
                try{d.execute("input.click",{{"windowRef",w},{"coordinateSpace","client_relative"},{"x",400},{"y",170},{"autoActivate",true}});}catch(...){blocked=true;}
                EnableWindow(window,TRUE);require(blocked,"disabled modal target accepted input");
                std::cout<<"PASS: direct UIA invocation without cursor move; focus recovery; modal blocked\n";
                done=true;PostMessageW(window,WM_NULL,0,0);return;
            }
            if(argc==2 && std::wstring(argv[1])==L"--path-only") {
                verify_path(d,w,window);
                std::cout << "PASS: held path, unheld path, relative endpoints, release, invalid later point before input\n";
                done=true;PostMessageW(window,WM_NULL,0,0);return;
            }
            std::exception_ptr fallbackFailure;
            std::thread fallback([&] {
                const auto com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
                try {
                    require(SUCCEEDED(com), "Cannot initialize fallback fixture STA");
                    dp::Service isolated;
                    auto targets = isolated.execute("window.list", {{"pid", GetCurrentProcessId()},
                        {"titleContains", "ComputerPilot Native Verification"}})["windows"];
                    require(targets.size() == 1, "Fallback fixture target missing");
                    const auto target = targets[0]["windowRef"];
                    bool unavailable = false;
                    try { isolated.execute("ui.tree", {{"windowRef", target}}); }
                    catch (const std::exception& error) { unavailable = std::string(error.what()).find("ui_automation_unavailable") != std::string::npos; }
                    require(unavailable, "COM apartment mismatch did not reject UI Automation");
                    std::filesystem::create_directories("fixtures");
                    auto image = isolated.execute("capture.window", {{"windowRef", target}, {"method", "screen"},
                        {"output", "fixtures/uia-unavailable.png"}});
                    require(image.contains("width") && image["width"].get<int>() > 0,
                        "UI Automation initialization failure blocked screenshot fallback");
                } catch (...) { fallbackFailure = std::current_exception(); }
                if (SUCCEEDED(com)) CoUninitialize();
            });
            fallback.join();
            if (fallbackFailure) std::rethrow_exception(fallbackFailure);
            auto found = d.execute("ui.find", {{"windowRef", w}, {"selector", {{"role", "Edit"}}}, {"metrics", true}});
            require(!found["uniqueRef"].is_null(), "Edit not unique");
            require(found["metrics"]["runtimeIdLookups"] == found["visited"],
                    "Full query reread locator identity while adding optional details");
            require(found["metrics"]["connectionTimeoutMs"] == 2000 && found["metrics"]["transactionTimeoutMs"] == 2000,
                    "UI Automation provider timeouts were not configured and verified");
            auto e = found["uniqueRef"];
            auto compact = d.execute("ui.find", {{"windowRef", w}, {"selector", {{"role", "Edit"}}},
                {"format", "compact"}, {"metrics", true}});
            require(compact["uniqueRef"] == e && compact["elements"][0]["name"] == found["elements"][0]["name"],
                    "Compact query changed identity or name");
            require(dp::dump_json(compact["elements"]).size() < dp::dump_json(found["elements"]).size(),
                    "Compact result did not reduce bytes");
            require(compact["metrics"]["payloadBytes"].get<size_t>() > 0, "Missing query metrics");
            require(compact["metrics"]["identityComparisons"].get<size_t>() <= compact["visited"].get<size_t>(),
                    "Identity lookup performed more than one comparison per visited node");
            require(compact["evidenceComplete"] == true, "Complete selector evidence incorrectly rejected");
            auto repeated = d.execute("ui.find", {{"windowRef", w}, {"selector", {{"role", "Edit"}}},
                {"format", "locator"}, {"metrics", true}});
            require(repeated["uniqueRef"] == e &&
                    repeated["metrics"]["identityComparisons"].get<size_t>() <= repeated["visited"].get<size_t>(),
                    "Repeated observation changed identity or scanned the reference table");
            auto paged = d.execute("ui.tree", {{"windowRef", w}, {"limit", 1}, {"format", "locator"}});
            require(paged["has_more"] == true && paged["evidenceComplete"] == false && paged["uniqueRef"].is_null(),
                    "Paged evidence claimed completeness or uniqueness");
            auto shallow = d.execute("ui.tree", {{"windowRef", w}, {"depth", 0}, {"format", "locator"}});
            require(shallow["truncated"] == true && shallow["stopReason"] == "depthLimit" &&
                    shallow["evidenceComplete"] == false && shallow["uniqueRef"].is_null(),
                    "Depth boundary hid unvisited children");
            auto partial = d.execute("ui.find", {{"windowRef", w}, {"limit", 1}, {"stopAfterLimit", true}});
            require(partial["truncated"] == true && partial["uniqueRef"].is_null() && partial["visited"] == 1,
                    "Early stop must not claim uniqueness");
            auto budget = d.execute("ui.tree", {{"windowRef", w}, {"nodeBudget", 1}});
            require(budget["visited"] == 1 && budget["truncated"] == true, "Node budget accounting wrong");
            dp::write_json("fixtures/query-efficiency.json", {{"fullBytes", dp::dump_json(found["elements"]).size()},
                {"compactBytes", dp::dump_json(compact["elements"]).size()}, {"compact", compact}, {"early", partial}});
            auto value = d.execute("ui.set_value", {{"elementRef", e}, {"value", "车窗 / native C++"}});
            require(value["verification"] == "passed", "Unicode set/read verification failed");
            std::string longText;
            for (int i = 0; i < 2000; ++i) longText += "长文本ABC";
            auto filled = d.execute("ui.fill", {{"elementRef", e}, {"text", longText}, {"method", "value"}});
            dp::write_json("fixtures/fill-verification.json", filled);
            if (filled["verification"] != "passed") std::cerr << "Native text units=" << GetWindowTextLengthW(edit) << ", " << dp::dump_json(filled) << '\n';
            require(filled["verification"] == "passed" && filled["actualBytes"] == longText.size(), "Long fill lost content");
            require(dp::dump_json(filled).size() < 500, "Fill echoes long text");
            auto unchanged = d.execute("ui.fill", {{"elementRef", e}, {"text", longText}});
            require(unchanged["methodUsed"] == "unchanged", "Matching fill dispatched again");
            auto multiline = d.execute("ui.fill", {{"elementRef", e}, {"text", "首行\n\n末行"}, {"method", "value"}});
            require(multiline["verification"] == "passed" && multiline["actualLines"] == 3, "Multiline fill lost blank line");
            auto keyboard = d.execute("ui.fill", {{"elementRef", e}, {"text", "键盘\n\n换行"}, {"method", "keyboard"}, {"timeoutMs", 3000}});
            dp::write_json("fixtures/keyboard-fill.json", keyboard);
            if (keyboard["verification"] != "passed") {
                wchar_t actual[256]{}; GetWindowTextW(edit, actual, 256);
                std::cerr << "Keyboard actual=" << dp::utf8(actual) << ", " << dp::dump_json(keyboard) << '\n';
            }
            require(keyboard["verification"] == "passed" && keyboard["actualLines"] == 3, "Keyboard fill lost newlines");
            d.execute("ui.fill", {{"elementRef", e}, {"text", "车窗 / native C++"}});
            dp::write_json("fixtures/fill-verification.json", filled);
            auto button = d.execute(
                "ui.find", {{"windowRef", w}, {"selector", {{"role", "Button"}, {"name", "Create"}}}});
            require(!button["uniqueRef"].is_null(), "Button not unique");
            auto invokeArgs =
                dp::Json{{"elementRef", button["uniqueRef"]}, {"requestId", "fixture-create-once"}};
            d.execute("ui.invoke", invokeArgs);
            bool invoked = false;
            for (int i = 0; i < 20 && !invoked; ++i) {
                auto state =
                    d.execute("ui.find", {{"windowRef", w}, {"selector", {{"name", "Created once"}}}});
                invoked = !state["elements"].empty();
                if (!invoked)
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
            }
            require(invoked, "Invoke not reflected in fixture");
            require(d.execute("ui.invoke", invokeArgs)["replayed"] == true,
                    "Repeated request not served from receipt");
            require(invocations == 1, "Duplicate Invoke dispatched");
            auto after = d.execute("window.get", {{"windowRef", w}});
            require(before == after["bounds"], "UIA actions changed window geometry");
            auto capture = d.execute(
                "capture.window",
                {{"windowRef", w}, {"output", "fixtures/native-window.png"}, {"method", "printWindow"}});
            auto image = dp::load_image(std::filesystem::path("fixtures/native-window.png"));
            require(image.width == capture["width"] && image.height == capture["height"],
                    "Capture size mismatch");
            if (argc == 3) {
                auto hybrid = d.execute("inspect.hybrid", {{"windowRef", w},
                                                           {"output", "fixtures/native-hybrid.png"},
                                                           {"method", "printWindow"},
                                                           {"model", dp::utf8(argv[1])},
                                                           {"ocrModels", dp::utf8(argv[2])}});
                dp::write_json("fixtures/native-hybrid.json", hybrid);
                require(hybrid["components"]["detector"] == "completed" &&
                            hybrid["components"]["ocr"] == "completed",
                        "Hybrid component failure");
                bool associated = false;
                for (auto &region : hybrid["elements"])
                    if (!region["nativeRef"].is_null())
                        associated = true;
                require(associated, "No visual region associated with native UIA");
                require(d.execute("window.get", {{"windowRef", w}})["bounds"] == before,
                        "Hybrid inspection changed geometry");
            }
            bool invalid = false;
            try {
                d.execute("ui.get", {{"elementRef", "unknown"}});
            } catch (...) {
                invalid = true;
            }
            require(invalid, "Unknown element reference accepted");
            d.execute("window.move", {{"windowRef", w}, {"x", 90}, {"y", 80}});
            bool stale = false;
            try {
                d.execute("input.click", {{"imageRef", capture["imageRef"]},
                                          {"coordinateSpace", "image_pixels"},
                                          {"x", 1},
                                          {"y", 1}});
            } catch (const std::exception &error) {
                stale = std::string(error.what()).find("stale_image_geometry") != std::string::npos;
            }
            require(stale, "Moved-window image was not rejected before input dispatch");
            d.execute("window.activate", {{"windowRef", w}});
            auto relative = dp::Json{{"windowRef", w}, {"coordinateSpace", "client_relative"},
                {"x", 40}, {"y", 150}, {"expectedSize", {{"width", before["width"]}, {"height", before["height"]}}}};
            for (int left : {90, 120}) {
                d.execute("window.move", {{"windowRef", w}, {"x", left}, {"y", 80}});
                d.execute("input.move", relative);
                POINT expected{40, 150}, actual{};
                ClientToScreen(window, &expected);
                GetCursorPos(&actual);
                require(abs(actual.x - expected.x) <= 2 && abs(actual.y - expected.y) <= 2,
                        "Relative input did not follow moved window");
            }
            verify_path(d, w, window);
            auto rejected = [&](const dp::Json &args, const std::string &reason) {
                try { d.execute("input.move", args); } catch (const std::exception &e) {
                    return std::string(e.what()).find(reason) != std::string::npos;
                }
                return false;
            };
            auto wrongSize = relative;
            wrongSize["expectedSize"]["width"] = 1;
            require(rejected(wrongSize, "input_target_resized"), "Resize mismatch accepted");
            auto outside = relative;
            outside["x"] = -1;
            require(rejected(outside, "outside target bounds"), "Out-of-bounds relative input accepted");
            require(rejected({{"windowRef",w},{"coordinateSpace","client_relative"},
                {"points",dp::Json::array({dp::Json::array({400,170}),dp::Json::array({9999,170})})},{"hold","left"}},
                "outside target bounds"),"Invalid later path point accepted");
            require(!(GetAsyncKeyState(VK_LBUTTON)&0x8000),"Invalid path pressed button before validation");
            EnableWindow(window, FALSE);
            require(rejected(relative, "input_target_unavailable"), "Modal-disabled target accepted input");
            EnableWindow(window, TRUE);
            d.execute("window.move", {{"windowRef", w}, {"x", 80}, {"y", 80}});
            dp::write_json("fixtures/native-verification.json", {{"status", "passed"},
                                                                 {"unicodeValue", value["target"]["value"]},
                                                                 {"invoke", invoked},
                                                                 {"geometryPreserved", true},
                                                                 {"capture", capture}});
            std::cout << "native UIA set/read/invoke, geometry, capture, invalid reference: PASS\n";
        } catch (const std::exception &e) {
            std::cerr << e.what() << '\n';
            exit_code = 1;
        }
        done = true;
        PostMessageW(window, WM_NULL, 0, 0);
    });
    MSG message{};
    while (!done) {
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        MsgWaitForMultipleObjects(0, nullptr, FALSE, 20, QS_ALLINPUT);
    }
    test.join();
    DestroyWindow(interruption);
    DestroyWindow(window);
    return exit_code;
}
