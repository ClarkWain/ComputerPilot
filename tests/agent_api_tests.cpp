#include <desktop_pilot/agent_api.hpp>
#include <iostream>
#include <stdexcept>
using namespace dp;
int main(){
 int checks=0,writes=0;auto check=[&](bool b,const char* m){++checks;if(!b)throw std::runtime_error(m);};
 try {
  AgentApi api;Json bounds={{"x",100},{"y",200},{"width",400},{"height",300}};
  Json control_id={{"elementRef","e1"},{"name","Title"},{"role","Edit"},{"value","old"},{"bounds",{{"x",120},{"y",230},{"width",100},{"height",20}}}};
  bool multi=false,empty=false,fail=false,foreground=true,enabled=true,activationWorks=true,stealFocus=false;int activations=0,measuredDpi=144,clientHeight=400;Json last;
  Json frame={{"width",200},{"height",150},{"bounds",bounds},{"path","test.webp"},{"imageRef","image1"}};
  int profileReads=0,treeReads=0,captures=0;bool inspectionFails=false,invalidated=false,profileFails=false,malformedTree=false;Json captureArgs;
  std::string resetOperation;
  auto dispatch=[&](const std::string& op,const Json& args)->Json{
   if(op==resetOperation)return {{"status","error"},{"referencesInvalidated",true},{"dispatch","unknown"},{"code","provider_timeout"}};
   Json w={{"windowRef","w1"},{"pid",42},{"title","Example"},{"foreground",foreground},{"enabled",enabled},{"bounds",bounds},
      {"dpi",measuredDpi},{"dpiAwareness","per_monitor"},{"client",{{"dip96",{{"width",600},{"height",clientHeight}}}}},
      {"display",{{"dpi",measuredDpi},{"name","DISPLAY1"}}}};
   if(!enabled)w["blockingWindow"]={{"windowRef","dialog"},{"title","Confirm"},{"pid",42}};
   if(op=="semantic.profiles") {
    ++profileReads;
    check(args.at("providerTimeoutMs")==8000,"profile scan has a worker deadline");
    if(profileFails)return {{"status","error"},{"code","provider_error"},{"referencesInvalidated",invalidated}};
    return {{"status","ok"},{"profiles",Json::array()}};
   }
   if(op=="window.list") {
    check(args.empty(),"enumeration must not forward filters");
    auto second=w;second["windowRef"]="w2";
    return {{"windows",empty?Json::array():(multi?Json::array({w,second}):Json::array({w}))}};
   }
   if(op=="window.get")return w;
   if(op=="ui.tree") {
    ++treeReads;
    if(malformedTree)return {{"status","ok"},{"elements",42}};
    if(inspectionFails)return {{"status","error"},{"code","provider_error"},{"referencesInvalidated",invalidated}};
    return {{"elements",Json::array({control_id})},{"truncated",false}};
   }
   if(op=="ui.get")return control_id;
   if(op=="capture.window"){++captures;captureArgs=args;return frame;}
   if(op=="window.activate"){++activations;foreground=activationWorks;return {{"status","ok"}};}
   ++writes;last=args;
   if(fail)return {{"status","error"},{"dispatch","unknown"}};
   if(stealFocus)foreground=false;
   return {{"status","ok"}};
  };
  check(AgentApi::tools().size()==4,"four public tools");
  check(api.call("execute_single",Json::object(),dispatch)["code"]=="invalid_arguments","removed tools are not aliases");
  check(AgentApi::tools()[0]["inputSchema"]["properties"].empty(),"list schema has no parameters");
  check(api.call("list_windows",{{"title","Example"}},dispatch)["code"]=="invalid_arguments","title filter rejected");
  check(api.call("list_windows",{{"pid",42}},dispatch)["code"]=="invalid_arguments","pid filter rejected");
  multi=true;auto listed=api.call("list_windows",Json::object(),dispatch);
  check(listed["status"]=="ok"&&listed["windows"].size()==2&&!listed.contains("window_id")&&writes==0,"multiple matches remain a list without selecting or activating");multi=false;
  listed=api.call("list_windows",Json::object(),dispatch);
  check(listed["status"]=="ok"&&listed["windows"].size()==1&&listed["windows"][0]["window_id"]=="w1","single match retains list shape");
  empty=true;listed=api.call("list_windows",Json::object(),dispatch);empty=false;
  check(listed["status"]=="ok"&&listed["windows"].is_array()&&listed["windows"].empty(),"no matches return an empty list");
  check(api.call("list_windows",{{"window_id","w1"}},dispatch)["code"]=="invalid_arguments","list does not accept a selection command");
  check(api.call("get_window_state",{{"window_id","unknown"}},dispatch)["code"]=="unknown_window","reject unlisted window");
  AgentApi other;
  check(other.call("get_window_state",{{"window_id","w1"}},dispatch)["code"]=="unknown_window","window ids belong to one connection");
  auto observe=[&](){return api.call("get_window_state",{{"window_id","w1"},{"mode","controls"}},dispatch);};
    auto o=observe();check(o["controls"][0]["bounds"][0]==20&&o["controls"][0]["bounds"][1]==30&&o["controls"][0]["bounds"][2]==100&&o["controls"][0]["bounds"][3]==20,"window coordinate conversion");
   control_id["enabled"]=true;control_id["offscreen"]=false;control_id["value"]=std::string(500,'v');
   o=observe();check(!o["controls"][0].contains("enabled")&&!o["controls"][0].contains("offscreen")&&o["controls"][0]["value"].get<std::string>().size()<300,"compact control omits default flags and caps text");
   o=api.call("get_window_state",{{"window_id","w1"},{"detail","full"}},dispatch);
   check(o["controls"][0]["enabled"]==true&&o["controls"][0]["offscreen"]==false&&o["controls"][0]["value"].get<std::string>().size()==500,"full control detail remains available");
   check(api.call("get_window_state",{{"window_id","w1"},{"mode","controls"},{"image_delivery","inline"}},dispatch)["code"]=="invalid_arguments","controls-only observation cannot request an inline image");
   control_id["value"]="old";
   observe();
  Json base={{"window_id","w1"}};
  auto act=[&](Json action){auto a=base;a["actions"]=Json::array({action});return api.call("execute_batch",a,dispatch);};
  check(act({{"type","click"},{"point",{{"x",400},{"y",5}}}})["code"]=="invalid_arguments"&&writes==0,"reject outside points before dispatch");
  check(act({{"type","fill_text"},{"control_id","other"},{"text","new"}})["code"]=="invalid_arguments"&&writes==0,"reject control_id not observed");
  auto a=base;a["actions"]=Json::array({Json{{"type","click"},{"point",{{"x",1},{"y",2}}}},Json{{"type","press_keys"},{"chord","INVALID"}}});
  check(api.call("execute_batch",a,dispatch)["code"]=="invalid_arguments"&&writes==0,"validate entire batch before first input");
  check(act({{"type","press_keys"},{"chord","Control_L+a"}})["status"]=="ok"&&last["keys"][0]=="CTRL"&&last["keys"][1]=="A","normalize aliases");
  check(last["windowRef"]=="w1"&&last["coordinateSpace"]=="window_relative","bind all inputs");
  check(act({{"type","press_keys"},{"chord","Enter"}})["code"]=="state_required","cannot reuse consumed observation");
  o=observe();bounds["x"]=101;
  check(act({{"type","press_keys"},{"chord","Enter"}})["completed"]==0&&writes==1,"reject changed geometry");
  bounds["x"]=100;o=observe();fail=true;
  fail=false;clientHeight=399;
  check(act({{"type","press_keys"},{"chord","Enter"}})["error"]["code"]=="geometry_changed","client-only layout change invalidates observation");
  clientHeight=400;o=observe();measuredDpi=120;
  check(act({{"type","press_keys"},{"chord","Enter"}})["error"]["code"]=="geometry_changed","DPI change invalidates observation");
  measuredDpi=144;o=observe();fail=true;
  a=base;a["actions"]=Json::array({Json{{"type","press_keys"},{"chord","Enter"}},Json{{"type","press_keys"},{"chord","Tab"}}});
  auto r=api.call("execute_batch",a,dispatch);check(r["failedIndex"]==0&&r["dispatch"]=="unknown"&&writes==2,"partial/unknown stops without replay");
  fail=false;o=observe();
  r=act({{"type","fill_text"},{"control_id","e1"},{"text","new"}});check(r["fieldsVerified"]==1&&r["verification"]=="business_result_not_verified","field/business verification distinct");
  foreground=false;auto activationCount=activations;o=observe();
  check(o["status"]=="ok"&&o["foreground"]==true&&activations==activationCount+1,"state read activates target automatically");
  foreground=false;r=api.call("get_window_state",{{"window_id","w1"},{"mode","controls"},{"activate",false}},dispatch);
  check(r["foreground"]==false&&activations==activationCount+1,"explicit background diagnostics do not activate");
  stealFocus=true;
  a=base;a["actions"]=Json::array({Json{{"type","press_keys"},{"chord","Enter"}},Json{{"type","press_keys"},{"chord","Tab"}}});
  r=api.call("execute_batch",a,dispatch);stealFocus=false;
  check(r["completed"]==2&&activations==activationCount+3&&last["autoActivate"]==true,"each batch action restores focus without agent intervention");
  foreground=false;activationWorks=false;auto writesBefore=writes;
  r=observe();check(r["code"]=="window_activation_failed"&&writes==writesBefore,"failed activation sends no action input");
  activationWorks=true;foreground=true;o=observe();enabled=false;
  r=act({{"type","press_keys"},{"chord","Enter"}});
  check(r["completed"]==0&&r["dispatch"]=="not_started"&&r["error"]["code"]=="window_blocked"&&r["error"]["blocking_window"]["window_id"]=="dialog"&&writes==writesBefore,"modal blocks original input and identifies dialog");
  enabled=true;
  auto semantic=api.call("execute_semantic",{{"window_id","w1"},{"profile","actual-profile"},{"actions",Json::array({Json{{"action","drawing.drawCircle"},{"args",{{"center",{50,50}},{"radius",10}}}}})}},dispatch);
  check(semantic["status"]=="ok" && last["profileId"]=="actual-profile" && last["windowRef"]=="w1","semantic routes profile id and batch to native executor");
  check(!observe().contains("state_id"),"state ids are not exposed");

  auto path=Json::array({Json::array({10,20}),Json::array({30,40}),Json::array({50,20})});
  r=act({{"type","move"},{"points",path},{"hold","left"}});
  check(r["completed"]==1&&last["points"]==path&&last["hold"]=="left"&&last["coordinateSpace"]=="window_relative","continuous held path is dispatched once with compact points");
  observe();r=act({{"type","move"},{"points",Json::array({Json::array({5,6})})}});
  check(r["status"]=="ok"&&!last.contains("hold"),"plain move has no implicit press");
  for(auto hold:{"right","middle"}) {observe();r=act({{"type","move"},{"points",path},{"hold",hold}});check(r["status"]=="ok"&&last["hold"]==hold,"supported hold buttons");}
  observe();auto beforeInvalid=writes;
  for(auto invalid:Json::array({Json::array(),Json::array({Json::array({1})}),Json::array({Json::array({1.5,2})}),Json::array({Json::array({-1,2})}),Json::array({Json::array({4294967297LL,2})}),Json::array({Json::array({400,2})})}))
      check(act({{"type","move"},{"points",invalid}})["code"]=="invalid_arguments"&&writes==beforeInvalid,"invalid path rejected before any input");
  check(act({{"type","move"},{"points",path},{"hold","none"}})["code"]=="invalid_arguments","unsupported hold rejected");
  check(act({{"type","move"},{"points",Json::array({Json::array({1,2})})},{"hold","left"}})["code"]=="invalid_arguments","single point hold rejected");
  auto tooLong=Json::array();for(int i=0;i<4097;++i)tooLong.push_back({1,2});
  check(act({{"type","move"},{"points",tooLong}})["code"]=="invalid_arguments","path count bounded");
  a=base;a["actions"]=Json::array({Json{{"type","press_keys"},{"chord","Enter"}},Json{{"type","move"},{"points",Json::array({Json::array({1,2}),Json::array({400,2})})},{"hold","left"}}});
  check(api.call("execute_batch",a,dispatch)["code"]=="invalid_arguments"&&writes==beforeInvalid,"invalid final path point prevents earlier batch input too");

  o=api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},dispatch);
   check(o["capture"]["delivery"]=="path","screenshot defaults to path delivery");
   check(captureArgs["maxEdge"]==1600,"full screenshot retains 1600 default");
   o=api.call("get_window_state",{{"window_id","w1"},{"mode","image"},{"max_edge",1920}},dispatch);
   check(captureArgs["maxEdge"]==1920,"requested screenshot output size reaches capture");
   o=api.call("get_window_state",{{"window_id","w1"},{"mode","image"},{"region",{{"x",0},{"y",0},{"width",100},{"height",100}}}},dispatch);
   check(captureArgs["maxEdge"]==32000&&captureArgs["lossless"]==true,"region keeps source resolution by default");
   o=api.call("get_window_state",{{"window_id","w1"},{"mode","image"},{"image_delivery","inline"}},dispatch);
   check(o["capture"]["delivery"]=="inline","inline screenshot can be requested explicitly");
  r=act({{"type","click"},{"point",{{"x",100},{"y",50}}}});
  check(o["coordinateSpace"]=="image_pixels"&&last["x"]==201&&last["y"]==101,"thumbnail click maps to native window pixels");
  observe();auto mixedPrepare=base;mixedPrepare["actions"]=Json::array({Json{{"type","prepare_window"},{"client_size",{{"width",1200},{"height",700},{"unit","dip96"}}}},Json{{"type","press_keys"},{"chord","Enter"}}});
  check(api.call("execute_batch",mixedPrepare,dispatch)["code"]=="invalid_arguments","window preparation must not share a batch with stale coordinates");
  auto prepared=act({{"type","prepare_window"},{"client_size",{{"width",1200},{"height",700},{"unit","dip96"}}},
      {"minimum_client_size",{{"width",1100},{"height",600},{"unit","dip96"}}}});
  check(prepared["status"]=="ok"&&last["width"]==1200&&last["minimumHeight"]==600,"explicit standalone window preparation dispatches logical client size");
  check(act({{"type","press_keys"},{"chord","Enter"}})["code"]=="state_required","window preparation invalidates old observation");
  frame["bounds"]={{"x",150},{"y",260},{"width",100},{"height",100}};frame["width"]=100;frame["height"]=100;
  api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},dispatch);
  r=act({{"type","move"},{"points",{{10,20},{30,40}}},{"hold","left"}});
  check(last["points"]==Json({{60,80},{80,100}}),"cropped screenshot path maps offsets internally");
  observe();r=act({{"type","click"},{"control_id","e1"}});
  check(last["elementRef"]=="e1"&&!last.contains("x"),"control click routes by element instead of global coordinates");
  auto profilesBefore=profileReads,treesBefore=treeReads;
  inspectionFails=true;profileFails=true;
  o=api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},dispatch);
  check(o["status"]=="ok"&&o["semantic"]["status"]=="not_checked"&&profileReads==profilesBefore&&treeReads==treesBefore,"image bypasses all UIA even when provider is broken");
  check(act({{"type","click"},{"point",{{"x",10},{"y",10}}}})["status"]=="ok","image fallback supports verified coordinate input");
  o=api.call("get_window_state",{{"window_id","w1"},{"mode","both"}},dispatch);
  check(o["status"]=="ok"&&o.contains("capture")&&o["inspection"]["status"]=="error"&&o["controls"].empty()&&treeReads==treesBefore,"both preserves image without a second scan after discovery failure");
  profileFails=false;
  o=api.call("get_window_state",{{"window_id","w1"},{"mode","both"}},dispatch);
  check(o["status"]=="ok"&&o.contains("capture")&&o["inspection"]["code"]=="provider_error","both preserves image after ordinary control query failure");
  check(act({{"type","click"},{"control_id","e1"}})["code"]=="invalid_arguments","failed scan does not retain old controls");
  check(observe()["code"]=="provider_error","controls-only failure is explicit");
  auto captureBefore=captures;invalidated=true;
  o=api.call("get_window_state",{{"window_id","w1"},{"mode","both"}},dispatch);
  check(o["referencesInvalidated"]==true&&captures==captureBefore,"worker reset never captures with invalid window references");
  check(api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},dispatch)["code"]=="unknown_window","worker reset clears old target ids");
  check(act({{"type","press_keys"},{"chord","Enter"}})["code"]=="state_required","worker reset clears old observations");
  inspectionFails=false;invalidated=false;api.call("list_windows",Json::object(),dispatch);
  check(api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},dispatch)["status"]=="ok","fresh enumeration restores image path after reset");
  malformedTree=true;
  r=api.call("get_window_state",{{"window_id","w1"},{"mode","both"}},dispatch);
  check(r["status"]=="ok"&&r.contains("capture")&&r["inspection"]["code"]=="invalid_inspection_result","malformed UIA output preserves screenshot and explains failure");
  malformedTree=false;
  for(auto operation:{"window.get","window.activate","capture.window","ui.get","semantic.execute","input.key_chord"}) {
   api.call("list_windows",Json::object(),dispatch);observe();
   resetOperation=operation;
   if(resetOperation=="semantic.execute") r=api.call("execute_semantic",{{"window_id","w1"},{"actions",Json::array({Json{{"action","drawing.drawCircle"},{"args",{{"center",{50,50}},{"radius",10}}}}})}},dispatch);
   else if(resetOperation=="ui.get")r=act({{"type","click"},{"control_id","e1"}});
   else if(resetOperation=="input.key_chord")r=act({{"type","press_keys"},{"chord","Enter"}});
   else {
    if(resetOperation=="window.activate")foreground=false;
    r=api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},dispatch);
   }
   resetOperation.clear();foreground=true;
   check(r["referencesInvalidated"]==true&&r["next"].get<std::string>().find("list_windows")!=std::string::npos,"every worker reset reports fresh enumeration, including input failures");
   check(api.call("get_window_state",{{"window_id","w1"},{"mode","image"}},dispatch)["code"]=="unknown_window","every worker reset clears targets");
   check(act({{"type","press_keys"},{"chord","Enter"}})["code"]=="state_required","every worker reset clears observations");
  }
  std::cout<<"PASS checks="<<checks<<'\n';return 0;
 }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
