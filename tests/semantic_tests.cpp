#include <desktop_pilot/semantic.hpp>
#include <fstream>
#include <chrono>
#include <iostream>
#include <map>
#include <stdexcept>
#include <algorithm>
#include <vector>
using dp::Json;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
int main(int argc, char** argv) {
    try {
        require(argc == 2, "profile path required");
        std::ifstream file(argv[1]); auto profile = Json::parse(file);
        Json request = {{"action", "drawing.drawCircle"}, {"windowRef", "window"},
            {"args", {{"center", {320,240}}, {"radius", 80}, {"fill", {255,0,0}},
                {"stroke", {{"color", {32,32,32}}, {"width", 3}}}}}};
        int calls = 0;
        auto locked = [&](const std::string& op, const Json&) {
            ++calls; require(op == "system.session", "locked session performed an action");
            return Json{{"lockState", "locked"}, {"inputDesktopAccessible", false}};
        };
        auto result = dp::run_semantic(request, profile, locked, [](int) {});
        require(result["status"] == "error" && result["phase"] == "preflight" &&
            result["drawAttempted"] == false && calls == 1, "locked preflight failed");
        for (const auto& invalid : {Json(-1), Json(0), Json(1.2), Json(9000)}) {
            auto bad = request; bad["args"]["radius"] = invalid;
            calls = 0; bool rejected = false;
            try { dp::run_semantic(bad, profile, locked, [](int) {}); } catch (const std::invalid_argument&) { rejected = true; }
            require(rejected && calls == 0, "invalid radius had side effects");
        }
        for (const auto& invalid : {Json(2), Json(4), Json(9)}) {
            auto bad = request; bad["args"]["stroke"]["width"] = invalid;
            calls = 0; bool rejected = false;
            try { dp::run_semantic(bad, profile, locked, [](int) {}); } catch (const std::invalid_argument&) { rejected = true; }
            require(rejected && calls == 0, "unsupported width had side effects");
        }
        auto bad = request; bad["args"]["fill"] = {256,0,0}; calls = 0;
        bool rejected = false;
        try { dp::run_semantic(bad, profile, locked, [](int) {}); } catch (const std::invalid_argument&) { rejected = true; }
        require(rejected && calls == 0, "invalid color had side effects");
        Json drag;
        std::map<std::string, std::string> values;
        std::string active = "window", slot;
        Json selectedColors = Json::object();
        int draws = 0;
        std::string lastRef, selectedTool;
        double scale = 1; int windowDpi=96; bool brushPopup=false;
        auto mock = [&](const std::string& op, const Json& args) -> Json {
            if (op == "system.session") return {{"lockState", "unlocked"}, {"inputDesktopAccessible", true}, {"lastInputTick", 42}};
            if (op == "window.get") return {{"pid", 1}, {"dpi", windowDpi}, {"foreground", true},
                {"bounds", {{"x", 100}, {"y", 50}, {"width", 1505}, {"height", 1080}}}};
            if (op == "ui.tree") {
                Json elements = Json::array();
                auto add = [&](Json selector) {
                    if (selector.contains("nameContains")) { selector["name"] = selector["nameContains"]; selector.erase("nameContains"); }
                    selector["elementRef"] = selector.value("automationId", selector.value("name", std::string{}));
                    elements.push_back(selector);
                };
                if (args.at("windowRef") == "window") {for (const auto& selector : profile.at("selectors")) add(selector);add(profile.at("textEditor"));add(profile.at("homeTab"));}
                else if (args.at("windowRef") == "dialog") { for (const auto& selector : profile.at("rgbFields")) add(selector); add(profile.at("colorConfirm")); }
                else { add(profile.at("noFill")); add(profile.at("solidFill")); for (const auto& selector : profile.at("widthOptions")) add(selector); }
                return {{"elements", elements}, {"truncated", false}};
            }
            if (op == "ui.find") {
                const auto& selector=args.at("selector");
                auto ref=selector.value("name",std::string("画布"));
                return {{"elements",Json::array({Json{{"elementRef",ref}}})}};
            }
            if (op == "ui.get") {
                const auto ref = args.at("elementRef").get<std::string>();
                lastRef = ref;
                if (ref == "画布") return {{"bounds", {{"x", 127}, {"y", 235}, {"width", 1100}, {"height", 860}}}};
                if (values.contains(ref)) return {{"value", values.at(ref)}};
                return {{"bounds", {{"x", 100}, {"y", 50}, {"width", int(20*scale)}, {"height", int(20*scale)}}}};
            }
            if (op == "ui.invoke" || op == "input.click") {
                const auto ref = op == "input.click" ? lastRef : args.at("elementRef").get<std::string>();
                if (ref == "椭圆形" || ref == "矩形" || ref == "圆角矩形" || ref == "直线") selectedTool = ref;
                if (ref == "刷子") {brushPopup=!brushPopup;active=brushPopup?"menu":"window";}
                if (ref == "颜色 1" || ref == "颜色 2") slot = ref;
                if (ref == "编辑颜色") active = "dialog";
                if (ref == "填充" || ref == "轮廓" || ref == "粗细") active = "menu";
                if (ref == "1") selectedColors[slot] = {values["706"], values["707"], values["708"]};
            } else if (op == "window.list") return {{"windows", Json::array({{{"windowRef", active}, {"foreground", true}}})}};
            else if (op == "ui.set_value") values[args.at("elementRef").get<std::string>()] = args.at("value");
            else if (op == "input.move") { drag = args; ++draws;
                require(args.at("hold")=="left","semantic move must hold left for the whole path");
                drag["x"]=args.at("points").front()[0];drag["y"]=args.at("points").front()[1];
                drag["toX"]=args.at("points").back()[0];drag["toY"]=args.at("points").back()[1];
            }
            else require(op == "ui.select" || op == "input.key_chord" || op == "input.type_text", "unexpected native operation");
            return {{"status", "ok"}};
        };
        int settleTotal = 0;
        auto success = dp::run_semantic(request, profile, mock, [&](int ms) { settleTotal += ms; });
        require(settleTotal == 11 * profile.at("clickSettleMs").get<int>(), "unexpected fixed click waiting");
        require(success["status"] == "ok" && draws == 1, "semantic action failed to dispatch exactly one shape");
        require(!success.contains("resultVerified") && !success.contains("visualCheck"),
                "dispatch must not claim pixel verification");
        require(drag["x"] == 270 && drag["y"] == 350 && drag["toX"] == 429 && drag["toY"] == 509,
                "canvas-to-window geometry incorrect");
        require(selectedColors["颜色 1"] == Json({"32", "32", "32"}) &&
                selectedColors["颜色 2"] == Json({"255", "0", "0"}), "stroke/fill channels mixed");
        scale = 1.25; draws = 0;
        auto scaledResult = dp::run_semantic(request, profile, mock, [](int) {});
        require(scaledResult["status"] == "ok" && draws == 1 && drag["toX"].get<int>() - drag["x"].get<int>() == 199,
                "125 percent display scale did not preserve logical diameter");
        scale = 1;
        for (const auto* action : {"drawing.drawEllipse", "drawing.drawRectangle", "drawing.drawRoundedRectangle", "drawing.drawLine"}) {
            auto shape = request; shape["action"] = action;
            shape["args"] = {{"position", {100,100}}, {"size", {200,80}}, {"from", {300,180}}, {"to", {100,100}},
                {"fill", nullptr}, {"stroke", {{"color", {12,34,56}}, {"width", 5}}}};
            draws = 0; selectedColors = Json::object();
            const auto result = dp::run_semantic(shape, profile, mock, [](int) {});
            require(result["status"] == "ok" && draws == 1, "new shape did not draw once");
            const std::map<std::string,std::string> expectedTools = {{"drawing.drawEllipse","椭圆形"},{"drawing.drawRectangle","矩形"},{"drawing.drawRoundedRectangle","圆角矩形"},{"drawing.drawLine","直线"}};
            require(selectedTool == expectedTools.at(action), "wrong shape tool selected");
            require(selectedColors.size() == 1, "unfilled shape set an unnecessary fill color");
            if (shape["action"] == "drawing.drawLine")
                require(drag["x"] == 330 && drag["toX"] == 130, "line direction was lost");
            else require(drag["x"] == 130 && drag["toX"] == 329 && drag["toY"] == 369, "bounding box conversion failed");
            shape["args"]["size"] = {0,80}; shape["args"]["to"] = shape["args"]["from"];
            calls = 0; bool invalid = false;
            try { dp::run_semantic(shape, profile, locked, [](int) {}); } catch (const std::invalid_argument&) { invalid = true; }
            require(invalid && calls == 0, "degenerate shape caused desktop operations");
        }
        draws = 0;
        auto failColor = [&](const std::string& op, const Json& args) {
            if (op == "ui.set_value") return Json{{"status", "error"}, {"message", "fixture color failure"}};
            return mock(op, args);
        };
        auto failedColor = dp::run_semantic(request, profile, failColor, [](int) {});
        require(failedColor["status"] == "error" && !failedColor["drawAttempted"].get<bool>() && draws == 0,
                "color failure continued to draw");

        Json scene = {{"action", "drawing.drawScene"}, {"windowRef", "window"}, {"args", {
            {"defaults", {{"stroke", {{"color", {10,20,30}}, {"width", 3}}}, {"fill", nullptr}}},
            {"intervalMs", 7}, {"items", Json::array({
                {{"action", "drawing.drawLine"}, {"args", {{"from", {20,20}}, {"to", {80,80}}}}},
                {{"action", "drawing.drawRectangle"}, {"args", {{"position", {100,100}}, {"size", {30,40}}}}}
            })}}}};
        draws = 0; int intervals = 0;
        auto sceneResult = dp::run_semantic(scene, profile, mock, [&](int ms) { if (ms == 7) ++intervals; });
        require(sceneResult["status"] == "ok" && sceneResult["completed"] == 2 && draws == 2 && intervals == 1,
                "scene ordering/defaults/interval failed");
        auto badScene = scene; badScene["args"]["items"][1]["args"]["size"] = {0,40};
        calls = 0; rejected = false;
        try { dp::run_semantic(badScene, profile, locked, [](int) {}); } catch (const std::invalid_argument&) { rejected = true; }
        require(rejected && calls == 0, "scene failed to prevalidate later item");
        draws = 0;
        auto failSecond = [&](const std::string& op, const Json& args) -> Json {
            if (draws == 1 && op == "system.session") return {{"lockState", "locked"}, {"inputDesktopAccessible", false}};
            return mock(op,args);
        };
        auto partial = dp::run_semantic(scene, profile, failSecond, [](int) {});
        require(partial["status"] == "error" && partial["completed"] == 1 && partial["failedIndex"] == 1 && draws == 1 && partial["drawAttempted"] == true,
                "scene failure lost completed work or continued drawing");
        auto polyline = request; polyline["action"] = "drawing.drawPolyline";
        polyline["args"] = {{"points", {{20,20},{80,20},{80,80}}}, {"closed", true}, {"stroke", request["args"]["stroke"]}};
        draws = 0;
        auto polyResult = dp::run_semantic(polyline, profile, mock, [](int) {});
        require(polyResult["status"]=="ok" && draws==1 && drag["points"].size()==4 && drag["points"].front()==drag["points"].back(),"polyline is not one continuous closed stroke");
        int pathColorWrites=0,pathNativeCalls=0;
        auto pathMock=[&](const std::string& op,const Json& a) {
            if(op=="ui.set_value")++pathColorWrites;
            if(op=="input.move")++pathNativeCalls;
            return mock(op,a);
        };
        auto pathScene=Json{{"action","drawing.drawScene"},{"windowRef","window"},{"args",{{"items",Json::array({
            Json{{"action","drawing.drawPolyline"},{"args",polyline["args"]}},
            Json{{"action","drawing.drawPolyline"},{"args",polyline["args"]}}
        })}}}};
        auto pathBatch=dp::run_semantic(pathScene,profile,pathMock,[](int){});
        require(pathBatch["completed"]==2 && pathNativeCalls==2 && pathColorWrites==3,"continuous paths did not reuse style or were split into segments");
        windowDpi=120;scale=1.25;draws=0;
        const auto dpi120=dp::run_semantic(request,profile,mock,[](int){});
        require(dpi120["status"]=="ok" && dpi120["canvasScale"]==1.0 && draws==1,
                "120 DPI-aware Paint must keep a physical-pixel canvas");
        require(drag["x"]==271 && drag["y"]==351 && drag["toX"]==430 && drag["toY"]==510,
                "120 DPI origin/inset rounding or diameter is incorrect");
        draws=0;
        const auto path120=dp::run_semantic(polyline,profile,mock,[](int){});
        require(path120["status"]=="ok" && draws==1 && drag["points"]==Json({{51,211},{111,211},{111,271},{51,211}}),
                "120 DPI continuous path was scaled with the toolbar");
        windowDpi=144;scale=1.5;draws=0;
        const auto highDpi=dp::run_semantic(request,profile,mock,[](int){});
        require(highDpi["status"]=="ok" && highDpi["canvasScale"]==1.0 && drag["toX"].get<int>()-drag["x"].get<int>()==159,"DPI-aware Paint canvas incorrectly scaled with ribbon");
        windowDpi=96;scale=1;
        auto nested = scene;
        nested["args"]["items"][0]["action"] = "drawing.drawScene";
        calls = 0; rejected = false;
        try { dp::run_semantic(nested, profile, locked, [](int) {}); } catch (const std::invalid_argument&) { rejected = true; }
        require(rejected && calls == 0, "nested scene was not rejected before execution");
        draws = 0;
        auto uncertainDrag = [&](const std::string& op, const Json& args) -> Json {
            if (op == "input.move") { ++draws; return {{"status", "error"}, {"message", "dispatch interrupted"}}; }
            return mock(op,args);
        };
        auto interrupted = dp::run_semantic(scene, profile, uncertainDrag, [](int) {});
        require(interrupted["completed"] == 0 && interrupted["failedIndex"] == 0 && interrupted["drawAttempted"] == true && draws == 1,
                "uncertain draw was retried or reported as untouched");
        auto polygon = request; polygon["action"] = "drawing.drawPolygon";
        polygon["args"] = {{"points", {{100,100},{180,110},{170,180},{110,170}}},
            {"fill", {40,50,60}}, {"stroke", request["args"]["stroke"]}};
        Json vertices = Json::array(); draws = 0;
        auto polygonMock = [&](const std::string& op, const Json& args) {
            if (op == "input.click" && args.contains("count")) vertices.push_back(args);
            return mock(op,args);
        };
        auto polygonResult = dp::run_semantic(polygon, profile, polygonMock, [](int) {});
        require(polygonResult["status"] == "ok" && draws == 1 && vertices.size() == 2 &&
            vertices.back()["count"] == 2 && vertices.back()["x"] == 140,
            "polygon did not close through final double click");
        polygon["args"]["points"] = {{20,20},{40,40},{60,60}};
        calls = 0; rejected = false;
        try { dp::run_semantic(polygon, profile, locked, [](int) {}); } catch (const std::invalid_argument&) { rejected = true; }
        require(rejected && calls == 0, "degenerate polygon dispatched input");

        auto bare = request; bare["args"].erase("fill"); bare["args"].erase("stroke");
        int rgbWrites = 0, menuClicks = 0, toolClicks = 0;
        auto observed = [&](const std::string& op, const Json& args) {
            if (op == "ui.set_value") ++rgbWrites;
            if (op == "input.click" && (lastRef == "填充" || lastRef == "轮廓" || lastRef == "粗细")) ++menuClicks;
            if (op == "input.click" && lastRef == "椭圆形") ++toolClicks;
            return mock(op,args);
        };
        auto inherited = dp::run_semantic(bare, profile, observed, [](int) {});
        require(inherited["status"] == "ok" && rgbWrites == 0 && menuClicks == 0, "omitted style was applied");
        for (const auto& partialStroke : {Json{{"width",5}}, Json{{"color",{20,40,60}}}}) {
            auto partialStyle = bare; partialStyle["args"]["stroke"] = partialStroke;
            rgbWrites = menuClicks = 0;
            auto result = dp::run_semantic(partialStyle, profile, observed, [](int) {});
            require(result["status"] == "ok" && rgbWrites == (partialStroke.contains("color") ? 3 : 0), "partial stroke updated unwanted color");
        }
        auto emptyFill = bare; emptyFill["args"]["fill"] = nullptr;
        rgbWrites = menuClicks = 0;
        auto unfilled = dp::run_semantic(emptyFill, profile, observed, [](int) {});
        require(unfilled["status"] == "ok" && rgbWrites == 0 && menuClicks == 1, "null fill did not explicitly disable fill");
        // Regression (Bug A): the width menu must be opened before the outline menu, because the
        // outline flyout overlaps the width button and would occlude a later width click.
        {
            std::vector<std::string> menuOrder;
            auto orderMock = [&](const std::string& op, const Json& args) {
                auto r = mock(op, args);
                if (op == "input.click" && (lastRef == "\xE7\xB2\x97\xE7\xBB\x86" || lastRef == "\xE8\xBD\xAE\xE5\xBB\x93"))
                    menuOrder.push_back(lastRef);
                return r;
            };
            draws = 0;
            auto ordered = dp::run_semantic(request, profile, orderMock, [](int) {});
            require(ordered["status"] == "ok" && draws == 1, "stroke shape with width and outline failed to draw");
            require(menuOrder.size() == 2 && menuOrder[0] == "\xE7\xB2\x97\xE7\xBB\x86" && menuOrder[1] == "\xE8\xBD\xAE\xE5\xBB\x93",
                "Bug A: width menu must be configured before the outline menu");
        }
        auto stars = scene; stars["args"] = {{"items",Json::array()}};
        for (int i=0; i<3; ++i) stars["args"]["items"].push_back({{"action",request["action"]},{"args",request["args"]}});
        auto cachedProfile = profile;
        rgbWrites = menuClicks = toolClicks = draws = 0;
        auto cached = dp::run_semantic(stars, cachedProfile, observed, [](int) {});
        require(cached["status"] == "ok" && draws == 3 && rgbWrites == 6 && menuClicks == 3 && toolClicks == 3,
                "scene repeated identical style or tool setup");
        stars["args"]["reuseState"] = false; rgbWrites = 0;
        auto uncached = dp::run_semantic(stars, cachedProfile, observed, [](int) {});
        require(uncached["status"] == "ok" && rgbWrites == 18, "reuseState:false still reused cached colors");
        stars["args"].erase("reuseState");
        // A changed last-input tick at the start of the second shape invalidates reuse.
        int sessionReads = 0; rgbWrites = 0;
        auto interfered = [&](const std::string& op, const Json& args) {
            auto result = observed(op,args);
            if (op == "system.session") { ++sessionReads; result["lastInputTick"] = sessionReads >= 3 ? 43 : 42; }
            return result;
        };
        auto invalidated = dp::run_semantic(stars, cachedProfile, interfered, [](int) {});
        require(invalidated["status"] == "ok" && rgbWrites == 12, "intervening input did not invalidate style");
        rgbWrites = 0;
        dp::run_semantic(stars, cachedProfile, observed, [](int) {});
        require(rgbWrites == 6, "style cache escaped its scene");
        int mainTrees=0;
        auto counted=[&](const std::string& op,const Json& a) {
            if(op=="ui.tree" && a.at("windowRef")=="window") ++mainTrees;
            return mock(op,a);
        };
        auto located=dp::run_semantic(stars,profile,counted,[](int){});
        require(located["status"]=="ok" && mainTrees==1,"scene did not reuse main control tree");
        auto evidenceMock=[&](const std::string& op,const Json& a)->Json {
            auto r=counted(op,a);
            if(op=="window.get") {
                r["windowRef"]="window";r["className"]="MSPaintApp";r["executable"]="mspaint.exe";
                r["enabled"]=true;r["minimized"]=false;
            }
            return r;
        };
        dp::SemanticEvidence evidence;
        evidence.windowRef="window";
        evidence.window=evidenceMock("window.get",{{"windowRef","window"}});
        evidence.session=evidenceMock("system.session",Json::object());
        evidence.tree=evidenceMock("ui.tree",{{"windowRef","window"}});
        mainTrees=0;
        auto reused=dp::run_semantic(stars,profile,evidenceMock,[](int){},&evidence);
        require(reused["status"]=="ok"&&mainTrees==0,"execution discovery tree was scanned again");
        const int beforeStale=draws;
        for(auto field:{"windowRef","pid","dpi","bounds","className","executable","enabled","minimized","foreground"}) {
            auto stale=evidence;stale.window[field]=nullptr;
            auto refused=dp::run_semantic(bare,profile,evidenceMock,[](int){},&stale);
            require(refused["status"]=="error"&&refused["message"]=="profile_evidence_stale"&&draws==beforeStale,"stale discovery fingerprint dispatched input");
        }
        auto stale=evidence;stale.session["lastInputTick"]=41;
        auto refused=dp::run_semantic(bare,profile,evidenceMock,[](int){},&stale);
        require(refused["message"]=="profile_evidence_stale"&&draws==beforeStale,"external input did not invalidate discovery");
        stale=evidence;stale.tree["has_more"]=true;
        refused=dp::run_semantic(bare,profile,evidenceMock,[](int){},&stale);
        require(refused["message"]=="profile_evidence_stale"&&draws==beforeStale,"incomplete typed evidence was trusted");
        auto paged=[&](const std::string& op,const Json& a)->Json {
            auto r=evidenceMock(op,a);if(op=="ui.tree")r["has_more"]=true;return r;
        };
        refused=dp::run_semantic(bare,profile,paged,[](int){});
        require(refused["message"]=="ui_inspection_incomplete"&&draws==beforeStale,"drawing uniqueness accepted paginated controls");
        for(bool omitElements:{false,true}) {
            auto incomplete=[&](const std::string& op,const Json& a)->Json {
                auto r=evidenceMock(op,a);
                if(op=="ui.tree") {r["evidenceComplete"]=false;if(omitElements)r.erase("elements");}
                return r;
            };
            refused=dp::run_semantic(bare,profile,incomplete,[](int){});
            require(refused["code"]=="ui_inspection_incomplete"&&draws==beforeStale,"missing or partial query evidence lost its diagnostic");
        }
        auto textRequest=bare;
        textRequest["action"]="drawing.drawText";
        textRequest["args"]={{"position",{100,100}},{"size",{300,100}},{"text","hello"}};
        int typed=0;
        auto textMock=[&](const std::string& op,const Json& a) {
            if(op=="ui.find") return Json{{"elements",Json::array({{{"elementRef","铅笔"}}})}};
            if(op=="ui.fill") {++typed;require(a.at("text")=="hello","wrong text");return Json{{"status","ok"},{"verification","passed"}};}
            return mock(op,a);
        };
        auto textResult=dp::run_semantic(textRequest,profile,textMock,[](int){});
        require(textResult["status"]=="ok" && typed==1,"text not dispatched exactly once");
        auto failing=bare;failing["failureScreenshot"]="failure.png";
        int captures=0;
        auto failedDraw=[&](const std::string& op,const Json& a)->Json {
            if(op=="input.move") throw std::runtime_error("injected failure");
            if(op=="capture.region") {++captures;require(a.at("width").get<int>()<500,"failure screenshot not local");return {{"path","failure.png"},{"imageRef","img"}};}
            return mock(op,a);
        };
        auto failure=dp::run_semantic(failing,profile,failedDraw,[](int){});
        require(failure["status"]=="error" && failure["drawAttempted"]==true && captures==1 && failure.contains("capture"),"failure capture lost");
        auto captureFails=[&](const std::string& op,const Json& a)->Json {
            if(op=="capture.region") throw std::runtime_error("capture failed");
            return failedDraw(op,a);
        };
        failure=dp::run_semantic(failing,profile,captureFails,[](int){});
        require(failure["message"]=="injected failure" && failure.contains("captureError"),"capture masked original error");
        auto invalidBrush=Json{{"action","drawing.selectBrush"},{"windowRef","window"},{"args",{{"brush","invalid"}}}};
        calls=0;rejected=false;
        try { dp::run_semantic(invalidBrush,profile,locked,[](int){}); } catch(const std::invalid_argument&) {rejected=true;}
        require(rejected && calls==0,"invalid brush touched desktop");
        bool popupOpen=false, brushChosen=false;
        std::string fileValue;
        auto savePath=std::filesystem::temp_directory_path()/("dp-semantic-save-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".png");
        bool saving=false;
        auto appMock=[&](const std::string& op,const Json& a)->Json {
            if(op=="system.session") return {{"inputDesktopAccessible",true},{"lockState","unlocked"}};
            if(op=="window.get") return {{"pid",1},{"foreground",true},{"bounds",{{"x",0},{"y",0}}}};
            if(op=="input.key_chord") {require(a.at("keys")[0]=="F12","save shortcut mismatch");popupOpen=true;}
            else if(op=="window.list") return {{"windows",popupOpen?Json::array({{{"windowRef","popup"},{"foreground",true}}}):Json::array()}};
            else if(op=="ui.find") {
                if(a.at("selector").value("role",std::string{})=="Pane") return {{"elements",brushChosen?Json::array({{{"elementRef","canvas"}}}):Json::array()}};
                return {{"elements",Json::array({{{"elementRef","control"}}})}};
            } else if(op=="ui.get") return {{"bounds",{{"x",1},{"y",1},{"width",20},{"height",20}}},{"value",fileValue}};
            else if(op=="ui.set_value") fileValue=a.at("value");
            else if(op=="input.click") {
                if(saving) {dp::save_png(dp::make_fixture(),savePath);popupOpen=false;}
                else if(!popupOpen) popupOpen=true;
                else {popupOpen=false;brushChosen=true;}
            } else throw std::runtime_error("unexpected app operation: "+op);
            return {{"status","ok"}};
        };
        auto brush=invalidBrush;brush["args"]["brush"]="watercolor";
        auto staleAppEvidence=evidence;staleAppEvidence.session["lastInputTick"]=41;
        auto appRefused=dp::run_semantic(brush,profile,evidenceMock,[](int){},&staleAppEvidence);
        require(appRefused["code"]=="profile_evidence_stale"&&appRefused["dispatch"]=="not_started","first app action trusted stale discovery");
        auto brushResult=dp::run_semantic(brush,profile,appMock,[](int){});
        require(brushResult["status"]=="ok" && brushChosen,"brush was not verified");
        // Regression (Bug C): a stale-open brush gallery makes the first 刷子 click close it
        // (no popup), so selectBrush must re-open the gallery once before timing out.
        {
            bool cPopup=false, cChosen=false; int cBtnClicks=0;
            auto retryMock=[&](const std::string& op,const Json& a)->Json {
                if(op=="system.session") return {{"inputDesktopAccessible",true},{"lockState","unlocked"}};
                if(op=="window.get") return {{"pid",1},{"foreground",true},{"bounds",{{"x",0},{"y",0}}}};
                if(op=="window.list") return {{"windows", cPopup?Json::array({{{"windowRef","popup"},{"foreground",true}}}):Json::array()}};
                if(op=="ui.find") {
                    if(a.at("selector").value("role",std::string{})=="Pane") return {{"elements",cChosen?Json::array({{{"elementRef","canvas"}}}):Json::array()}};
                    return {{"elements",Json::array({{{"elementRef","control"}}})}};
                }
                if(op=="ui.get") return {{"bounds",{{"x",1},{"y",1},{"width",20},{"height",20}}}};
                if(op=="input.click") {
                    if(!cPopup && !cChosen) { if(++cBtnClicks>=2) cPopup=true; }
                    else if(cPopup) { cPopup=false; cChosen=true; }
                    return {{"status","ok"}};
                }
                return {{"status","ok"}};
            };
            auto retried=dp::run_semantic(brush,profile,retryMock,[](int){});
            require(retried["status"]=="ok" && cChosen && cBtnClicks>=2,
                "Bug C: selectBrush did not re-open the gallery after a stale first click");
        }
        saving=true;
        auto saveRequest=Json{{"action","document.saveAs"},{"windowRef","window"},
            {"args",{{"path",dp::utf8(savePath.wstring())}}}};
        auto saveResult=dp::run_semantic(saveRequest,profile,appMock,[](int){});
        require(saveResult["status"]=="ok" && saveResult["verification"]=="png_decoded","saved PNG not verified");
        // Regression (Bug D): forward-slash paths must be normalized to backslashes before typing,
        // because the Windows save dialog rejects '/'. The typed filename must contain no '/'.
        std::filesystem::remove(savePath);
        {
            std::string fwdPath = dp::utf8(savePath.wstring());
            std::replace(fwdPath.begin(), fwdPath.end(), '\\', '/');
            fileValue.clear();
            auto fwd = Json{{"action","document.saveAs"},{"windowRef","window"},{"args",{{"path",fwdPath}}}};
            auto fwdResult = dp::run_semantic(fwd, profile, appMock, [](int){});
            require(fwdResult["status"]=="ok", "forward-slash save failed");
            require(!fileValue.empty() && fileValue.find('/')==std::string::npos,
                "Bug D: forward-slash path not normalized before typing into the save dialog");
        }
        rejected=false;calls=0;
        try {dp::run_semantic(saveRequest,profile,locked,[](int){});} catch(const std::invalid_argument&) {rejected=true;}
        require(rejected && calls==0,"existing save target touched desktop");
        // Mixed batches prevalidate app actions before any earlier drawing input.
        auto mixed=Json{{"action","drawing.drawScene"},{"windowRef","window"},{"args",{{"items",Json::array({
            Json{{"action","drawing.drawCircle"},{"args",request["args"]}},
            Json{{"action","drawing.selectBrush"},{"args",{{"brush","not-a-brush"}}}}
        })}}}};
        rejected=false;calls=0;
        try {dp::run_semantic(mixed,profile,locked,[](int){});}catch(const std::exception&){rejected=true;}
        require(rejected&&calls==0,"mixed batch did not prevalidate later app action");
        // A polyline inside a semantic batch must validate every segment first.
        mixed["args"]["items"][1]={{"action","drawing.drawPolyline"},{"args",{{"points",{{1,1},{1,1}}}}}};
        rejected=false;calls=0;
        try {dp::run_semantic(mixed,profile,locked,[](int){});}catch(const std::exception&){rejected=true;}
        require(rejected&&calls==0,"nested polyline did not prevalidate segments");
        std::filesystem::remove(savePath);
        saving=false;brushChosen=false;
        auto appBatch=Json{{"action","drawing.drawScene"},{"windowRef","window"},{"args",{{"items",Json::array({
            Json{{"action","drawing.selectBrush"},{"args",brush["args"]}},
            Json{{"action","document.saveAs"},{"args",saveRequest["args"]}}
        })}}}};
        auto appBatchMock=[&](const std::string& op,const Json& a)->Json {
            if(op=="input.key_chord")saving=true;
            return appMock(op,a);
        };
        auto appBatchResult=dp::run_semantic(appBatch,profile,appBatchMock,[](int){});
        require(appBatchResult["status"]=="ok" && appBatchResult["completed"]==2 && brushChosen && std::filesystem::exists(savePath),"mixed brush/save batch failed");
        std::filesystem::remove(savePath);
        std::cout << "Semantic profile validation and locked-session short circuit: PASS\n";
    } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
