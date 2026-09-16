#include <desktop_pilot/semantic.hpp>
#include <desktop_pilot/profiles.hpp>
#include <desktop_pilot/service.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <map>
#include <set>

namespace dp {
Json run_modern_paint(const Json&, const Json&, const SemanticCall&, const std::function<void(int)>&);
namespace {
int integer(const Json& v, int minimum, int maximum) {
    if (!v.is_number_integer()) throw std::invalid_argument("Expected integer parameter");
    const auto n = v.get<int64_t>();
    if (n < minimum || n > maximum) throw std::invalid_argument("Parameter outside supported range");
    return int(n);
}
void color(const Json& value) {
    if (!value.is_array() || value.size() != 3) throw std::invalid_argument("RGB requires three channels");
    for (const auto& channel : value) integer(channel, 0, 255);
}
bool shallow_match_evidence(const Json& tree) {
    return tree.is_object() && !operation_failed(tree) && tree.contains("elements") && tree.at("elements").is_array() &&
        tree.value("stopReason", std::string{}) == "depthLimit";
}
std::string logical_key(const Json& e) {
    std::string key = e.value("role", std::string{}) + "\n" + e.value("name", std::string{});
    if (e.contains("automationId") && e.at("automationId").is_string()) key += "\n" + e.at("automationId").get<std::string>();
    if (e.contains("bounds") && e.at("bounds").is_object()) {
        const auto& b = e.at("bounds");
        key += "\n" + std::to_string(b.value("x", 0)) + "," + std::to_string(b.value("y", 0)) + "," +
            std::to_string(b.value("width", 0)) + "," + std::to_string(b.value("height", 0));
    }
    return key;
}
Json paint_polygon_vertices(const Json& input) {
    // Remove redundant samples with <= 1 canvas-pixel error. Paint can discard
    // an entire polygon when its first edge is tiny; start at the longest edge.
    std::function<void(size_t,size_t,const Json&,Json&)> simplify;
    simplify=[&](size_t first,size_t last,const Json& v,Json& out) {
        if(last<=first+1){out.push_back(v[first]);return;}
        double ax=v[first][0],ay=v[first][1],dx=v[last][0].get<double>()-ax,dy=v[last][1].get<double>()-ay;
        double maximum=0;size_t split=first;
        for(size_t i=first+1;i<last;++i) {
            double px=v[i][0].get<double>()-ax,py=v[i][1].get<double>()-ay;
            double t=dx*dx+dy*dy?std::clamp((px*dx+py*dy)/(dx*dx+dy*dy),0.0,1.0):0;
            double distance=std::hypot(px-t*dx,py-t*dy);
            if(distance>maximum){maximum=distance;split=i;}
        }
        if(maximum>1.0){simplify(first,split,v,out);simplify(split,last,v,out);}else out.push_back(v[first]);
    };
    Json closed=input;closed.push_back(input[0]);Json reduced=Json::array();
    simplify(0,closed.size()-1,closed,reduced);
    if(reduced.size()<3)reduced=input;
    size_t start=0;double longest=-1;
    for(size_t i=0;i<reduced.size();++i){auto& a=reduced[i];auto& b=reduced[(i+1)%reduced.size()];double d=std::hypot(a[0].get<double>()-b[0].get<double>(),a[1].get<double>()-b[1].get<double>());if(d>longest){longest=d;start=i;}}
    Json result=Json::array();for(size_t i=0;i<reduced.size();++i)result.push_back(reduced[(i+start)%reduced.size()]);return result;
}
}
struct DrawingState {
    Json values = Json::object();
    Json bounds;
    Json mainTree;
    Json inputTick;
    std::string windowRef;
    std::string shapeTool;
    std::string activeTool;
    bool valid = false;
};
bool semantic_evidence_current(const SemanticEvidence& evidence, const std::string& windowRef, const Json& window, const Json& session) {
    bool current = evidence.windowRef == windowRef && ui_inspection_complete(evidence.tree) &&
        !operation_failed(evidence.session) && evidence.session.value("inputDesktopAccessible",false) &&
        evidence.session.value("lockState",std::string{}) != "locked" &&
        evidence.session.contains("lastInputTick") && session.contains("lastInputTick") &&
        evidence.session.at("lastInputTick") == session.at("lastInputTick");
    for (auto key : {"windowRef","pid","dpi","bounds","className","executable","enabled","minimized","foreground"})
        current = current && evidence.window.contains(key) && window.contains(key) &&
            evidence.window.at(key) == window.at(key);
    return current;
}
static Json run_shape(const Json& request, const Json& profile, const SemanticCall& execute,
                  const std::function<void(int)>& sleep, bool validateOnly = false, DrawingState* sharedState = nullptr,
                  const SemanticEvidence* evidence = nullptr) {
    // Validate parameters before any desktop operation.
    const auto action = request.at("action").get<std::string>();
    const std::map<std::string, std::string> tools = {
        {"drawing.drawCircle", "ellipse"}, {"drawing.drawEllipse", "ellipse"},
        {"drawing.drawRectangle", "rectangle"}, {"drawing.drawRoundedRectangle", "roundedRectangle"},
        {"drawing.drawLine", "line"}, {"drawing.drawPolyline", "brushMenu"}, {"drawing.drawPolygon", "polygon"}, {"drawing.drawText", "text"}};
    if (profile.at("schemaVersion") != 1 || !tools.contains(action))
        throw std::invalid_argument("Unsupported semantic profile/action");
    const auto& a = request.at("args");
    auto point = [&](const char* key) {
        const auto& v = a.at(key);
        if (!v.is_array() || v.size() != 2) throw std::invalid_argument("Point requires x and y");
        return std::pair{integer(v[0], 0, 32000), integer(v[1], 0, 32000)};
    };
    const bool text = action == "drawing.drawText";
    if (text) {
        if (!a.contains("text") || !a.at("text").is_string() || a.at("text").get<std::string>().empty()) throw std::invalid_argument("Nonempty text required");
        for (auto it=a.begin(); it!=a.end(); ++it)
            if (it.key()!="position" && it.key()!="size" && it.key()!="text" && it.key()!="stroke") throw std::invalid_argument("Unsupported text argument: " + it.key());
    }
    const bool path = action == "drawing.drawPolyline";
    const bool line = action == "drawing.drawLine" || path;
    const bool polygon = action == "drawing.drawPolygon";
    Json vertices = Json::array();
    int x1, y1, x2, y2;
    if (path) {
        for(auto it=a.begin();it!=a.end();++it)
            if(it.key()!="points" && it.key()!="closed" && it.key()!="stroke")throw std::invalid_argument("Unsupported polyline argument: "+it.key());
        vertices=a.at("points");
        if(!vertices.is_array() || vertices.size()<2 || vertices.size()>4095)
            throw std::invalid_argument("Polyline requires 2..4095 points");
        x1=y1=32000;x2=y2=0;
        for(size_t i=0;i<vertices.size();++i) {
            const auto& v=vertices[i];
            if(!v.is_array()||v.size()!=2)throw std::invalid_argument("Invalid polyline point");
            const int x=integer(v[0],0,32000),y=integer(v[1],0,32000);
            if(i && v==vertices[i-1])throw std::invalid_argument("Repeated adjacent polyline point");
            x1=std::min(x1,x);y1=std::min(y1,y);x2=std::max(x2,x);y2=std::max(y2,y);
        }
        if(a.value("closed",false) && vertices.back()!=vertices.front())vertices.push_back(vertices.front());
    } else if (polygon) {
        vertices = a.at("points");
        if (!vertices.is_array() || vertices.size() < 3 || vertices.size() > 128)
            throw std::invalid_argument("Polygon requires 3 to 128 vertices");
        x1 = y1 = 32000; x2 = y2 = 0;
        int64_t area = 0;
        for (size_t i = 0; i < vertices.size(); ++i) {
            const auto& v = vertices[i];
            if (!v.is_array() || v.size() != 2) throw std::invalid_argument("Invalid polygon vertex");
            const int x = integer(v[0],0,32000), y = integer(v[1],0,32000);
            x1 = std::min(x1,x); y1 = std::min(y1,y); x2 = std::max(x2,x); y2 = std::max(y2,y);
            if (i && v == vertices[i-1]) throw std::invalid_argument("Repeated adjacent polygon vertex");
        }
        if (vertices.front() == vertices.back()) throw std::invalid_argument("Polygon closes automatically");
        for (size_t i=0; i<vertices.size(); ++i) {
            const auto& u=vertices[i]; const auto& v=vertices[(i+1)%vertices.size()];
            area += u[0].get<int64_t>()*v[1].get<int64_t>() - v[0].get<int64_t>()*u[1].get<int64_t>();
        }
        if (!area) throw std::invalid_argument("Degenerate polygon");
        vertices=paint_polygon_vertices(vertices);
    } else if (action == "drawing.drawCircle") {
        const auto [cx, cy] = point("center");
        const int radius = integer(a.at("radius"), 2, 8000);
        x1 = cx-radius; y1 = cy-radius; x2 = cx+radius-1; y2 = cy+radius-1;
    } else if (line) {
        const auto from = point("from"), to = point("to");
        x1 = from.first; y1 = from.second; x2 = to.first; y2 = to.second;
        if (from == to) throw std::invalid_argument("Line endpoints must differ");
    } else {
        const auto origin = point("position"), size = point("size");
        if (size.first < 2 || size.second < 2) throw std::invalid_argument("Shape size must be at least two pixels");
        x1 = origin.first; y1 = origin.second; x2 = x1+size.first-1; y2 = y1+size.second-1;
    }
    if (std::min(x1,x2) < 0 || std::min(y1,y2) < 0 || std::max(x1,x2) > 32000 || std::max(y1,y2) > 32000)
        throw std::invalid_argument("Shape extends outside coordinate range");
    const Json stroke = a.value("stroke", Json::object());
    if (!stroke.is_object()) throw std::invalid_argument("stroke must be an object");
    for (auto it=stroke.begin(); it!=stroke.end(); ++it)
        if (it.key() != "color" && it.key() != "width") throw std::invalid_argument("Unsupported stroke field");
    const bool hasWidth = stroke.contains("width"), hasColor = stroke.contains("color");
    if (text && hasWidth) throw std::invalid_argument("Text stroke.width is not supported");
    const int width = hasWidth ? integer(stroke.at("width"), 1, 8) : 0;
    const bool hasFill = !line && !text && a.contains("fill");
    const bool filled = hasFill && !a.at("fill").is_null();
    if (filled) color(a.at("fill"));
    if (hasColor) color(stroke.at("color"));
    if (hasWidth && !profile.at("widthOptions").contains(std::to_string(width)))
        throw std::invalid_argument("Unsupported stroke width for profile");
    const int settleMs = profile.contains("clickSettleMs") ? integer(profile.at("clickSettleMs"), 0, 1000) : 100;
    const int pollMs = profile.contains("popupPollMs") ? integer(profile.at("popupPollMs"), 1, 1000) : 100;
    const auto windowRef = request.at("windowRef").get<std::string>();
    if (validateOnly) return {{"status", "validated"}};
    DrawingState localState;
    auto& state = sharedState ? *sharedState : localState;
    std::string phase = "preflight";
    bool drawn = false;
    size_t calls = 0;
    Json failureRegion;
    Json failureHost = windowRef;
    bool desktopReady = false;

    const auto start = std::chrono::steady_clock::now();
    auto call = [&](const std::string& op, const Json& args) {
        ++calls;
        auto result = execute(op, args);
        if (operation_failed(result)) throw std::runtime_error(op + ": " + result.value("message", std::string("operation failed")));
        return result;
    };
    try {
        const auto session = call("system.session", Json::object());
        if (session.value("lockState", std::string{}) == "locked" || !session.value("inputDesktopAccessible", false))
            throw std::runtime_error("interactive_desktop_unavailable");
        desktopReady = true;
        const auto window = call("window.get", {{"windowRef", windowRef}});
        if (evidence) {
            // Never continue from a stale compatibility decision. A fresh execution
            // must discover again; no setup input has happened at this point.
            if (!semantic_evidence_current(*evidence,windowRef,window,session)) throw std::runtime_error("profile_evidence_stale");
        }
        if (!profile_supports_dpi(profile, window.at("dpi").get<int>()) ||
            window.at("bounds").at("width").get<int>() < profile.at("minimumWindowWidth").get<int>())
            throw std::runtime_error("profile_geometry_mismatch");
        if (!state.valid || state.windowRef != windowRef || state.bounds != window.at("bounds") ||
            !window.value("foreground", false) || !session.contains("lastInputTick") ||
            session.at("lastInputTick") != state.inputTick) state = DrawingState{};
        const auto shapeTool = tools.at(action);
        // Paint versions may store style per tool. Reapply explicit style on tool changes.
        if (state.shapeTool != shapeTool) { state.values = Json::object(); state.shapeTool = shapeTool; }
        auto needs = [&](const std::string& key, const Json& value) {
            return !state.values.contains(key) || state.values.at(key) != value;
        };
        const bool setFill = hasFill && needs("fillMode", filled);
        const bool setWidth = !text && hasWidth && needs("width", width);
        const bool setOutline = !text && !path && (hasColor || hasWidth) && needs("outline", "solid");
        const bool setPrimary = hasColor && needs("primary", stroke.at("color"));
        const bool setSecondary = filled && needs("secondary", a.at("fill"));
        const auto pid = window.at("pid");
        std::map<std::string, Json> trees;
        if (sharedState && !state.mainTree.is_null()) trees[windowRef] = state.mainTree;
        if (evidence) trees[windowRef] = evidence->tree;
        auto find = [&](const Json& host, const Json& selector) {
            const auto key = host.get<std::string>();
            if (!trees.contains(key)) trees[key] = call("ui.tree", {{"windowRef", host},
                {"depth", 16}, {"limit", 400}, {"format", "locator"}, {"queryTimeoutMs", 10000}});
            const auto& tree = trees.at(key);
            if (!ui_inspection_complete(tree) && !shallow_match_evidence(tree)) throw std::runtime_error("ui_inspection_incomplete");
            size_t rawCount = 0;
            std::map<std::string, Json> refs;
            for (const auto& e : tree.at("elements")) {
                bool match = true;
                for (auto it = selector.begin(); it != selector.end(); ++it) {
                    if (it.key() == "nameContains") match &= e.value("name", std::string{}).find(it.value().get<std::string>()) != std::string::npos;
                    else match &= e.contains(it.key()) && e.at(it.key()) == it.value();
                }
                if (match) { ++rawCount; refs[logical_key(e)] = e.at("elementRef"); }
            }
            if (shallow_match_evidence(tree) ? refs.empty() : rawCount != 1)
                throw std::runtime_error("control_not_unique: " + selector.dump());
            return refs.begin()->second;
        };
        const auto& selectors = profile.at("selectors");
        find(windowRef, selectors.at("zoom"));
        auto canvasRef = find(windowRef, selectors.at("canvas"));
        auto canvas = call("ui.get", {{"elementRef", canvasRef}, {"details", false}}).at("bounds");
        const auto calibration = call("ui.get", {{"elementRef", find(windowRef, selectors.at("ellipse"))}, {"details", false}}).at("bounds");
        const double scale = calibration.at("width").get<double>() / profile.at("referenceToolSize").get<double>();
        if (scale < 1 || scale > 2 || std::abs(calibration.at("height").get<double>() / profile.at("referenceToolSize").get<double>() - scale) > 0.01)
            throw std::runtime_error("profile_scale_mismatch");
        // DPI-aware Paint enlarges its ribbon but keeps the 100% canvas at physical pixels.
        // DPI-unaware Paint can instead be scaled by Windows; keep that virtualization factor.
        const double canvasScale=scale*96.0/window.at("dpi").get<int>();
        auto scaled = [&](int value) { return int(std::lround(value * canvasScale)); };
        auto uiScaled = [&](int value) { return int(std::lround(value * scale)); };
        const int ox = canvas.at("x").get<int>() - window.at("bounds").at("x").get<int>() + uiScaled(profile.at("canvasInset")[0].get<int>());
        const int oy = canvas.at("y").get<int>() - window.at("bounds").at("y").get<int>() + uiScaled(profile.at("canvasInset")[1].get<int>());
        if (scaled(std::max(x1,x2)) >= canvas.at("width").get<int>() - 20 || scaled(std::max(y1,y2)) >= canvas.at("height").get<int>() - 20)
            throw std::runtime_error("shape_outside_visible_canvas");
        const int margin = 16;
        failureRegion = {{"x", canvas.at("x").get<int>() + uiScaled(profile.at("canvasInset")[0].get<int>()) + scaled(std::min(x1,x2)) - margin},
            {"y", canvas.at("y").get<int>() + uiScaled(profile.at("canvasInset")[1].get<int>()) + scaled(std::min(y1,y2)) - margin},
            {"width", scaled(std::abs(x2-x1))+2*margin+1}, {"height", scaled(std::abs(y2-y1))+2*margin+1}};
        if (sharedState) state.mainTree = trees.at(windowRef);
        // Resolve the expected app controls before changing settings.
        std::map<std::string, Json> controls;
        auto resolve = [&](const char* key) { controls[key] = find(windowRef, selectors.at(key)); };
        if (setFill) resolve("fill");
        if (setOutline) resolve("outline");
        if (setWidth) resolve("width");
        if (setPrimary) resolve("primary");
        if (setSecondary) resolve("secondary");
        if (setPrimary || setSecondary) resolve("editColors");
        resolve("commit");
        Json textCommitBounds;
        if (text) textCommitBounds = call("ui.get",{{"elementRef",controls.at("commit")},{"details",false}}).at("bounds");
        controls["tool"] = find(windowRef, selectors.at(shapeTool));
        if (!window.value("foreground", false)) call("window.activate", {{"windowRef", windowRef}});
        auto invoke = [&](const Json& ref) { call("ui.invoke", {{"elementRef", ref}}); };
        auto click = [&](const Json& host, const Json& ref) {
            if(profile.value("useControlInvoke",false)) {
                call("ui.click",{{"windowRef",host},{"elementRef",ref}});
                if(settleMs)sleep(settleMs);
                return;
            }
            auto b = call("ui.get", {{"elementRef", ref}, {"details", false}}).at("bounds");
            auto wb = call("window.get", {{"windowRef", host}}).at("bounds");
            call("input.click", {{"windowRef", host}, {"coordinateSpace", "window_relative"},
                {"x", b.at("x").get<int>() + b.at("width").get<int>() / 2 - wb.at("x").get<int>()},
                {"y", b.at("y").get<int>() + b.at("height").get<int>() / 2 - wb.at("y").get<int>()}});
            if (settleMs) sleep(settleMs);
        };
        auto popup = [&](const std::string& title) {
            for (int attempt = 0; attempt < (2000 + pollMs - 1) / pollMs; ++attempt) {
                auto list = call("window.list", {{"pid", pid}, {"titleContains", title}}).at("windows");
                Json candidates = Json::array();
                for (const auto& candidate : list)
                    if (candidate.at("windowRef") != windowRef && candidate.value("enabled", true) && candidate.value("visible",true)) candidates.push_back(candidate);
                if (candidates.size() == 1) { failureHost = candidates[0].at("windowRef"); return failureHost; }
                sleep(pollMs);
            }
            throw std::runtime_error("expected_popup_not_ready");
        };
        auto menu = [&](const std::string& key, const Json& selector) {
            phase = key;
            click(windowRef, controls.at(key));
            const auto host = popup("");
            trees.erase(host.get<std::string>());
            click(host, find(host, selector));
            // Some ribbon flyouts apply the selection but do not auto-dismiss; the lingering
            // popup then occludes the next toolbar button. A clean Paint owns only its main
            // window, so any extra visible owned window is a stray flyout: force it closed.
            auto flyoutOpen = [&] {
                for (const auto& wnd : call("window.list", {{"pid", pid}}).at("windows"))
                    if (wnd.at("windowRef") != windowRef && wnd.value("visible", true)) return true;
                return false;
            };
            for (int attempt = 0; attempt < 4 && flyoutOpen(); ++attempt) sleep(pollMs);
            for (int tries = 0; tries < 3 && flyoutOpen(); ++tries) {
                // Refocus the main window (which drops the transient flyout) and press Escape at it.
                call("window.activate", {{"windowRef", windowRef}});
                try { call("input.key_chord", {{"windowRef", windowRef}, {"keys", Json::array({"Escape"})}}); }
                catch (const std::exception&) {}
                for (int attempt = 0; attempt < 6 && flyoutOpen(); ++attempt) sleep(pollMs);
            }
            failureHost = windowRef;
        };
        phase = "tool";
        if (state.activeTool != shapeTool) {
            if(path) {
                const auto selected=run_app_semantic({{"windowRef",windowRef},{"action","drawing.selectBrush"},{"args",{{"brush","brush"}}}},profile,call,sleep);
                if(operation_failed(selected))throw std::runtime_error("brush_setup_failed: "+selected.value("message",std::string{}));
            } else click(windowRef, controls.at("tool"));
            state.activeTool = shapeTool;
        }
        if (setFill) { menu("fill", profile.at(filled ? "solidFill" : "noFill")); state.values["fillMode"] = filled; }
        // Set width before outline: the outline flyout overlaps the width button, so the
        // reverse order occludes the width click. The width flyout opens clear of the outline button.
        if (setWidth) { menu("width", profile.at("widthOptions").at(std::to_string(width))); state.values["width"] = width; }
        if (setOutline) { menu("outline", profile.at("solidOutline")); state.values["outline"] = "solid"; }
        auto setColor = [&](const std::string& slot, const Json& rgb) {
            phase = slot + "Color";
            click(windowRef, controls.at(slot));
            click(windowRef, controls.at("editColors"));
            const auto host = popup(profile.at("colorDialogTitle"));
            trees.erase(host.get<std::string>());
            Json fields = Json::array();
            for (int i = 0; i < 3; ++i) {
                auto ref = find(host, profile.at("rgbFields")[i]);
                fields.push_back(ref);
                call("ui.set_value", {{"elementRef", ref}, {"value", std::to_string(rgb[i].get<int>())}});
            }
            for (int i = 0; i < 3; ++i)
                if (call("ui.get", {{"elementRef", fields[i]}}).at("value") != std::to_string(rgb[i].get<int>()))
                    throw std::runtime_error("RGB_readback_mismatch");
            invoke(find(host, profile.at("colorConfirm")));
            failureHost = windowRef;
        };
        if (setPrimary) { setColor("primary", stroke.at("color")); state.values["primary"] = stroke.at("color"); }
        if (setSecondary) { setColor("secondary", a.at("fill")); state.values["secondary"] = a.at("fill"); }
        phase = "draw";
        const auto current = call("window.get", {{"windowRef", windowRef}});
        if (current.at("bounds") != window.at("bounds")) throw std::runtime_error("layout_changed_during_setup");
        drawn = true; // Dispatch may partially happen before an error; never silently retry.
        const int fromX = polygon ? vertices[0][0].get<int>() : x1;
        const int fromY = polygon ? vertices[0][1].get<int>() : y1;
        const int toX = polygon ? vertices[1][0].get<int>() : x2;
        const int toY = polygon ? vertices[1][1].get<int>() : y2;
        Json points=Json::array();
        if(path)for(const auto& v:vertices)points.push_back({ox+scaled(v[0].get<int>()),oy+scaled(v[1].get<int>())});
        else points=Json::array({Json::array({ox+scaled(fromX),oy+scaled(fromY)}),Json::array({ox+scaled(toX),oy+scaled(toY)})});
        call("input.move", {{"windowRef",windowRef},{"coordinateSpace","window_relative"},
            {"expectedSize",window.at("bounds")},{"points",points},{"hold","left"}});
        if (polygon) {
            for (size_t i=2; i<vertices.size(); ++i) {
                if (settleMs) sleep(settleMs);
                call("input.click", {{"windowRef",windowRef},{"coordinateSpace","window_relative"},
                    {"expectedSize",window.at("bounds")}, {"x",ox+scaled(vertices[i][0].get<int>())},
                    {"y",oy+scaled(vertices[i][1].get<int>())}, {"count",i+1==vertices.size()?2:1}});
            }
        }
        if (text) {
            phase = "text";
            trees.erase(windowRef);
            const auto editor = find(windowRef, profile.at("textEditor"));
            auto filledText = call("ui.fill", {{"windowRef",windowRef},{"elementRef",editor},{"text",a.at("text")},{"method","auto"},{"timeoutMs",5000}});
            if (filledText.value("verification",std::string{}) != "passed") throw std::runtime_error("text_readback_not_verified");
            // Committing text changes the ribbon; never reuse its old UI tree.
            state.mainTree = Json();
        }
        phase = "commit";
        if (text) {
            click(windowRef,find(windowRef,profile.at("homeTab")));
            // The classic Home ribbon restores its original layout. Use the position
            // observed before text editing, after checking the window has not moved.
            sleep(100);
            if(call("window.get",{{"windowRef",windowRef}}).at("bounds")!=window.at("bounds"))
                throw std::runtime_error("layout_changed_before_text_commit");
            call("input.click",{{"windowRef",windowRef},{"coordinateSpace","window_relative"},
                {"x",textCommitBounds.at("x").get<int>()+textCommitBounds.at("width").get<int>()/2-window.at("bounds").at("x").get<int>()},
                {"y",textCommitBounds.at("y").get<int>()+textCommitBounds.at("height").get<int>()/2-window.at("bounds").at("y").get<int>()}});
        } else if(!path) invoke(controls.at("commit"));
        if(!path) state.activeTool.clear();
        if (sharedState) {
            const auto after = call("system.session", Json::object());
            state.valid = after.contains("lastInputTick") && after.value("inputDesktopAccessible", false) &&
                after.value("lockState", std::string{}) != "locked";
            state.inputTick = after.value("lastInputTick", Json());
            state.windowRef = windowRef;
            state.bounds = window.at("bounds");
        }
        return {{"status", "ok"}, {"action", request.at("action")}, {"profile", profile.at("id")},

            {"verification", text ? "text_readback_and_commit_dispatched" : (setPrimary || setSecondary) ? "rgb_readback_and_draw_dispatched" : "draw_dispatched"}, {"nativeCalls", calls},
            {"canvasOrigin", {ox, oy}}, {"displayScale", scale}, {"canvasScale",canvasScale}, {"elapsedMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-start).count()}};
    } catch (const std::exception& error) {
        state = DrawingState{};
        Json result = {{"status", "error"}, {"phase", phase}, {"drawAttempted", drawn},
            {"nativeCalls", calls}, {"message", error.what()},
            {"dispatch",drawn?"possibly_partial":"not_started"},{"retryable",!drawn}};
        if (std::string(error.what()) == "profile_evidence_stale" || std::string(error.what()) == "ui_inspection_incomplete")
            result["code"] = error.what();

        if (desktopReady && request.contains("failureScreenshot")) {
            try {
                if ((phase == "draw" || phase == "commit") && !failureRegion.is_null()) {
                    failureRegion["output"] = request.at("failureScreenshot");
                    result["capture"] = execute("capture.region", failureRegion);
                } else result["capture"] = execute("capture.window", {{"windowRef",failureHost},
                    {"output",request.at("failureScreenshot")}, {"method","screen"},{"maxEdge",1200}});
            } catch (const std::exception& captureError) { result["captureError"] = captureError.what(); }
        }
        return result;
    }
}
Json run_semantic(const Json& request, const Json& profile, const SemanticCall& execute,
                  const std::function<void(int)>& sleep, const SemanticEvidence* evidence) {
    if (profile.value("adapter", std::string{}) == "paint-modern")
        return run_modern_paint(request, profile, execute, sleep);
    if (!profile.value("adapter", std::string{}).empty())
        throw std::invalid_argument("Unsupported semantic adapter");
    const auto action = request.at("action").get<std::string>();
    if (action == "document.saveAs" || action == "drawing.selectBrush") return run_app_semantic(request, profile, execute, sleep, false, evidence);
    if (action != "drawing.drawScene")
        return run_shape(request, profile, execute, sleep, false, nullptr, evidence);
    const auto& args = request.at("args");
    Json items = args.at("items");
    if (!items.is_array() || items.empty() || items.size() > 256)
        throw std::invalid_argument("Scene requires 1 to 256 primitive shapes");
    const int interval = args.contains("intervalMs") ? integer(args.at("intervalMs"), 0, 10000) : 0;
    const Json defaults = args.value("defaults", Json::object());
    if (!defaults.is_object()) throw std::invalid_argument("defaults must be an object");
    for (auto it = defaults.begin(); it != defaults.end(); ++it)
        if (it.key() != "stroke" && it.key() != "fill") throw std::invalid_argument("Only stroke and fill defaults are supported");
    Json requests = Json::array();
    // Validate the entire scene before the first desktop call. Never recursively expand scenes.
    for (const auto& item : items) {
        Json child = {{"windowRef", request.at("windowRef")}, {"action", item.at("action")}, {"args", defaults}};
        if (!item.at("args").is_object()) throw std::invalid_argument("Shape args must be an object");
        if (request.contains("failureScreenshot")) child["failureScreenshot"] = request.at("failureScreenshot");
        child["args"].update(item.at("args"));
        if(child["action"]=="document.saveAs" || child["action"]=="drawing.selectBrush")
            run_app_semantic(child,profile,execute,sleep,true);
        else run_shape(child, profile, execute, sleep, true);
        requests.push_back(std::move(child));
    }
    const auto start = std::chrono::steady_clock::now();
    size_t completed = 0, calls = 0;
    bool drawAttempted = false;
    DrawingState state;
    const bool reuseState = args.value("reuseState", true);
    for (const auto& child : requests) {
        if (completed && interval) sleep(interval);
        const bool app=child["action"]=="document.saveAs" || child["action"]=="drawing.selectBrush";
        if(app)state=DrawingState{};
        auto result = app ? run_app_semantic(child,profile,execute,sleep,false,completed == 0 ? evidence : nullptr) : run_shape(child, profile, execute, sleep, false, reuseState ? &state : nullptr, completed == 0 ? evidence : nullptr);
        calls += result.value("nativeCalls", size_t{0});
        drawAttempted |= result.value("drawAttempted", result.value("status", std::string{}) == "ok");
        if (operation_failed(result)) {
            return {{"status", "error"}, {"action", action}, {"completed", completed},
                {"total", requests.size()}, {"failedIndex", completed}, {"failure", result},
                {"drawAttempted", drawAttempted}, {"nativeCalls", calls}};
        }
        ++completed;

    }
    return {{"status", "ok"}, {"action", action}, {"completed", completed}, {"total", requests.size()},
        {"nativeCalls", calls}, {"verification", "scene_dispatched"},

        {"elapsedMs", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now()-start).count()}};
}

}
