#include <desktop_pilot/platform.hpp>
#include <desktop_pilot/replay.hpp>
#include <desktop_pilot/recording.hpp>
#include <desktop_pilot/detector.hpp>
#include <desktop_pilot/ocr.hpp>
#include <desktop_pilot/desktop.hpp>
#include <desktop_pilot/service.hpp>
#include <desktop_pilot/agent_api.hpp>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <iostream>
#include <fstream>
#include <map>
#include <set>
#include <stdexcept>

namespace {
using namespace dp;
using Path=std::filesystem::path;
using Options=std::map<std::wstring,std::wstring>;
Options parse_options(int argc,wchar_t** argv,const std::set<std::wstring>& allowed) {
    Options out;
    for(int i=2;i<argc;i+=2) {
        std::wstring key=argv[i];
        if(!allowed.contains(key)) throw std::invalid_argument("Unknown option: "+utf8(key));
        if(i+1>=argc) throw std::invalid_argument("Missing value for "+utf8(key));
        if(!out.emplace(key,argv[i+1]).second) throw std::invalid_argument("Duplicate option: "+utf8(key));
    }
    return out;
}
std::wstring get(const Options& args,const std::wstring& key,std::wstring fallback=L"") {
    auto it=args.find(key); return it==args.end()?fallback:it->second;
}
Path required(const Options& args,const std::wstring& key) {
    auto value=get(args,key); if(value.empty()) throw std::invalid_argument("Required option: "+utf8(key)); return Path(value);
}
double number(const Options& args,const std::wstring& key,double fallback) {
    auto value=get(args,key); if(value.empty()) return fallback;
    size_t n=0; double v=std::stod(value,&n);
    if(n!=value.size() || !std::isfinite(v)) throw std::invalid_argument("Invalid numeric value for "+utf8(key));
    return v;
}
int integer(const Options& args,const std::wstring& key,int fallback,int min,int max) {
    double v=number(args,key,fallback);
    if(v<min || v>max || std::floor(v)!=v) throw std::invalid_argument("Invalid integer/range for "+utf8(key));
    return int(v);
}
Json capabilities() {
#ifdef __APPLE__
    constexpr bool replay_execution=true;
#else
    constexpr bool replay_execution=false;
#endif
    return {{"name","DesktopPilot"},{"version",DP_PROJECT_VERSION},{"transport","cli"},{"pythonRequired",false},
        {"operations",{{"image.decode",true},{"image.fixture",true},{"vision.detect",Detector::available()},
        {"vision.overlay",true},{"vision.ocr",Ocr::available()},{"vision.textAssociation",true},{"ui.fusion",true},{"desktop.capture",true},{"input.click",true},{"mcp",true},{"replay.validate",true},{"replay.run",replay_execution},{"replay.resume",replay_execution},{"recording.calls",true},{"recording.export",true}}}};
}
}
DP_MAIN(pilot_main) {
    try {
        if(argc<2 || std::wstring(argv[1])==L"--help") {
            std::cout<<"DesktopPilot native screenshot parser\n"
                "  capabilities\n  fixture --output FILE.png\n"
                "  parse --image FILE --model FILE.pt [--output FILE.json] [--overlay FILE.png]\n"
                "        [--size 640] [--confidence 0.25] [--iou 0.7] [--threads 4] [--max-detections 300]\n"
                "        [--ocr-models DIR] [--ocr-max-side 960] [--text-threshold 0.5]\n"
                "  ocr --image FILE --ocr-models DIR [--output FILE.json] [--overlay FILE.png]\n"
                "  agent-schema (machine-readable common tool schemas)\n"
                "  doctor (read-only desktop preflight; exit 3 when not ready)\n"
                "  replay --file RECIPE.json [--mode validate|run] [--output NEW_DIRECTORY] [--record NEW_DIRECTORY] [--stop-after STEP]\n"
                "  replay-resume --from RUN_DIRECTORY [--stop-after STEP]\n"
                "  recording-export --file SESSION.jsonl --template RECIPE.json --output NEW_DIRECTORY\n"
                "  serve (MCP stdio) [--input FILE.jsonl --output FILE.jsonl] [--record NEW_DIRECTORY]\n  jsonl (native registry)\n"; return 0;
        }
        std::wstring command=argv[1];
        if(command==L"agent-schema") {parse_options(argc,argv,{});std::cout<<dump_json(AgentApi::tools(),2)<<'\n';return 0;}
        if(command==L"replay") {
            auto args=parse_options(argc,argv,{L"--file",L"--mode",L"--output",L"--record",L"--stop-after"});
            if(args.contains(L"--record")&&get(args,L"--record").empty())throw std::invalid_argument("--record requires a new directory");
            auto mode=get(args,L"--mode",L"validate");
            if(mode!=L"validate"&&mode!=L"run")throw std::invalid_argument("Replay mode must be validate or run");
            if(mode==L"validate"&&(args.contains(L"--output")||args.contains(L"--record")||args.contains(L"--stop-after")))throw std::invalid_argument("--output/--record/--stop-after require replay --mode run");
            return replay_cli(required(args,L"--file"),Path(get(args,L"--output")),mode==L"run",Path(get(args,L"--record")),args.contains(L"--stop-after")?integer(args,L"--stop-after",0,1,512):0);
        }
        if(command==L"replay-resume") {
            auto args=parse_options(argc,argv,{L"--from",L"--stop-after"});
            return replay_resume_cli(required(args,L"--from"),args.contains(L"--stop-after")?integer(args,L"--stop-after",0,1,512):0);
        }
        if(command==L"recording-export") {
            auto args=parse_options(argc,argv,{L"--file",L"--template",L"--output"});
            return recording_export_cli(required(args,L"--file"),required(args,L"--template"),required(args,L"--output"));
        }
        if(command==L"doctor") {
            parse_options(argc,argv,{});
            Service service;
            auto result=service.execute("system.preflight",Json::object());
            std::cout<<dump_json(result,2)<<'\n';
            return result.value("ready",false)?0:3;
        }
        if(command==L"serve" || command==L"jsonl") {
            auto args=parse_options(argc,argv,command==L"serve"?std::set<std::wstring>{L"--input",L"--output",L"--record"}:std::set<std::wstring>{L"--input",L"--output"});
            if(args.contains(L"--record")&&get(args,L"--record").empty())throw std::invalid_argument("--record requires a new directory");
            std::ifstream input;
            std::ofstream output;
            auto in=get(args,L"--input"), out=get(args,L"--output");
            if(!in.empty() && !out.empty() &&
               (std::filesystem::absolute(Path(in)).lexically_normal()==std::filesystem::absolute(Path(out)).lexically_normal() ||
                (std::filesystem::exists(Path(out)) && std::filesystem::equivalent(Path(in),Path(out)))))
                throw std::invalid_argument("Input and output must be different files");
            if(!in.empty()) { input.open(Path(in),std::ios::binary); if(!input) throw std::runtime_error("Cannot open request file"); }
            if(!out.empty()) { output.open(Path(out),std::ios::binary); if(!output) throw std::runtime_error("Cannot open response file"); }
            auto oldIn=std::cin.rdbuf(); auto oldOut=std::cout.rdbuf();
            struct Restore { std::streambuf *in,*out; ~Restore(){std::cin.rdbuf(in);std::cout.rdbuf(out);} } restore{oldIn,oldOut};
            if(input.is_open()) std::cin.rdbuf(input.rdbuf());
            if(output.is_open()) std::cout.rdbuf(output.rdbuf());
            return serve(command==L"serve",Path(get(args,L"--record")));
        }
        if(command==L"capabilities") {parse_options(argc,argv,{});std::cout<<dump_json(capabilities(),2)<<'\n';return 0;}
        if(command==L"fixture") {
            auto args=parse_options(argc,argv,{L"--output"}); auto output=required(args,L"--output");
            save_png(make_fixture(),output);
            std::cout<<dump_json(Json({{"status","ok"},{"output",utf8(std::filesystem::absolute(output).wstring())},{"synthetic",true}}))<<'\n';return 0;
        }
        if(command!=L"parse" && command!=L"ocr") throw std::invalid_argument("Unknown command: "+utf8(command));
        std::set<std::wstring> allowed={L"--image",L"--output",L"--overlay",L"--threads",L"--ocr-models",L"--ocr-max-side",L"--text-threshold"};
        if(command==L"parse")allowed.insert({L"--model",L"--size",L"--confidence",L"--iou",L"--max-detections"});
        auto args=parse_options(argc,argv,allowed);
        auto input=required(args,L"--image");Path model=command==L"parse"?required(args,L"--model"):Path{};
        Path ocr_dir=command==L"ocr"?required(args,L"--ocr-models"):Path(get(args,L"--ocr-models"));
        if(ocr_dir.empty() && (args.contains(L"--ocr-max-side")||args.contains(L"--text-threshold")))
            throw std::invalid_argument("OCR options require --ocr-models");
        Path output=get(args,L"--output"),overlay=get(args,L"--overlay");
        ensure_distinct_paths(std::array<Path,6>{input,model,output,overlay,ocr_dir.empty()?Path{}:ocr_dir/L"det.onnx",ocr_dir.empty()?Path{}:ocr_dir/L"rec.onnx"});
        DetectorOptions options;
        options.size=integer(args,L"--size",640,32,2048);options.threads=integer(args,L"--threads",4,1,64);
        options.max_detections=integer(args,L"--max-detections",300,1,10000);
        options.confidence=float(number(args,L"--confidence",0.25));options.nms_iou=float(number(args,L"--iou",0.7));options.validate();
        auto start=std::chrono::steady_clock::now();
        auto image=load_image(input); auto image_hash=file_sha256(input);
        std::string image_ref="img-sha256-"+image_hash;
        DetectionResult parsed;Json detector_metadata=nullptr;
        if(command==L"parse"){Detector detector(model,options);parsed=detector.run(image);detector_metadata=detector.metadata();}
        Json result={{"schemaVersion","0.2"},{"status",command==L"ocr"?"ok":"partial"},{"operation",command==L"ocr"?"vision.ocr":"vision.parse"},
            {"image",{{"imageRef",image_ref},{"sha256",image_hash},{"width",image.width},{"height",image.height},
                {"coordinateSpace","image_px"},{"source","file"},{"desktopTransform",nullptr}}},
            {"model",detector_metadata},{"settings",{{"size",options.size},{"confidence",options.confidence},{"iou",options.nms_iou},{"maxDetections",options.max_detections}}},
            {"components",{{"detector",command==L"parse"?"completed":"not_requested"},{"ocr","not_requested"},{"uiaFusion","not_implemented"}}},
            {"elements",detection_json(parsed.detections,image_ref)},{"tensorShapes",parsed.tensor_shapes},{"timingsMs",parsed.timings_ms}};
        int exit_code=0;
        if(!ocr_dir.empty()) {
            OcrOptions oo;oo.threads=options.threads;oo.max_side=integer(args,L"--ocr-max-side",960,32,2048);
            oo.text_threshold=float(number(args,L"--text-threshold",0.5));oo.validate();
            try {
                Ocr ocr(ocr_dir,oo);auto recognized=ocr.run(image);
                result["ocrModel"]=ocr.metadata();result["ocrTimingsMs"]=recognized.timings_ms;
                result["ocrSummary"]={{"candidates",recognized.candidate_count},{"recognized",recognized.lines.size()},
                    {"rejected",recognized.rejected_count},{"truncated",recognized.truncated}};
                result["settings"]["ocr"]={{"maxSide",oo.max_side},{"textThreshold",oo.text_threshold},{"threads",oo.threads}};
                result["components"]["ocr"]=recognized.truncated?"partial":"completed";
                if(recognized.truncated)result["status"]="partial";
                result["textLines"]=text_lines_json(recognized.lines,image_ref);
                result["elements"]=fuse_text(parsed.detections,recognized.lines,image_ref);
                result["components"]["textAssociation"]="completed";
            } catch(const std::exception& e) {
                if(command==L"ocr")throw;
                result["components"]["ocr"]="failed";result["ocrError"]={{"code","ocr_failed"},{"message",e.what()}};exit_code=1;
            }
        }
        if(!overlay.empty()){
            std::vector<Detection> regions;
            for(auto& e:result["elements"]){auto b=e["bounds"];float x=b["x"],y=b["y"],w=b["width"],h=b["height"];regions.push_back({{x,y,x+w,y+h},1,0});}
            save_png(draw_overlay(image,regions),overlay);result["overlayPath"]=utf8(std::filesystem::absolute(overlay).wstring());
        }
        result["timingsMs"]["total"]=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
        if(!output.empty()) write_json(output,result);
        std::cout<<dump_json(result,2)<<'\n'; return exit_code;
    } catch(const std::invalid_argument& e) {
        std::cout<<dump_json(Json({{"status","error"},{"code","invalid_argument"},{"message",e.what()}}))<<'\n';return 2;
    } catch(const std::exception& e) {
        std::cout<<dump_json(Json({{"status","error"},{"code","operation_failed"},{"message",e.what()}}))<<'\n';return 1;
    }
}
