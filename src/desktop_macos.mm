#include <desktop_pilot/desktop.hpp>
#include <desktop_pilot/preflight.hpp>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <Carbon/Carbon.h>
#include <unistd.h>
#include <algorithm>
#include <chrono>
#include <deque>
#include <map>
#include <set>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <cmath>

namespace dp {
namespace {
template<class T> struct Ref {
    T value=nullptr;
    explicit Ref(T v=nullptr):value(v){}
    ~Ref(){if(value)CFRelease(value);}
    Ref(const Ref&)=delete;Ref& operator=(const Ref&)=delete;
    Ref(Ref&& other) noexcept:value(other.value){other.value=nullptr;}
    operator T()const{return value;}
};
using AX=std::shared_ptr<std::remove_pointer_t<AXUIElementRef>>;
AX adopt(AXUIElementRef e){return AX(e,[](auto* p){if(p)CFRelease(p);});}
AX retain(AXUIElementRef e){if(e)CFRetain(e);return adopt(e);}
Ref<CFTypeRef> attribute(AXUIElementRef e,CFStringRef key) {
    CFTypeRef value=nullptr;auto error=AXUIElementCopyAttributeValue(e,key,&value);
    if(error==kAXErrorInvalidUIElement)throw std::runtime_error("stale_element: inspect again");
    if(error==kAXErrorAPIDisabled)throw std::runtime_error("accessibility_permission_required");
    if(error==kAXErrorCannotComplete)throw std::runtime_error("accessibility_provider_unavailable");
    return Ref<CFTypeRef>(value);
}
std::string str(NSString* s){return s?std::string(s.UTF8String?:""):std::string{};}
NSString* ns(const std::string& s){auto result=[[NSString alloc] initWithBytes:s.data() length:s.size() encoding:NSUTF8StringEncoding];if(!result)throw std::invalid_argument("Invalid UTF-8 text");return result;}
std::string text(AXUIElementRef e,CFStringRef key) {
    auto value=attribute(e,key);return value.value&&CFGetTypeID(value)==CFStringGetTypeID()?str((__bridge NSString*)value.value):std::string{};
}
bool boolean(AXUIElementRef e,CFStringRef key,bool fallback=false) {
    auto v=attribute(e,key);return v.value&&CFGetTypeID(v)==CFBooleanGetTypeID()?CFBooleanGetValue((CFBooleanRef)v.value):fallback;
}
CGRect bounds(AXUIElementRef e) {
    CGPoint p{};CGSize s{};auto pos=attribute(e,kAXPositionAttribute),size=attribute(e,kAXSizeAttribute);
    if(pos.value&&CFGetTypeID(pos)==AXValueGetTypeID())AXValueGetValue((AXValueRef)pos.value,kAXValueTypeCGPoint,&p);
    if(size.value&&CFGetTypeID(size)==AXValueGetTypeID())AXValueGetValue((AXValueRef)size.value,kAXValueTypeCGSize,&s);
    return {p,s};
}
Json rect(CGRect r){return {{"x",int(std::lround(r.origin.x))},{"y",int(std::lround(r.origin.y))},{"width",int(std::lround(r.size.width))},{"height",int(std::lround(r.size.height))}};}
CGRect cgrect(const Json& r){return CGRectMake(r.at("x").get<double>(),r.at("y").get<double>(),r.at("width").get<double>(),r.at("height").get<double>());}
int integer(const Json& a,const char* key,int fallback,int lo,int hi) {
    if(!a.contains(key))return fallback;
    if(!a[key].is_number_integer()||a[key].get<int64_t>()<lo||a[key].get<int64_t>()>hi)throw std::invalid_argument(std::string(key)+" outside supported range");return a[key].get<int>();
}
void check(AXError e,const char* action){if(e!=kAXErrorSuccess)throw std::runtime_error(std::string(action)+" failed: AX error "+std::to_string(e));}
Json receipt(const char* method){return {{"status","ok"},{"dispatch","dispatched"},{"verification","not_requested"},{"method",method}};}
Json session() {
    Ref<CFDictionaryRef> info(CGSessionCopyCurrentDictionary());NSDictionary* s=(__bridge NSDictionary*)info.value;
    const bool present=s!=nil,onConsole=[s[(__bridge NSString*)kCGSessionOnConsoleKey] boolValue];
    return {{"platform","macos"},{"consoleSession",present&&onConsole},
        {"sameUserSession",present&&[s[(__bridge NSString*)kCGSessionUserIDKey] unsignedIntValue]==getuid()},
        {"lockState",!present?"unknown":([s[@"CGSSessionScreenIsLocked"] boolValue]||!onConsole?"locked":"unlocked")},
        {"accessibilityTrusted",bool(AXIsProcessTrusted())},{"screenCaptureAllowed",bool(CGPreflightScreenCaptureAccess())},
        {"postEventAllowed",bool(CGPreflightPostEventAccess())},{"secureInput",bool(IsSecureEventInputEnabled())},
        {"coordinateUnits","screen_points"}};
}
void post(CGEventRef e){if(!e)throw std::runtime_error("Cannot create input event");CGEventPost(kCGHIDEventTap,e);CFRelease(e);}
void mouse(CGEventType type,CGPoint p,CGMouseButton button,int count=1) {
    auto e=CGEventCreateMouseEvent(nullptr,type,p,button);if(e)CGEventSetIntegerValueField(e,kCGMouseEventClickState,count);post(e);
}
Image from_cg(CGImageRef cg) {
    size_t w=CGImageGetWidth(cg),h=CGImageGetHeight(cg);
    if(!w||!h||w>64000000/h)throw std::runtime_error("Capture exceeds 64 million pixels or is empty");
    std::vector<uint8_t> rgba(w*h*4);Ref<CGColorSpaceRef> space(CGColorSpaceCreateWithName(kCGColorSpaceSRGB));
    Ref<CGContextRef> context(CGBitmapContextCreate(rgba.data(),w,h,8,w*4,space,CGBitmapInfo(kCGImageAlphaPremultipliedLast)|kCGBitmapByteOrder32Big));
    if(!context.value)throw std::runtime_error("Cannot create capture bitmap");CGContextDrawImage(context,CGRectMake(0,0,w,h),cg);
    Image image{int(w),int(h),std::vector<uint8_t>(w*h*3)};for(size_t i=0;i<w*h;++i)for(int j=0;j<3;++j)image.rgb[i*3+j]=rgba[i*4+j];return image;
}
std::map<std::string,CGKeyCode> keymap() {
    return {{"A",kVK_ANSI_A},{"B",kVK_ANSI_B},{"C",kVK_ANSI_C},{"D",kVK_ANSI_D},{"E",kVK_ANSI_E},{"F",kVK_ANSI_F},
        {"G",kVK_ANSI_G},{"H",kVK_ANSI_H},{"I",kVK_ANSI_I},{"J",kVK_ANSI_J},{"K",kVK_ANSI_K},{"L",kVK_ANSI_L},
        {"M",kVK_ANSI_M},{"N",kVK_ANSI_N},{"O",kVK_ANSI_O},{"P",kVK_ANSI_P},{"Q",kVK_ANSI_Q},{"R",kVK_ANSI_R},
        {"S",kVK_ANSI_S},{"T",kVK_ANSI_T},{"U",kVK_ANSI_U},{"V",kVK_ANSI_V},{"W",kVK_ANSI_W},{"X",kVK_ANSI_X},{"Y",kVK_ANSI_Y},{"Z",kVK_ANSI_Z},
        {"0",kVK_ANSI_0},{"1",kVK_ANSI_1},{"2",kVK_ANSI_2},{"3",kVK_ANSI_3},{"4",kVK_ANSI_4},{"5",kVK_ANSI_5},{"6",kVK_ANSI_6},{"7",kVK_ANSI_7},{"8",kVK_ANSI_8},{"9",kVK_ANSI_9},
        {"WIN",kVK_Command},{"CMD",kVK_Command},{"CTRL",kVK_Control},{"ALT",kVK_Option},{"SHIFT",kVK_Shift},
        {"ENTER",kVK_Return},{"TAB",kVK_Tab},{"ESC",kVK_Escape},{"SPACE",kVK_Space},{"BACKSPACE",kVK_Delete},{"DELETE",kVK_ForwardDelete},
        {"HOME",kVK_Home},{"END",kVK_End},{"LEFT",kVK_LeftArrow},{"RIGHT",kVK_RightArrow},{"UP",kVK_UpArrow},{"DOWN",kVK_DownArrow},
        {"PAGEUP",kVK_PageUp},{"PAGEDOWN",kVK_PageDown},{"INSERT",kVK_Help},
        {"F1",kVK_F1},{"F2",kVK_F2},{"F3",kVK_F3},{"F4",kVK_F4},{"F5",kVK_F5},{"F6",kVK_F6},{"F7",kVK_F7},{"F8",kVK_F8},{"F9",kVK_F9},{"F10",kVK_F10},{"F11",kVK_F11},{"F12",kVK_F12}};
}
}
struct Desktop::Impl {
    struct Window{CGWindowID id;pid_t pid;AX sheet;Json metadata;};
    struct Element{AX ax;std::string window;};
    std::map<std::string,Window> windows;
    std::map<std::string,Element> elements;
    unsigned serial=0;
    std::string prefix=std::to_string(getpid())+"-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+"-";
    std::mutex sessionMutex,watchMutex;
    std::condition_variable watchChanged;
    DesktopSessionTracker sessionTracker;
    bool stopping=false;
    std::thread sessionWatcher;
    Impl() {
        environment();
        sessionWatcher=std::thread([this] {
            @autoreleasepool {
                std::unique_lock lock(watchMutex);
                while(!watchChanged.wait_for(lock,std::chrono::milliseconds(100),[this]{return stopping;})) {
                    lock.unlock();
                    @autoreleasepool { try {environment();} catch(...) {
                        std::lock_guard guard(sessionMutex);
                        sessionTracker.observe({{"platform","macos"},{"lockState","unknown"}});
                    }}
                    lock.lock();
                }
            }
        });
    }
    ~Impl() {
        {std::lock_guard lock(watchMutex);stopping=true;}
        watchChanged.notify_all();if(sessionWatcher.joinable())sessionWatcher.join();
    }
    Json environment() {
        // Sampling and publication share a lock so an older sample cannot overwrite
        // a newer transition observed by the foreground executor.
        std::lock_guard lock(sessionMutex);return sessionTracker.observe(session());
    }
    Json context() {
        auto current=environment();auto preflight=desktop_preflight(current);
        return {{"generation",current.at("desktopGeneration")},{"ready",preflight.at("ready")},
            {"lockState",current.at("lockState")},{"preflight",preflight}};
    }
    Json access(const std::string& op,const Json& args,bool started=false) {
        auto current=context();auto result=desktop_operation_access(op,current.at("preflight"));
        if(result.empty()&&args.contains("expectedDesktopGeneration")&&
           args.at("expectedDesktopGeneration")!=current.at("generation"))
            result={{"status","error"},{"code","observation_required"},{"dispatch","not_started"},
                {"paused",true},{"resumeRequiresObservation",true},
                {"message","Desktop session changed since observation, even if window geometry is unchanged."},
                {"next","Call get_window_state after unlocking; inspect prior effects and submit only unfinished actions. No automatic replay."}};
        if(!result.empty()) {
            result["desktopContext"]=current;
            if(started){result["dispatch"]="dispatched";result["verification"]="unknown";}
        }
        return result;
    }
    std::string window_ref(CGWindowID id,pid_t pid,AX sheet={}) {
        for(auto& [ref,w]:windows)if(w.id==id&&w.pid==pid&&((!sheet&&!w.sheet)||(sheet&&w.sheet&&CFEqual(sheet.get(),w.sheet.get()))))return ref;
        auto ref="w-"+prefix+std::to_string(++serial);windows.emplace(ref,Window{id,pid,sheet,Json()});return ref;
    }
    NSDictionary* info(const Window& w) {
        if(w.sheet)return nil;
        NSArray* rows=CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionIncludingWindow,w.id));
        for(NSDictionary* row in rows)if([row[(__bridge NSString*)kCGWindowNumber] unsignedIntValue]==w.id&&[row[(__bridge NSString*)kCGWindowOwnerPID] intValue]==w.pid)return row;
        throw std::runtime_error("stale_window: list_windows again");
    }
    Window& window(const Json& a) {
        auto it=windows.find(a.at("windowRef").get<std::string>());if(it==windows.end())throw std::invalid_argument("Unknown windowRef; list_windows first");
        if(it->second.sheet){if(![NSRunningApplication runningApplicationWithProcessIdentifier:it->second.pid])throw std::runtime_error("stale_window");if(context().value("ready",false))bounds(it->second.sheet.get());}
        else info(it->second);return it->second;
    }
    AX app(pid_t pid) {auto a=adopt(AXUIElementCreateApplication(pid));AXUIElementSetMessagingTimeout(a.get(),0.25);return a;}
    AX axwindow(Window& w) {
        if(!AXIsProcessTrusted())throw std::runtime_error("accessibility_permission_required");
        if(w.sheet)return w.sheet;
        NSDictionary* row=info(w);CGRect target{};CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString*)kCGWindowBounds],&target);
        auto application=app(w.pid);auto values=attribute(application.get(),kAXWindowsAttribute);std::vector<AX> matches;
        if(values.value&&CFGetTypeID(values)==CFArrayGetTypeID())for(id value in (__bridge NSArray*)values.value) {
            auto e=(__bridge AXUIElementRef)value;auto b=bounds(e);
            if(std::abs(b.origin.x-target.origin.x)<=1&&std::abs(b.origin.y-target.origin.y)<=1&&std::abs(b.size.width-target.size.width)<=1&&std::abs(b.size.height-target.size.height)<=1)matches.push_back(retain(e));
        }
        // Preview can expose several overlapping document windows with the
        // same geometry. Use the compositor title as additional identity
        // evidence; never select an arbitrary AX window at that position.
        const auto title=str(row[(__bridge NSString*)kCGWindowName]);
        if(!title.empty()) {
            std::vector<AX> titled;
            for(const auto& candidate:matches)if(text(candidate.get(),kAXTitleAttribute)==title)titled.push_back(candidate);
            matches=std::move(titled);
        }
        if(matches.size()==1)return matches[0];
        throw std::runtime_error(matches.empty()?"AX window unavailable; use image mode":"AX window identity ambiguous; inspect window list");
    }
    bool focused(Window& w) {
        if(NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier!=w.pid)return false;
        if(!AXIsProcessTrusted())return false;
        auto application=app(w.pid);auto current=attribute(application.get(),kAXFocusedWindowAttribute);
        if(!current.value||CFGetTypeID(current)!=AXUIElementGetTypeID())return false;
        // Identical rectangles do not prove where keyboard input will go.
        if(!w.sheet)return CFEqual(current.value,axwindow(w).get());
        if(w.sheet) {
            if(CFEqual(current.value,w.sheet.get()))return true;
            auto parent=attribute(w.sheet.get(),kAXParentAttribute);
            if(parent.value&&CFEqual(parent.value,current.value)&&text(w.sheet.get(),kAXRoleAttribute)=="AXSheet")return true;
            auto focusedElement=attribute(application.get(),kAXFocusedUIElementAttribute);
            if(focusedElement.value&&CFGetTypeID(focusedElement)==AXUIElementGetTypeID()) {
                auto owner=attribute((AXUIElementRef)focusedElement.value,kAXWindowAttribute);
                if(owner.value&&CFEqual(owner.value,w.sheet.get()))return true;
            }
        }
        auto b=bounds((AXUIElementRef)current.value);auto row=info(w);CGRect target{};
        if(w.sheet)target=bounds(w.sheet.get());else CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString*)kCGWindowBounds],&target);
        return CGRectEqualToRect(CGRectIntegral(b),CGRectIntegral(target));
    }
    Json describe(const std::string& ref,Window& w,bool blocker=true) {
        auto desktop=context();
        if(w.sheet&&!desktop.value("ready",false)) {
            auto result=w.metadata.is_object()?w.metadata:Json{{"windowRef",ref},{"pid",w.pid},{"title",""},{"bounds",rect(CGRectZero)}};
            result["desktopContext"]=desktop;result["metadataOnly"]=true;result["foreground"]=false;return result;
        }
        NSDictionary* row=info(w);CGRect b{};if(w.sheet)b=bounds(w.sheet.get());else CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString*)kCGWindowBounds],&b);
        NSRunningApplication* running=[NSRunningApplication runningApplicationWithProcessIdentifier:w.pid];
        Json result={{"windowRef",ref},{"title",w.sheet?text(w.sheet.get(),kAXTitleAttribute):str(row[(__bridge NSString*)kCGWindowName])},
            {"pid",w.pid},{"bounds",rect(b)},{"visible",w.sheet?true:[row[(__bridge NSString*)kCGWindowIsOnscreen] boolValue]},
            {"enabled",true},{"minimized",false},{"foreground",false},{"dpi",72},{"coordinateUnits","screen_points"},
            {"className",w.sheet?"AXSheet":"AXWindow"},{"executable",str(running.executableURL.lastPathComponent)},
            {"bundleIdentifier",str(running.bundleIdentifier)}};
        result["desktopContext"]=desktop;
        if(!desktop.value("ready",false)){result["metadataOnly"]=true;return result;}
        if(AXIsProcessTrusted())try {
            auto ax=axwindow(w);result["minimized"]=boolean(ax.get(),kAXMinimizedAttribute);result["foreground"]=focused(w);
            auto document=attribute(ax.get(),kAXDocumentAttribute);
            NSURL* documentURL=nil;
            if(document.value&&CFGetTypeID(document)==CFURLGetTypeID())documentURL=(__bridge NSURL*)document.value;
            else if(document.value&&CFGetTypeID(document)==CFStringGetTypeID()) {
                NSString* value=(__bridge NSString*)document.value;
                documentURL=value.isAbsolutePath?[NSURL fileURLWithPath:value]:[NSURL URLWithString:value];
            }
            if(documentURL.isFileURL)result["documentPath"]=str(documentURL.path);
            auto readEdited=[&](AXUIElementRef element,const char* source) {
                auto edited=attribute(element,kAXEditedAttribute);
                if(edited.value&&CFGetTypeID(edited)==CFBooleanGetTypeID())result["documentEdited"]=bool(CFBooleanGetValue((CFBooleanRef)edited.value));
                else if(edited.value&&CFGetTypeID(edited)==CFNumberGetTypeID()){int dirty=0;CFNumberGetValue((CFNumberRef)edited.value,kCFNumberIntType,&dirty);result["documentEdited"]=dirty!=0;}
                if(result.contains("documentEdited"))result["documentEditedSource"]=source;
            };
            readEdited(ax.get(),"window");
            if(!result.contains("documentEdited")) {
                auto close=attribute(ax.get(),kAXCloseButtonAttribute);
                if(close.value&&CFGetTypeID(close)==AXUIElementGetTypeID())readEdited((AXUIElementRef)close.value,"closeButton");
            }
            if(blocker) {
                auto children=attribute(ax.get(),kAXChildrenAttribute);AX sheet;
                if(children.value&&CFGetTypeID(children)==CFArrayGetTypeID())for(id child in (__bridge NSArray*)children.value) {
                    auto candidate=(__bridge AXUIElementRef)child;
                    if(text(candidate,kAXRoleAttribute)=="AXSheet"){sheet=retain(candidate);break;}
                }
                if(sheet) {
                    auto id=window_ref(0,w.pid,sheet);result["enabled"]=false;result["blockingWindow"]=describe(id,windows.at(id),false);
                } else {
                    auto application=app(w.pid);auto current=attribute(application.get(),kAXFocusedWindowAttribute);
                    if(current.value&&CFGetTypeID(current)==AXUIElementGetTypeID()&&!CFEqual(current.value,ax.get())&&boolean((AXUIElementRef)current.value,kAXModalAttribute)) {
                        auto id=window_ref(0,w.pid,retain((AXUIElementRef)current.value));result["enabled"]=false;result["blockingWindow"]=describe(id,windows.at(id),false);
                    }
                }
            }
        } catch(const std::exception& e){result["accessibilityError"]=e.what();}
        w.metadata=result;return result;
    }
    Json activate(const Json& a) {
        auto& w=window(a);auto ref=a.at("windowRef").get<std::string>();auto state=describe(ref,w);
        if(state.contains("accessibilityError"))throw std::runtime_error(state["accessibilityError"].get<std::string>());
        if(!state.value("enabled",true))return {{"status","error"},{"code","window_blocked"},{"dispatch","not_started"},{"blockingWindow",state["blockingWindow"]}};
        auto ax=axwindow(w);auto running=[NSRunningApplication runningApplicationWithProcessIdentifier:w.pid];
        auto permission=access("window.activate",a);if(!permission.empty())return permission;
        if(boolean(ax.get(),kAXMinimizedAttribute))check(AXUIElementSetAttributeValue(ax.get(),kAXMinimizedAttribute,kCFBooleanFalse),"Restore");
        auto permitted=access("window.activate",a);if(!permitted.empty())return permitted;
        [running activateWithOptions:0];auto raised=AXUIElementPerformAction(ax.get(),kAXRaiseAction);
        if(raised!=kAXErrorSuccess&&!(w.sheet&&raised==kAXErrorActionUnsupported&&focused(w)))check(raised,"Raise window");
        // Some providers ignore focusedWindow writes; the final focus check is authoritative.
        auto application=app(w.pid);AXUIElementSetAttributeValue(application.get(),kAXFocusedWindowAttribute,ax.get());
        for(int i=0;i<20;++i){if(focused(w))return describe(ref,w);std::this_thread::sleep_for(std::chrono::milliseconds(25));}
        return {{"status","error"},{"code","window_activation_failed"},{"dispatch","not_started"},{"message","macOS did not focus the requested window"}};
    }
    Element& element(const Json& a) {
        auto it=elements.find(a.at("elementRef").get<std::string>());if(it==elements.end())throw std::invalid_argument("Unknown elementRef; inspect again");
        window({{"windowRef",it->second.window}});auto parent=attribute(it->second.ax.get(),kAXWindowAttribute);
        auto target=axwindow(windows.at(it->second.window));
        if(parent.value&&!CFEqual(parent.value,target.get())&&!CFEqual(it->second.ax.get(),target.get())) {
            // AXWindow of a sheet's control can be the owning top-level window.
            // Keep the sheet identity check by proving ancestry instead of
            // accepting every element that shares the owning application.
            bool belongs=false;
            if(windows.at(it->second.window).sheet) {
                auto current=it->second.ax;
                for(int depth=0;depth<32;++depth) {
                    auto ancestor=attribute(current.get(),kAXParentAttribute);
                    if(!ancestor.value||CFGetTypeID(ancestor)!=AXUIElementGetTypeID())break;
                    if(CFEqual(ancestor.value,target.get())){belongs=true;break;}
                    if(CFEqual(ancestor.value,current.get()))break;
                    current=retain((AXUIElementRef)ancestor.value);
                }
            }
            if(!belongs)throw std::runtime_error("stale_element_window");
        }
        return it->second;
    }
    Json describe_element(AXUIElementRef e,const std::string& ref) {
        auto role=text(e,kAXRoleAttribute);static const std::map<std::string,std::string> roles={{"AXWindow","Window"},{"AXSheet","Window"},{"AXButton","Button"},{"AXTextField","Edit"},{"AXTextArea","Edit"},{"AXStaticText","Text"},{"AXCheckBox","CheckBox"},{"AXRadioButton","RadioButton"},{"AXComboBox","ComboBox"},{"AXPopUpButton","ComboBox"},{"AXGroup","Group"},{"AXScrollArea","Pane"},{"AXTable","Table"},{"AXRow","DataItem"},{"AXSlider","Slider"},{"AXMenuItem","MenuItem"}};
        auto name=text(e,kAXTitleAttribute);if(name.empty())name=text(e,kAXDescriptionAttribute);
        auto value=attribute(e,kAXValueAttribute);Json v=nullptr;
        if(value.value&&CFGetTypeID(value)==CFStringGetTypeID())v=str((__bridge NSString*)value.value);
        else if(value.value&&CFGetTypeID(value)==CFNumberGetTypeID()){double number=0;CFNumberGetValue((CFNumberRef)value.value,kCFNumberDoubleType,&number);v=number;}
        Ref<CFArrayRef> actions;CFArrayRef array=nullptr;AXUIElementCopyActionNames(e,&array);Ref<CFArrayRef> supported(array);
        bool invoke=array&&CFArrayContainsValue(array,CFRangeMake(0,CFArrayGetCount(array)),kAXPressAction);
        auto b=bounds(e);
        return {{"elementRef",ref},{"name",name},{"role",roles.contains(role)?roles.at(role):role},{"nativeRole",role},
            {"automationId",text(e,kAXIdentifierAttribute)},{"value",v},{"enabled",boolean(e,kAXEnabledAttribute,true)},
            {"offscreen",b.size.width<=0||b.size.height<=0},{"bounds",rect(b)},{"patterns",{{"invoke",invoke}}}};
    }
    Json tree(const Json& a) {
        auto& w=window(a);auto root=axwindow(w);int depth=integer(a,"depth",6,0,50),limit=integer(a,"limit",80,1,10000),budget=integer(a,"nodeBudget",1500,1,100000),ms=integer(a,"queryTimeoutMs",3000,1,60000);
        auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(ms);
        std::deque<std::pair<AX,int>> queue;queue.push_back({root,0});Json rows=Json::array();int visited=0;std::string stop;bool depthLimited=false;
        Json selector=a.value("selector",Json::object());
        while(!queue.empty()) {
            if(std::chrono::steady_clock::now()>=end){stop="timeout";break;}
            if(visited>=budget){stop="nodeBudget";break;}
            auto [e,level]=queue.front();queue.pop_front();++visited;
            auto id="e-"+prefix+std::to_string(++serial);auto row=describe_element(e.get(),id);row["depth"]=level;
            bool matches=true;for(auto it=selector.begin();it!=selector.end();++it) {
                if(it.key()=="nameContains"){if(row["name"].get<std::string>().find(it.value().get<std::string>())==std::string::npos)matches=false;}
                else if(!row.contains(it.key())||row[it.key()]!=it.value())matches=false;
            }
            if(matches){elements.emplace(id,Element{e,a.at("windowRef")});rows.push_back(row);if(int(rows.size())>=limit){stop="limit";break;}}
            auto children=attribute(e.get(),kAXChildrenAttribute);
            if(children.value&&CFGetTypeID(children)==CFArrayGetTypeID()) {
                auto count=CFArrayGetCount((CFArrayRef)children.value);
                if(level>=depth){depthLimited|=count>0;continue;}
                for(CFIndex i=0;i<count&&queue.size()<size_t(budget);++i)queue.push_back({retain((AXUIElementRef)CFArrayGetValueAtIndex((CFArrayRef)children.value,i)),level+1});
                if(count>budget)depthLimited=true;
            }
        }
        if(stop.empty()&&depthLimited)stop="depthLimit";
        return {{"status","ok"},{"elements",rows},{"visited",visited},{"truncated",!stop.empty()},{"has_more",!stop.empty()},{"evidenceComplete",stop.empty()},{"stopReason",stop.empty()?"completed":stop}};
    }
    Json capture(const std::string& op,const Json& a) {
        if(!CGPreflightScreenCaptureAccess())throw std::runtime_error("screen_recording_permission_required: grant Screen Recording and restart");
        CGRect target;Json windowBounds=nullptr;
        if(op=="capture.window") {
            auto& w=window(a);
            if(w.sheet)target=bounds(w.sheet.get());
            else {NSDictionary* row=info(w);CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString*)kCGWindowBounds],&target);}
            windowBounds=rect(target);
            if(a.contains("region")) {auto region=cgrect(a["region"]);
                if(region.origin.x<0||region.origin.y<0||region.size.width<=0||region.size.height<=0||CGRectGetMaxX(region)>target.size.width||CGRectGetMaxY(region)>target.size.height)throw std::invalid_argument("Capture region outside window");
                target=CGRectOffset(region,target.origin.x,target.origin.y);}
        } else if(op=="capture.region")target=cgrect(a);
        else if(op=="capture.element")target=bounds(element(a).ax.get());
        else target=CGDisplayBounds(CGMainDisplayID());
        target=CGRectIntegral(target);int w=target.size.width,h=target.size.height;
        if(w<=0||h<=0||int64_t(w)*h>64000000)throw std::invalid_argument("Capture bounds invalid or exceed 64 million pixels");
        __block SCShareableContent* content=nil;__block NSError* error=nil;
        auto ready=dispatch_semaphore_create(0);
        [SCShareableContent getShareableContentExcludingDesktopWindows:NO onScreenWindowsOnly:YES completionHandler:^(SCShareableContent* c,NSError* e){content=c;error=e;dispatch_semaphore_signal(ready);}];
        if(dispatch_semaphore_wait(ready,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC)))throw std::runtime_error("ScreenCaptureKit content timeout");
        if(error||!content)throw std::runtime_error("ScreenCaptureKit: "+str(error.localizedDescription));
        int scale=1;
        for(SCDisplay* display in content.displays)if(CGRectIntersectsRect(target,display.frame)) {
            auto filter=[[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
            scale=std::max(scale,int(std::ceil(filter.pointPixelScale)));
        }
        if(scale>4||int64_t(w)*h*scale*scale>64000000)throw std::invalid_argument("Retina capture exceeds 64 million pixels");
        w*=scale;h*=scale;
        Image result{w,h,std::vector<uint8_t>(size_t(w)*h*3,0)};bool captured=false;
        // Preserve Retina detail. Mixed displays share the largest native scale;
        // bounds stay in points so the common agent layer maps image input correctly.
        for(SCDisplay* display in content.displays) {
            CGRect intersection=CGRectIntersection(target,display.frame);if(CGRectIsNull(intersection)||CGRectIsEmpty(intersection))continue;
            auto filter=[[SCContentFilter alloc] initWithDisplay:display excludingWindows:@[]];
            auto config=[SCStreamConfiguration new];config.width=size_t(intersection.size.width*scale);config.height=size_t(intersection.size.height*scale);
            config.sourceRect=CGRectOffset(intersection,-display.frame.origin.x,-display.frame.origin.y);config.showsCursor=NO;
            __block std::shared_ptr<std::remove_pointer_t<CGImageRef>> image;__block NSError* captureError=nil;auto done=dispatch_semaphore_create(0);
            [SCScreenshotManager captureImageWithFilter:filter configuration:config completionHandler:^(CGImageRef cg,NSError* e){if(cg)image={CGImageRetain(cg),[](CGImageRef p){CGImageRelease(p);}};captureError=e;dispatch_semaphore_signal(done);}];
            if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC)))throw std::runtime_error("ScreenCaptureKit screenshot timeout");
            if(captureError||!image)throw std::runtime_error("ScreenCaptureKit: "+str(captureError.localizedDescription));
            auto tile=from_cg(image.get());if(tile.width!=int(intersection.size.width*scale)||tile.height!=int(intersection.size.height*scale))throw std::runtime_error("Unexpected capture dimensions");
            int x=int((intersection.origin.x-target.origin.x)*scale),y=int((intersection.origin.y-target.origin.y)*scale);
            for(int row=0;row<tile.height;++row)std::copy_n(tile.rgb.data()+size_t(row)*tile.width*3,tile.width*3,result.rgb.data()+(size_t(row+y)*w+x)*3);captured=true;
        }
        if(!captured)throw std::runtime_error("Capture target is outside active displays");
        auto finalAccess=access(op,a);if(!finalAccess.empty())return finalAccess;
        auto output=std::filesystem::path(a.at("output").get<std::string>());std::string original;
        int maxEdge=integer(a,"maxEdge",32000,1,32000);
        if(std::max(w,h)>maxEdge){auto path=output;path.replace_extension(".original.png");save_png(result,path);original=std::filesystem::absolute(path).string();result=resize_image(result,maxEdge);}
        bool webp=output.extension()==".webp";if(webp)save_webp(result,output,a.value("lossless",false));else save_png(result,output);
        return {{"path",std::filesystem::absolute(output).string()},{"originalPath",original},{"mimeType",webp?"image/webp":"image/png"},
            {"imageRef","img-sha256-"+file_sha256(output)},{"bounds",rect(target)},{"windowBounds",windowBounds},
            {"width",result.width},{"height",result.height},{"coordinateUnits","screen_points"},{"pixelsPerPoint",scale},{"method","macos.ScreenCaptureKit"},
            {"content","visible_screen_pixels_including_occluders"},{"capturedAtUnixMs",std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count()}};
    }
    Json input(const std::string& op,const Json& a) {
        auto initial=access(op,a);if(!initial.empty())return initial;
        Json nativeBounds;
        if(a.contains("windowRef")) {
            auto& w=window(a);auto current=describe(a.at("windowRef"),w);
            if(current.contains("accessibilityError"))throw std::runtime_error(current["accessibilityError"].get<std::string>());
            if(a.contains("expectedSize")&&(current["bounds"]["width"]!=a["expectedSize"]["width"]||current["bounds"]["height"]!=a["expectedSize"]["height"]))throw std::runtime_error("stale_window_geometry");
            if(!current.value("enabled",true))return {{"status","error"},{"code","window_blocked"},{"dispatch","not_started"},{"blockingWindow",current["blockingWindow"]}};
            if(!focused(w)) {auto result=activate(a);if(result.value("status",std::string{})=="error")return result;current=result;}
            nativeBounds=current.at("bounds");
        }
        if(op=="input.key_chord") {
            const auto& keys=a.at("keys");if(!keys.is_array()||keys.empty()||keys.size()>16)throw std::invalid_argument("Invalid key chord");
            auto mapping=keymap();std::vector<std::pair<CGKeyCode,CGEventFlags>> codes;
            std::set<CGKeyCode> seen;
            for(const auto& item:keys) {
                auto name=item.get<std::string>();if(!mapping.contains(name))throw std::invalid_argument("Unsupported key: "+name);
                CGEventFlags flag=0;if(name=="WIN"||name=="CMD")flag=kCGEventFlagMaskCommand;else if(name=="CTRL")flag=kCGEventFlagMaskControl;else if(name=="ALT")flag=kCGEventFlagMaskAlternate;else if(name=="SHIFT")flag=kCGEventFlagMaskShift;
                if(!seen.insert(mapping.at(name)).second)throw std::invalid_argument("Duplicate key in chord");codes.push_back({mapping.at(name),flag});
            }
            std::stable_partition(codes.begin(),codes.end(),[](const auto& code){return code.second!=0;});
            // Allocate the complete chord before posting any key-down, so allocation
            // failure cannot leave a modifier held on the user's desktop.
            std::vector<Ref<CGEventRef>> events;CGEventFlags flags=0;
            auto event=[&](CGKeyCode code,bool down) {
                Ref<CGEventRef> e(CGEventCreateKeyboardEvent(nullptr,code,down));
                if(!e.value)throw std::runtime_error("Cannot create keyboard event");
                CGEventSetFlags(e,flags);events.push_back(std::move(e));
            };
            for(auto [code,flag]:codes){flags|=flag;event(code,true);}
            for(auto it=codes.rbegin();it!=codes.rend();++it){flags&=~it->second;event(it->first,false);}
            auto access=this->access(op,a);if(!access.empty())return access;
            for(auto& e:events)CGEventPost(kCGHIDEventTap,e);
            auto completed=this->access(op,a,true);if(!completed.empty())return completed;
            return receipt("macos.CGEvent.keyboard");
        }
        if(op=="input.type_text") {
            NSString* string=ns(a.at("text").get<std::string>());
            for(NSUInteger pos=0;pos<string.length;) {
                auto access=this->access(op,a,pos>0);if(!access.empty())return access;
                NSUInteger count=std::min<NSUInteger>(128,string.length-pos);
                if(pos+count<string.length&&CFStringIsSurrogateHighCharacter([string characterAtIndex:pos+count-1]))--count;
                UniChar chars[128];[string getCharacters:chars range:NSMakeRange(pos,count)];
                for(bool down:{true,false}){auto e=CGEventCreateKeyboardEvent(nullptr,0,down);if(e){CGEventSetFlags(e,0);CGEventKeyboardSetUnicodeString(e,count,chars);}post(e);}pos+=count;
            }
            auto completed=this->access(op,a,string.length>0);if(!completed.empty())return completed;
            return receipt("macos.CGEvent.unicode");
        }
        uint32_t displayCount=0;CGGetActiveDisplayList(0,nullptr,&displayCount);
        std::vector<CGDirectDisplayID> activeDisplays(displayCount);CGGetActiveDisplayList(displayCount,activeDisplays.data(),&displayCount);
        auto point=[&](int x,int y) {
            auto space=a.value("coordinateSpace",std::string("screen_physical"));
            if(space=="window_relative"||space=="client_relative") {
                if(nativeBounds.is_null())throw std::invalid_argument("Window-relative input requires windowRef");
                const auto& b=nativeBounds;
                if(x<0||y<0||x>=b["width"].get<int>()||y>=b["height"].get<int>())throw std::invalid_argument("Point outside target window");x+=b["x"].get<int>();y+=b["y"].get<int>();
            } else if(space!="screen_physical")throw std::invalid_argument("Unsupported coordinate space");
            CGPoint p=CGPointMake(x,y);
            bool inside=false;for(auto display:activeDisplays)inside|=CGRectContainsPoint(CGDisplayBounds(display),p);
            if(!inside)throw std::invalid_argument("Point outside active displays");return p;
        };
        std::vector<CGPoint> points;
        if(a.contains("points")) {
            if(op!="input.move"||!a["points"].is_array()||a["points"].empty()||a["points"].size()>4096)throw std::invalid_argument("Invalid pointer path");
            for(const auto& p:a["points"]){if(!p.is_array()||p.size()!=2||!p[0].is_number_integer()||!p[1].is_number_integer())throw std::invalid_argument("Invalid pointer point");points.push_back(point(p[0].get<int>(),p[1].get<int>()));}
        } else points.push_back(point(integer(a,"x",0,-100000,100000),integer(a,"y",0,-100000,100000)));
        if(op=="input.drag")points.push_back(point(integer(a,"toX",0,-100000,100000),integer(a,"toY",0,-100000,100000)));
        std::string hold=a.value("hold",op=="input.drag"?a.value("button",std::string("left")):std::string{});
        if(!hold.empty()&&hold!="left"&&hold!="right"&&hold!="middle")throw std::invalid_argument("Unsupported mouse button");
        if(!hold.empty()&&points.size()<2)throw std::invalid_argument("Held path needs two points");
        auto pointerAccess=access(op,a);if(!pointerAccess.empty())return pointerAccess;
        if(op=="input.scroll") {
            int delta=integer(a,"delta",0,-10000,10000);post(CGEventCreateScrollWheelEvent(nullptr,kCGScrollEventUnitLine,1,delta));return receipt("macos.CGEvent.scroll");
        }
        int count=integer(a,"count",1,1,2);
        if(op=="input.click")hold=a.value("button",std::string("left"));
        if(!hold.empty()&&hold!="left"&&hold!="right"&&hold!="middle")throw std::invalid_argument("Unsupported mouse button");
        CGMouseButton button=hold=="right"?kCGMouseButtonRight:hold=="middle"?kCGMouseButtonCenter:kCGMouseButtonLeft;
        auto down=button==kCGMouseButtonRight?kCGEventRightMouseDown:button==kCGMouseButtonCenter?kCGEventOtherMouseDown:kCGEventLeftMouseDown;
        auto up=button==kCGMouseButtonRight?kCGEventRightMouseUp:button==kCGMouseButtonCenter?kCGEventOtherMouseUp:kCGEventLeftMouseUp;
        auto drag=button==kCGMouseButtonRight?kCGEventRightMouseDragged:button==kCGMouseButtonCenter?kCGEventOtherMouseDragged:kCGEventLeftMouseDragged;
        if(op=="input.click") {
            auto access=this->access(op,a);if(!access.empty())return access;
            mouse(kCGEventMouseMoved,points[0],button);
            for(int i=1;i<=count;++i){auto access=this->access(op,a,i>1);if(!access.empty())return access;mouse(down,points[0],button,i);mouse(up,points[0],button,i);}
            auto completed=this->access(op,a,true);if(!completed.empty())return completed;
            return receipt("macos.CGEvent.click");
        }
        int interval=integer(a,"intervalMs",5,0,1000);
        auto allowed=this->access(op,a);if(!allowed.empty())return allowed;
        mouse(kCGEventMouseMoved,points[0],button);bool pressed=false;CGPoint last=points[0];Json interrupted;
        try {
            if(!hold.empty()){mouse(down,last,button);pressed=true;}
            for(size_t i=1;i<points.size();++i){interrupted=this->access(op,a,true);if(!interrupted.empty())break;last=points[i];mouse(pressed?drag:kCGEventMouseMoved,last,button);if(interval)std::this_thread::sleep_for(std::chrono::milliseconds(interval));}
            if(pressed){mouse(up,last,button);pressed=false;}
        } catch(...){if(pressed)mouse(up,last,button);throw;}
        if(!interrupted.empty())return interrupted;
        return receipt("macos.CGEvent.path");
    }
};
Desktop::Desktop():impl_(std::make_unique<Impl>()){}
Desktop::~Desktop()=default;
Json Desktop::operations() {
    return Json::array({"system.info","system.session","process.list","display.list","window.list","window.get","window.foreground", "window.activate","window.move","window.resize","window.minimize","window.restore","window.close",
        "ui.tree","ui.find","ui.get","ui.text","ui.focus","ui.invoke","ui.click","ui.set_value","ui.fill",
        "capture.window","capture.desktop","capture.region","capture.element","input.click","input.move","input.drag","input.scroll","input.key_chord","input.type_text","clipboard.read","clipboard.write","clipboard.formats","runtime.capabilities"});
}
Json Desktop::execute(const std::string& op,const Json& a) {
    @autoreleasepool {
        if(!a.is_object())throw std::invalid_argument("args must be an object");auto supported=operations();
        if(std::find(supported.begin(),supported.end(),op)==supported.end())throw std::invalid_argument("Unsupported macOS operation: "+op);
        auto& p=*impl_;
        if(!background_operation(op)) {auto access=p.access(op,a);if(!access.empty())return access;}
        if(op=="system.session")return p.environment();
        if(op=="system.info")return {{"platform","macos"},{"osVersion",str(NSProcessInfo.processInfo.operatingSystemVersionString)},{"processors",NSProcessInfo.processInfo.processorCount},{"coordinateUnits","screen_points"}};
        if(op=="runtime.capabilities")return {{"platform","macos"},{"operations",supported},{"nativeAutomation","Accessibility"},{"captureBackend","ScreenCaptureKit"},{"coordinateUnits","screen_points"}};
        if(op=="window.list") {
            NSArray* rows=CFBridgingRelease(CGWindowListCopyWindowInfo(a.value("includeHidden",false)?kCGWindowListOptionAll:kCGWindowListOptionOnScreenOnly,kCGNullWindowID));Json windows=Json::array();
            for(NSDictionary* row in rows) {
                if([row[(__bridge NSString*)kCGWindowLayer] intValue]!=0)continue;
                auto pid=[row[(__bridge NSString*)kCGWindowOwnerPID] intValue];auto id=[row[(__bridge NSString*)kCGWindowNumber] unsignedIntValue];
                if(a.contains("pid")&&pid!=a["pid"].get<int>())continue;CGRect b{};CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)row[(__bridge NSString*)kCGWindowBounds],&b);
                if(b.size.width<1||b.size.height<1)continue;auto ref=p.window_ref(id,pid);
                // Listing must not traverse Accessibility providers or change focus.
                auto running=[NSRunningApplication runningApplicationWithProcessIdentifier:pid];
                windows.push_back({{"windowRef",ref},{"title",str(row[(__bridge NSString*)kCGWindowName])},{"pid",pid},{"bounds",rect(b)},
                    {"executable",str(running.executableURL.lastPathComponent)},{"className","AXWindow"},{"dpi",72}});
            }return {{"windows",windows},{"desktopContext",p.context()}};
        }
        if(op=="window.get")return p.describe(a.at("windowRef"),p.window(a));
        if(op=="window.foreground") {
            auto pid=NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
            auto windows=execute("window.list",{{"pid",pid}})["windows"];
            for(const auto& row:windows){auto state=execute("window.get",{{"windowRef",row["windowRef"]}});if(state.value("foreground",false))return state;}
            return {{"status","not_found"}};
        }
        if(op=="window.activate")return p.activate(a);
        if(op.starts_with("window.")) {
            auto& w=p.window(a);auto ax=p.axwindow(w);
            auto access=p.access(op,a);if(!access.empty())return access;
            if(a.value("preserveWindowGeometry",false)&&(op=="window.move"||op=="window.resize"))throw std::runtime_error("preserveWindowGeometry forbids geometry changes");
            if(op=="window.close"){auto button=attribute(ax.get(),kAXCloseButtonAttribute);if(!button.value)throw std::runtime_error("Window has no close button");check(AXUIElementPerformAction((AXUIElementRef)button.value,kAXPressAction),"Close");return receipt("macos.AX.close");}
            if(op=="window.minimize"||op=="window.restore")check(AXUIElementSetAttributeValue(ax.get(),kAXMinimizedAttribute,op=="window.minimize"?kCFBooleanTrue:kCFBooleanFalse),"Minimize/restore");
            else if(op=="window.move"){CGPoint point=CGPointMake(a.at("x").get<int>(),a.at("y").get<int>());Ref<AXValueRef> value(AXValueCreate(kAXValueTypeCGPoint,&point));check(AXUIElementSetAttributeValue(ax.get(),kAXPositionAttribute,value),"Move");}
            else {CGSize size=CGSizeMake(integer(a,"width",0,1,32000),integer(a,"height",0,1,32000));Ref<AXValueRef> value(AXValueCreate(kAXValueTypeCGSize,&size));check(AXUIElementSetAttributeValue(ax.get(),kAXSizeAttribute,value),"Resize");}
            return p.describe(a.at("windowRef"),w);
        }
        if(op=="process.list"){Json rows=Json::array();for(NSRunningApplication* app in NSWorkspace.sharedWorkspace.runningApplications)rows.push_back({{"pid",app.processIdentifier},{"name",str(app.localizedName)},{"executable",str(app.executableURL.path)}});return {{"processes",rows}};}
        if(op=="display.list") {
            uint32_t count=0;CGGetActiveDisplayList(0,nullptr,&count);std::vector<CGDirectDisplayID> ids(count);CGGetActiveDisplayList(count,ids.data(),&count);Json rows=Json::array();
            for(auto id:ids)rows.push_back({{"displayRef",std::to_string(id)},{"bounds",rect(CGDisplayBounds(id))},{"primary",bool(CGDisplayIsMain(id))},{"coordinateUnits","screen_points"}});return {{"displays",rows}};
        }
        if(op=="ui.tree"||op=="ui.find")return p.tree(a);
        if(op.starts_with("ui.")) {
            auto& e=p.element(a);auto ax=e.ax.get();
            if(op=="ui.get")return p.describe_element(ax,a.at("elementRef"));
            if(op=="ui.text")return {{"text",text(ax,kAXValueAttribute)}};
            auto state=p.describe(e.window,p.windows.at(e.window));
            if(state.contains("accessibilityError"))throw std::runtime_error(state["accessibilityError"].get<std::string>());
            if(!state.value("enabled",true))return {{"status","error"},{"code","window_blocked"},{"dispatch","not_started"},{"blockingWindow",state["blockingWindow"]}};
            if(!boolean(ax,kAXEnabledAttribute,true))throw std::runtime_error("Control is disabled");
            auto access=p.access(op,a);if(!access.empty())return access;
            if(op=="ui.focus")check(AXUIElementSetAttributeValue(ax,kAXFocusedAttribute,kCFBooleanTrue),"Focus");
            else if(op=="ui.invoke"||op=="ui.click") {
                Ref<CFArrayRef> actions;CFArrayRef names=nullptr;check(AXUIElementCopyActionNames(ax,&names),"Read actions");Ref<CFArrayRef> owned(names);
                if(names&&CFArrayContainsValue(names,CFRangeMake(0,CFArrayGetCount(names)),kAXPressAction)) {
                    auto permitted=p.access(op,a);if(!permitted.empty())return permitted;
                    check(AXUIElementPerformAction(ax,kAXPressAction),"Press");
                }
                else if(op=="ui.click") {
                    auto b=bounds(ax),wb=cgrect(state["bounds"]);
                    Json pointer={{"windowRef",e.window},{"coordinateSpace","window_relative"},{"x",int(CGRectGetMidX(b)-wb.origin.x)},{"y",int(CGRectGetMidY(b)-wb.origin.y)}};
                    if(a.contains("expectedDesktopGeneration"))pointer["expectedDesktopGeneration"]=a["expectedDesktopGeneration"];
                    return p.input("input.click",pointer);
                }
                else throw std::runtime_error("Control does not support AXPress");
            } else {
                const auto wanted=a.at(op=="ui.fill"?"text":"value").get<std::string>();
                Boolean settable=false;check(AXUIElementIsAttributeSettable(ax,kAXValueAttribute,&settable),"Read value support");if(!settable)throw std::runtime_error("Control value is not editable");
                auto permitted=p.access(op,a);if(!permitted.empty())return permitted;
                check(AXUIElementSetAttributeValue(ax,kAXValueAttribute,(__bridge CFStringRef)ns(wanted)),"Set value");
                int timeout=integer(a,"timeoutMs",3000,1,30000);auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(timeout);
                do {auto access=p.access(op,a,true);if(!access.empty())return access;if(text(ax,kAXValueAttribute)==wanted)return {{"status","ok"},{"dispatch","dispatched"},{"verification","passed"},{"method","macos.AXValue"}};std::this_thread::sleep_for(std::chrono::milliseconds(25));}while(std::chrono::steady_clock::now()<end);
                return {{"status","error"},{"verification","failed"},{"dispatch","dispatched"},{"message","Control value did not match requested text"}};
            }
            return receipt("macos.Accessibility");
        }
        if(op.starts_with("capture."))return p.capture(op,a);
        if(op.starts_with("input."))return p.input(op,a);
        if(op=="clipboard.formats"){Json types=Json::array();for(NSString* type in NSPasteboard.generalPasteboard.types)types.push_back(str(type));return {{"formats",types}};}
        if(op=="clipboard.read") {NSString* value=[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];return {{"text",value?Json(str(value)):Json(nullptr)},{"format","public.utf8-plain-text"}};}
        NSString* value=ns(a.at("text").get<std::string>());[NSPasteboard.generalPasteboard clearContents];if(![NSPasteboard.generalPasteboard setString:value forType:NSPasteboardTypeString])throw std::runtime_error("Clipboard write failed");return receipt("macos.NSPasteboard");
    }
}
}
