// A dedicated native UI exercise, never a user's document. All pixels change through button input.
#include <Windows.h>
#include <array>
#include <string>
namespace {
std::array<COLORREF,64> cells;
COLORREF selected=RGB(224,64,64);
constexpr COLORREF colors[]={RGB(224,64,64),RGB(44,100,210),RGB(244,210,48)};
LRESULT CALLBACK proc(HWND window, UINT message, WPARAM w, LPARAM l) {
    switch(message) {
    case WM_CREATE:
        for(int i=0;i<3;++i)
            CreateWindowW(L"BUTTON",i==0?L"Red":i==1?L"Blue":L"Yellow",WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,
                12+i*92,12,88,30,window,reinterpret_cast<HMENU>(INT_PTR(200+i)),nullptr,nullptr);
        for(int y=0;y<8;++y) for(int x=0;x<8;++x) {
            auto name=L"Cell "+std::to_wstring(x)+L" "+std::to_wstring(y);
            CreateWindowW(L"BUTTON",name.c_str(),WS_CHILD|WS_VISIBLE|BS_OWNERDRAW,
                16+x*32,56+y*32,32,32,window,reinterpret_cast<HMENU>(INT_PTR(1000+y*8+x)),nullptr,nullptr);
        }
        CreateWindowW(L"EDIT",L"Initial title",WS_CHILD|WS_VISIBLE|WS_BORDER|ES_AUTOHSCROLL,
            12,326,178,26,window,reinterpret_cast<HMENU>(299),nullptr,nullptr);
        CreateWindowW(L"BUTTON",L"Apply",WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,
            200,326,80,26,window,reinterpret_cast<HMENU>(300),nullptr,nullptr);
        CreateWindowW(L"STATIC",L"Not applied",WS_CHILD|WS_VISIBLE,
            12,362,270,30,window,reinterpret_cast<HMENU>(301),nullptr,nullptr);
        return 0;
    case WM_COMMAND: {
        int id=LOWORD(w);
        if(id==300){wchar_t text[256]{};GetDlgItemTextW(window,299,text,256);auto label=L"Applied: "+std::wstring(text);SetDlgItemTextW(window,301,label.c_str());}
        if(id>=200 && id<203) selected=colors[id-200];
        if(id>=1000 && id<1064) {cells[id-1000]=selected;InvalidateRect(reinterpret_cast<HWND>(l),nullptr,FALSE);}
        return 0;
    }
    case WM_DRAWITEM: {
        auto d=reinterpret_cast<DRAWITEMSTRUCT*>(l);
        if(d->CtlID<1000 || d->CtlID>=1064) break;
        auto brush=CreateSolidBrush(cells[d->CtlID-1000]);FillRect(d->hDC,&d->rcItem,brush);DeleteObject(brush);
        FrameRect(d->hDC,&d->rcItem,static_cast<HBRUSH>(GetStockObject(LTGRAY_BRUSH)));return TRUE;
    }
    case WM_DESTROY:PostQuitMessage(0);return 0;
    }
    return DefWindowProcW(window,message,w,l);
}
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int) {
    SetProcessDPIAware();cells.fill(RGB(255,255,255));
    WNDCLASSW klass{};klass.lpfnWndProc=proc;klass.hInstance=instance;klass.lpszClassName=L"DesktopPilotOnboarding";
    klass.hCursor=LoadCursor(nullptr,IDC_ARROW);klass.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_BTNFACE+1);
    RegisterClassW(&klass);
    RECT bounds{0,0,296,404};AdjustWindowRect(&bounds,WS_OVERLAPPEDWINDOW,FALSE);
    auto window=CreateWindowW(klass.lpszClassName,L"DesktopPilot onboarding - disposable 8x8 canvas",WS_OVERLAPPEDWINDOW,
        CW_USEDEFAULT,CW_USEDEFAULT,bounds.right-bounds.left,bounds.bottom-bounds.top,nullptr,nullptr,instance,nullptr);
    if(!window) return 1;
    // Honor a hidden launcher first, then explicitly present this test's UI.
    ShowWindow(window,SW_SHOW);ShowWindow(window,SW_SHOW);UpdateWindow(window);
    MSG message{};while(GetMessageW(&message,nullptr,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}return 0;
}
