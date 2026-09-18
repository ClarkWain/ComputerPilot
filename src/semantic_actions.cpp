#include <desktop_pilot/semantic.hpp>
#include <desktop_pilot/service.hpp>
#include <fstream>
#include <chrono>
#include <algorithm>

namespace dp {
Json run_app_semantic(const Json& request, const Json& profile, const SemanticCall& execute,
                      const std::function<void(int)>& sleep, bool validateOnly, const SemanticEvidence* evidence) {
    const auto action=request.at("action").get<std::string>();
    const auto& args=request.at("args");
    const auto window=request.at("windowRef");
    const bool save=action=="document.saveAs";
    if(profile.at("schemaVersion")!=1 || !args.is_object()) throw std::invalid_argument("Invalid semantic profile/args");
    for(auto it=args.begin();it!=args.end();++it)
        if(save ? (it.key()!="path" && it.key()!="format" && it.key()!="overwrite") : it.key()!="brush")
            throw std::invalid_argument("Unsupported action argument: "+it.key());
    std::filesystem::path target;
    if(save) {
        if(args.value("format",std::string("png"))!="png") throw std::invalid_argument("Only PNG is supported");
        target=std::filesystem::u8path(args.at("path").get<std::string>());
        if(!target.is_absolute() || target.extension()!=L".png") throw std::invalid_argument("Absolute .png path required");
        if(args.value("overwrite",false)) throw std::invalid_argument("Overwrite is not supported; choose a new path");
        if(std::filesystem::exists(target)) throw std::invalid_argument("Target already exists");
        if(!std::filesystem::is_directory(target.parent_path())) throw std::invalid_argument("Parent directory does not exist");
    } else if(!profile.at("brushes").contains(args.at("brush").get<std::string>()))
        throw std::invalid_argument("Unknown brush");
    if(validateOnly)return {{"status","validated"}};
    const auto started=std::chrono::steady_clock::now();
    size_t calls=0; std::string phase="preflight"; Json host=window; bool ready=false;
    auto call=[&](const std::string& op,const Json& a) {
        ++calls; auto r=execute(op,a);
        if(operation_failed(r)) throw std::runtime_error(op+": "+r.value("message",std::string("operation failed")));
        return r;
    };
    auto find=[&](const Json& h,const Json& selector) {
        auto r=call("ui.find",{{"windowRef",h},{"selector",selector},{"depth",20},{"limit",2},{"format","locator"}});
        if(!ui_inspection_complete(r)) throw std::runtime_error("ui_inspection_incomplete");
        if(r.at("elements").size()!=1) throw std::runtime_error("control_not_unique: "+selector.dump());
        return r.at("elements")[0].at("elementRef");
    };
    auto click=[&](const Json& h,const Json& ref) {
        auto b=call("ui.get",{{"elementRef",ref},{"details",false}}).at("bounds");
        auto w=call("window.get",{{"windowRef",h}}).at("bounds");
        call("input.click",{{"windowRef",h},{"coordinateSpace","window_relative"},
            {"x",b.at("x").get<int>()+b.at("width").get<int>()/2-w.at("x").get<int>()},
            {"y",b.at("y").get<int>()+b.at("height").get<int>()/2-w.at("y").get<int>()}});
    };
    try {
        auto session=call("system.session",Json::object());
        if(!session.value("inputDesktopAccessible",false) || session.value("lockState",std::string{})=="locked") throw std::runtime_error("interactive_desktop_unavailable");
        ready=true;
        auto w=call("window.get",{{"windowRef",window}});
        if(evidence && !semantic_evidence_current(*evidence,window.get<std::string>(),w,session))
            throw std::runtime_error("profile_evidence_stale");
        if(!w.value("foreground",false)) call("window.activate",{{"windowRef",window}});
        phase=save?"openSave":"openBrush";
        Json brushBtn;
        if(save) call("input.key_chord",{{"windowRef",window},{"keys",{"F12"}}});
        else { brushBtn=find(window,profile.at("selectors").at("brushMenu")); click(window,brushBtn); }
        bool opened=false;
        for(int i=0;i<50;++i) {
            auto list=call("window.list",{{"pid",w.at("pid")}}).at("windows");
            for(const auto& candidate:list) {
                if(candidate.at("windowRef")!=window && candidate.value("foreground",false)) {host=candidate.at("windowRef");opened=true;break;}
            }
            if(opened) break;
            // A prior brush selection can leave the gallery open, so the first click closes it
            // instead of opening a fresh one; re-click once to re-open before giving up.
            if(!save && i==8) click(window,brushBtn);
            sleep(100);
        }
        if(!opened) throw std::runtime_error("expected_popup_not_ready");
        if(save) {
            phase="saveFilename";
            const auto field=find(host,profile.at("save").at("fileName"));
            // The Windows save dialog rejects forward slashes; type the native (backslash) path.
            std::string nativePath=args.at("path").get<std::string>();
            std::replace(nativePath.begin(),nativePath.end(),'/','\\');
            call("ui.set_value",{{"elementRef",field},{"value",nativePath}});
            if(call("ui.get",{{"elementRef",field}}).at("value")!=nativePath) throw std::runtime_error("filename_readback_mismatch");
            // The extension asks Paint for PNG. Verify actual bytes, not only the suffix.
            phase="saveConfirm";
            click(host,find(host,profile.at("save").at("confirm")));
            bool finished=false;
            for(int i=0;i<50;++i) {
                bool stillOpen=false;
                for(const auto& candidate:call("window.list",{{"pid",w.at("pid")}}).at("windows"))
                    if(candidate.at("windowRef")!=window && candidate.value("foreground",false)) stillOpen=true;
                if(!stillOpen && std::filesystem::exists(target)) {finished=true;break;}
                sleep(100);
            }
            if(!finished) throw std::runtime_error("save_not_completed");
            std::ifstream file(target,std::ios::binary); unsigned char signature[8]{};file.read(reinterpret_cast<char*>(signature),8);
            const unsigned char png[]={137,80,78,71,13,10,26,10};
            if(!file || !std::equal(std::begin(signature),std::end(signature),std::begin(png))) throw std::runtime_error("saved_format_not_png");
            const auto image=load_image(target);
            return {{"status","ok"},{"action",action},{"path",args.at("path")},{"width",image.width},{"height",image.height},
                {"verification","png_decoded"},{"nativeCalls",calls}};
        }
        phase="selectBrush";
        click(host,find(host,profile.at("brushes").at(args.at("brush").get<std::string>())));
        // Paint exposes the active tool in the canvas accessible name.
        const auto name=profile.at("brushes").at(args.at("brush").get<std::string>()).at("name");
        bool verified=false;
        for(int i=0;i<20;++i) {
            auto r=call("ui.find",{{"windowRef",window},{"selector",{{"role","Pane"},{"nameContains",name}}},{"depth",20},{"limit",2},{"format","locator"}});
            if(!ui_inspection_complete(r)) throw std::runtime_error("ui_inspection_incomplete");
            if(r.at("elements").size()==1) {verified=true;break;}
            sleep(100);
        }
        return {{"status","ok"},{"action",action},{"brush",args.at("brush")},{"verification",verified?Json("canvas_tool_name"):Json("menu_selection_dispatched")},{"nativeCalls",calls},
            {"elapsedMs",std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-started).count()}};
    } catch(const std::exception& e) {
        Json r={{"status","error"},{"phase",phase},{"message",e.what()},{"nativeCalls",calls}};
        if(std::string(e.what())=="profile_evidence_stale") {
            r["code"]="profile_evidence_stale";r["dispatch"]="not_started";
        } else if(std::string(e.what())=="ui_inspection_incomplete")r["code"]="ui_inspection_incomplete";
        if(ready && request.contains("failureScreenshot")) try {
            r["capture"]=execute("capture.window",{{"windowRef",host},{"output",request.at("failureScreenshot")},{"method","screen"}});
        } catch(const std::exception& ce) {r["captureError"]=ce.what();}
        return r;
    }
}
}
