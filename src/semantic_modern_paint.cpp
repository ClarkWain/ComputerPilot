#include <desktop_pilot/semantic.hpp>
#include <desktop_pilot/profiles.hpp>
#include <desktop_pilot/service.hpp>
#include <cstdio>
#include <set>

namespace dp {
namespace {
int number(const Json& v, int lo, int hi) {
    if (!v.is_number_integer() || v.get<int64_t>() < lo || v.get<int64_t>() > hi)
        throw std::invalid_argument("Integer outside supported range");
    return v.get<int>();
}
void rgb(const Json& v) {
    if (!v.is_array() || v.size()!=3) throw std::invalid_argument("RGB requires three channels");
    for (const auto& n:v) number(n,0,255);
}
void point(const Json& v) {
    if (!v.is_array() || v.size()!=2) throw std::invalid_argument("Point requires x,y");
    for (const auto& n:v) number(n,0,32000);
}
int strokeWidth(const Json& v) {
    int n=number(v,1,30);
    if(n>24 && n%2)throw std::invalid_argument("Supported widths: 1..24, 26, 28, 30 pixels");
    return n;
}
void validate(const Json& item) {
    const auto action=item.at("action").get<std::string>(); const auto& a=item.at("args");
    if (!a.is_object()) throw std::invalid_argument("args must be an object");
    std::set<std::string> keys;
    if(action=="drawing.selectBrush") {
        keys={"brush"}; if(a.at("brush")!="brush" && a.at("brush")!="pencil") throw std::invalid_argument("Supported brushes: brush, pencil");
    } else if(action=="drawing.setColor") {keys={"color"};rgb(a.at("color"));}
    else if(action=="drawing.setStrokeWidth") {keys={"width"};strokeWidth(a.at("width"));}
    else if(action=="drawing.fillAt") {keys={"position","color"};point(a.at("position"));rgb(a.at("color"));}
    else if(action=="drawing.drawPolyline") {
        keys={"points","closed","stroke"}; const auto& p=a.at("points");
        if(!p.is_array() || p.size()<2 || p.size()>4095) throw std::invalid_argument("Polyline requires 2..4095 points");
        for(size_t i=0;i<p.size();++i) {point(p[i]);if(i && p[i]==p[i-1])throw std::invalid_argument("Repeated adjacent point");}
        if(a.contains("closed") && !a["closed"].is_boolean())throw std::invalid_argument("closed must be boolean");
        const auto& s=a.at("stroke");rgb(s.at("color"));strokeWidth(s.at("width"));
        for(auto it=s.begin();it!=s.end();++it)if(it.key()!="color" && it.key()!="width")throw std::invalid_argument("Unsupported stroke option");
    } else throw std::invalid_argument("Unsupported modern Paint action");
    for(auto it=a.begin();it!=a.end();++it)if(!keys.contains(it.key()))throw std::invalid_argument("Unsupported argument: "+it.key());
}
}
Json run_modern_paint(const Json& request,const Json& profile,const SemanticCall& execute,const std::function<void(int)>& sleep) {
    if(request.at("action")=="drawing.drawScene")
        for(auto it=request.at("args").begin();it!=request.at("args").end();++it)
            if(it.key()!="items")throw std::invalid_argument("Modern scene supports only items");
    Json items=request.at("action")=="drawing.drawScene" ? request.at("args").at("items") : Json::array({request});
    if(!items.is_array() || items.empty() || items.size()>256)throw std::invalid_argument("Expected 1..256 actions");
    for(const auto& item:items)validate(item); // Entire batch validated before any desktop access.
    const auto window=request.at("windowRef"); size_t calls=0,completed=0;bool drawn=false;
    std::string phase="preflight";
    auto call=[&](const std::string& op,const Json& a)->Json {
        ++calls;auto r=execute(op,a);if(operation_failed(r))throw std::runtime_error(op+": "+r.dump());return r;
    };
    // Per-session cache of stable UIA elementRefs keyed by selector.dump()+root.
    // Ribbon controls (zoom/primary/editColors/brush/pencil/fill/width/opacity)
    // are stable across a batch. Refreshing via ui.get is one small RPC vs
    // ui.find's whole-tree DFS (2s+ on Paint 11.2605). Invalidated on ui.get
    // failure (element destroyed) — caller falls back to a full find.
    std::map<std::string,Json> stableCache;
    auto findFull=[&](const Json& selector,int depth,Json root)->Json {
        // Cap uniqueness check at limit=2 with stopAfterLimit: we only need to
        // know "unique" vs "not unique". Depth 8 covers the ribbon; caller can
        // pass more for nested XAML popups.
        Json args={{"windowRef",window},{"selector",selector},{"depth",depth},{"limit",2},{"stopAfterLimit",true},{"format","full"},{"queryTimeoutMs",5000}};
        if(!root.is_null())args["elementRef"]=root;
        auto r=call("ui.find",args);Json found=Json::array();
        std::set<std::string> seen;
        for(auto& e:r.at("elements")) {
            if(!e.value("enabled",false) || e.value("offscreen",true))continue;
            std::string key=e.value("role",std::string{})+"\n"+e.value("name",std::string{});
            if(e.contains("automationId") && e.at("automationId").is_string())key+="\n"+e.at("automationId").get<std::string>();
            if(e.contains("bounds") && e.at("bounds").is_object()) {
                const auto& b=e.at("bounds");
                key+="\n"+std::to_string(b.value("x",0))+","+std::to_string(b.value("y",0))+","+
                    std::to_string(b.value("width",0))+","+std::to_string(b.value("height",0));
            }
            if(seen.insert(key).second)found.push_back(e);
        }
        // With stopAfterLimit=limit=2, truncated:true + found.size()==2 means
        // 2 duplicates present → non-unique. truncated:true + found.size()==1
        // via non-limit stopReason (budget/timeout/depth) means the tree wasn't
        // fully scanned; treat as not-unique for safety.
        if(r.value("truncated",false) || found.size()!=1)throw std::runtime_error("control_not_unique: "+selector.dump());
        return found[0];
    };
    auto find=[&](const Json& selector,int depth=12,Json root=Json())->Json {
        std::string key=selector.dump()+(root.is_null()?std::string{}:"|"+root.dump());
        auto cached=stableCache.find(key);
        if(cached!=stableCache.end()) {
            try {
                // ui.get validates the element still exists; the cached record
                // stays authoritative (bounds/name may be stale for the caller,
                // but modern_paint uses readCanvas for canvas readback and calls
                // ui.get itself when it needs live properties for other refs).
                call("ui.get",{{"elementRef",cached->second.at("elementRef")}});
                return cached->second;
            } catch(const std::exception&) {stableCache.erase(cached);}
        }
        auto result=findFull(selector,depth,root);
        stableCache[key]=result;
        return result;
    };
    auto select=[&](const Json& selector) {auto e=find(selector);call("ui.click",{{"windowRef",window},{"elementRef",e.at("elementRef")}});sleep(60);};
    auto key=[&](const std::string& key) {call("input.key_chord",{{"windowRef",window},{"keys",Json::array({key})}});};
    // Paint spawns transient preview Panes inside the canvas after the first
    // stroke (selection markers, undo scaffold). They share the canvas name but
    // have smaller bounds; pick the largest enabled+visible match by area.
    // Not cached because bounds are the discriminator — must re-scan each pass.
    auto findLargest=[&](const Json& selector,int depth=16)->Json {
        Json args={{"windowRef",window},{"selector",selector},{"depth",depth},{"limit",128},{"format","full"},{"queryTimeoutMs",5000}};
        auto r=call("ui.find",args);Json best;long long bestArea=-1;
        for(auto& e:r.at("elements")) {
            if(!e.value("enabled",false) || e.value("offscreen",true))continue;
            if(!e.contains("bounds") || !e.at("bounds").is_object())continue;
            const auto& b=e.at("bounds");
            long long area=(long long)b.value("width",0)*b.value("height",0);
            if(area>bestArea) {bestArea=area;best=e;}
        }
        if(best.is_null())throw std::runtime_error("no_visible_match: "+selector.dump()+" elements="+std::to_string(r.at("elements").size())+" truncated="+(r.value("truncated",false)?"true":"false"));
        return best;
    };
    try {
        auto session=call("system.session",Json::object());
        if(!session.value("inputDesktopAccessible",false) || session.value("lockState",std::string{})=="locked")throw std::runtime_error("interactive_desktop_unavailable");
        auto host=call("window.get",{{"windowRef",window}});
        if(!profile_supports_dpi(profile,host.value("dpi",0)) || !host.value("enabled",true) || host.value("minimized",false))throw std::runtime_error("unsupported_window_state");
        call("window.activate",{{"windowRef",window}});
        const auto& selectors=profile.at("selectors");
        // Canvas element is stable across a batch (Paint doesn't destroy the
        // Document control while drawing). Cache its elementRef so subsequent
        // canvas() / brush-readback calls do one ui.get instead of a full
        // findLargest (limit=128 ui.find). Invalidated when ui.get fails.
        Json canvasRef;
        auto readCanvas=[&]()->Json {
            if(!canvasRef.is_null()) {
                try { return call("ui.get",{{"elementRef",canvasRef}}); }
                catch(const std::exception&) { canvasRef=Json(); }
            }
            auto c=findLargest(selectors.at("canvas"));
            canvasRef=c.at("elementRef");
            return c;
        };
        auto canvas=[&]()->Json {
            auto zoom=find(selectors.at("zoom"));
            if(zoom.at("value")!="100 百分比")throw std::runtime_error("requires_100_percent_zoom");
            auto c=readCanvas();auto w=call("window.get",{{"windowRef",window}});
            const auto& b=c.at("bounds");const auto& wb=w.at("bounds");
            int x=b.at("x").get<int>()-wb.at("x").get<int>(), y=b.at("y").get<int>()-wb.at("y").get<int>();
            int width=b.at("width"),height=b.at("height");
            if(x<0 || y<0 || x+width>wb.at("width").get<int>() || y+height>wb.at("height").get<int>() || width<2 || height<2)
                throw std::runtime_error("requires_fully_visible_canvas");
            return Json{{"x",x},{"y",y},{"width",width},{"height",height},{"windowBounds",wb},{"canvasBounds",b}};
        };
        auto setColor=[&](const Json& color) {
            select(selectors.at("primary"));select(selectors.at("editColors"));
            // Paint 11.2605 exposes the color dialog as a Popup/Custom root whose
            // role is not stable across Windows builds; HexTextBox/RedTextBox/etc
            // automationIds are unique to the color picker while the dialog is
            // open. Use findLargest to defend against custom-color slot shadow
            // elements that share the automationId with smaller bounds.
            auto field=findLargest({{"automationId","HexTextBox"},{"role","Edit"}});
            char hex[8];std::snprintf(hex,sizeof(hex),"#%02X%02X%02X",color[0].get<int>(),color[1].get<int>(),color[2].get<int>());
            auto filled=call("ui.fill",{{"windowRef",window},{"elementRef",field.at("elementRef")},{"text",hex},{"method","auto"}});
            if(filled.value("verification",std::string{})=="failed")throw std::runtime_error("color_fill_failed");
            // ui.fill already verifies HexTextBox contents. Paint derives R/G/B
            // channel inputs from hex on TAB — a passed hex verify implies the
            // channels will match. Skip 3 whole-tree findLargest scans per call
            // (was the dominant setColor cost, ~1s each on Paint 11.2605).
            call("ui.focus",{{"elementRef",field.at("elementRef")}});key("TAB");sleep(80);
            call("ui.focus",{{"elementRef",field.at("elementRef")}});key("ENTER");sleep(100);
            find(selectors.at("primary")); // Modal closed, main controls available.
        };
        auto brush=[&](const std::string& name) {
            if(name=="pencil")select(selectors.at("pencil"));
            else {
                auto e=find(selectors.at("brush"));auto b=e.at("bounds");auto w=call("window.get",{{"windowRef",window}}).at("bounds");
                call("input.click",{{"windowRef",window},{"coordinateSpace","window_relative"},
                    {"x",b.at("x").get<int>()+b.at("width").get<int>()/2-w.at("x").get<int>()},
                    {"y",b.at("y").get<int>()+b.at("height").get<int>()/3-w.at("y").get<int>()}});sleep(60);
            }
            // Canvas name encodes the active tool ("在画布上使用 画笔 工具").
            // Use readCanvas() so we hit the same cached elementRef and pay one
            // ui.get instead of a full findLargest; ui.get returns the current
            // (post-brush-switch) name, so no staleness risk.
            auto c=readCanvas();
            const auto expected=name=="pencil" ? "铅笔" : "画笔";
            if(c.at("name").get<std::string>().find(expected)==std::string::npos)throw std::runtime_error("brush_readback_mismatch");
        };
        auto width=[&](int n) {
            auto e=find(selectors.at("width"));
            // Observed Paint 11.2605 index: 0..23 -> 1..24 px,
            // 24..26 -> 26,28,30 px. Always verify the displayed pixel value.
            call("ui.set_range_value",{{"elementRef",e.at("elementRef")},{"value",n<=24?n-1:23+(n-24)/2}});
            sleep(60);
            auto current=call("ui.get",{{"elementRef",e.at("elementRef")}});
            if(current.at("value")!=std::to_string(n)+" 像素")throw std::runtime_error("width_readback_mismatch");
        };
        // Bounds-check all drawing positions before changing tools/colors.
        auto initial=canvas();
        auto check=[&](const Json& p,const Json& c) {
            if(p[0].get<int>()>=c.at("width").get<int>() || p[1].get<int>()>=c.at("height").get<int>())throw std::runtime_error("point_outside_canvas");
        };
        for(const auto& item:items) {
            const auto& a=item.at("args");if(a.contains("points"))for(const auto& p:a["points"])check(p,initial);
            if(a.contains("position"))check(a["position"],initial);
        }
        // Cache last-applied tool/color/width so repeated setColor/brush/width
        // are no-ops. This matters both for throughput (12 same-color petals
        // become one dialog, not twelve) and for stability: repeated dialog
        // pumps can leave stale HexTextBox elements in the UIA tree.
        Json lastColor,lastFillColor;std::string lastBrush;int lastWidth=-1;
        // Opacity slider stays at 100% across a batch — nothing between polylines
        // moves focus into it. Verify once via focus+END+ui.get, then skip the
        // 3 IPCs (focus/key/get) on every subsequent polyline.
        bool opacityReady=false;
        auto ensureBrush=[&](const std::string& name) {if(lastBrush!=name){brush(name);lastBrush=name;}};
        auto ensureColor=[&](const Json& color) {if(lastColor!=color){setColor(color);lastColor=color;lastFillColor=Json();opacityReady=false;}};
        auto ensureWidth=[&](int n) {if(lastWidth!=n){width(n);lastWidth=n;}};
        auto ensureFillColor=[&](const Json& color) {if(lastFillColor!=color){setColor(color);lastFillColor=color;lastColor=Json();opacityReady=false;}};
        for(const auto& item:items) {
            phase="setup";const std::string action=item.at("action");const auto& a=item.at("args");
            if(action=="drawing.selectBrush"){ensureBrush(a.at("brush"));}
            else if(action=="drawing.setColor"){ensureColor(a.at("color"));}
            else if(action=="drawing.setStrokeWidth"){ensureWidth(a.at("width"));}
            else {
                if(action=="drawing.drawPolyline") {
                    ensureBrush("brush");ensureColor(a.at("stroke").at("color"));ensureWidth(a.at("stroke").at("width"));
                    if(!opacityReady) {
                        auto opacity=find(selectors.at("opacity"));call("ui.focus",{{"elementRef",opacity.at("elementRef")}});key("END");
                        if(call("ui.get",{{"elementRef",opacity.at("elementRef")}}).at("value")!="100%")throw std::runtime_error("opacity_readback_mismatch");
                        opacityReady=true;
                    }
                } else {ensureFillColor(a.at("color"));select(selectors.at("fill"));}
                auto c=canvas();if(c!=initial)throw std::runtime_error("canvas_layout_changed");
                phase="draw";drawn=true;
                if(action=="drawing.drawPolyline") {
                    Json points=Json::array();for(const auto& p:a.at("points"))points.push_back({c.at("x").get<int>()+p[0].get<int>(),c.at("y").get<int>()+p[1].get<int>()});
                    if(a.value("closed",false) && points.front()!=points.back())points.push_back(points.front());
                    call("input.move",{{"windowRef",window},{"coordinateSpace","window_relative"},{"expectedSize",c.at("windowBounds")},{"points",points},{"hold","left"}});
                } else call("input.click",{{"windowRef",window},{"coordinateSpace","window_relative"},{"expectedSize",c.at("windowBounds")},{"x",c.at("x").get<int>()+a.at("position")[0].get<int>()},{"y",c.at("y").get<int>()+a.at("position")[1].get<int>()}});
            }
            ++completed;
        }
        return {{"status","ok"},{"completed",completed},{"total",items.size()},{"nativeCalls",calls},{"verification","settings_readback_and_actions_dispatched"},{"canvasOrigin",{initial.at("x"),initial.at("y")}},{"canvasScale",1.0}};
    } catch(const std::exception& e) {
        return {{"status","error"},{"phase",phase},{"completed",completed},{"failedIndex",completed},{"drawAttempted",drawn},{"dispatch",drawn?"possibly_partial":"not_started"},{"nativeCalls",calls},{"message",e.what()}};
    }
}
}
