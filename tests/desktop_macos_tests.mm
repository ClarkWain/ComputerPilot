#include <desktop_pilot/service.hpp>
#include <desktop_pilot/platform.hpp>
#import <AppKit/AppKit.h>
#include <iostream>
#include <thread>

@interface DPPointerPad : NSView
@property(strong) NSTextField* result;
@property NSInteger drags;
@end
@implementation DPPointerPad
- (BOOL)isAccessibilityElement {return YES;}
- (NSString*)accessibilityRole {return NSAccessibilityGroupRole;}
- (NSString*)accessibilityLabel {return @"Pilot pointer pad";}
- (void)drawRect:(NSRect)dirtyRect {
    [[NSColor colorWithSRGBRed:0.12 green:0.42 blue:0.74 alpha:1] setFill];NSRectFill(self.bounds);
}
- (void)mouseDown:(NSEvent*)event {self.drags=0;}
- (void)mouseDragged:(NSEvent*)event {++self.drags;}
- (void)mouseUp:(NSEvent*)event {self.result.stringValue=[NSString stringWithFormat:@"Pointer drags:%ld",(long)self.drags];}
@end

@interface DPFixture : NSObject
@property(strong) NSTextField* field;
@property(strong) NSTextField* result;
@property(strong) NSAlert* alert;
- (void)apply:(id)sender;
- (void)openModal:(id)sender;
@end
@implementation DPFixture
- (void)apply:(id)sender {self.result.stringValue=[@"Applied: " stringByAppendingString:self.field.stringValue];}
- (void)openModal:(id)sender {
    self.alert=[NSAlert new];self.alert.messageText=@"ComputerPilot test sheet";
    [self.alert addButtonWithTitle:@"Continue"];
    [self.alert beginSheetModalForWindow:self.field.window completionHandler:^(NSModalResponse response) {}];
}
@end

int main(int argc,char** argv) {
    @autoreleasepool {
        if(argc>1) {
            [NSApplication sharedApplication];[NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
            // A CLI-created Cocoa app has no default Edit menu. Install the
            // normal responder-chain command so Cmd+A has real app semantics.
            auto menu=[NSMenu new];auto editItem=[NSMenuItem new];auto edit=[[NSMenu alloc] initWithTitle:@"Edit"];
            [edit addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];
            editItem.submenu=edit;[menu addItem:editItem];NSApp.mainMenu=menu;
            auto window=[[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,500,360) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
            window.title=@"ComputerPilot disposable macOS fixture";
            __attribute__((objc_precise_lifetime)) DPFixture* target=[DPFixture new];target.field=[[NSTextField alloc] initWithFrame:NSMakeRect(30,270,400,30)];target.field.identifier=@"pilot-field";target.field.accessibilityLabel=@"Pilot text";
            target.result=[NSTextField labelWithString:@"Waiting"];target.result.frame=NSMakeRect(30,155,440,30);
            auto button=[NSButton buttonWithTitle:@"Apply" target:target action:@selector(apply:)];button.frame=NSMakeRect(30,210,100,30);
            auto modal=[NSButton buttonWithTitle:@"Open modal" target:target action:@selector(openModal:)];modal.frame=NSMakeRect(160,210,140,30);
            auto pad=[[DPPointerPad alloc] initWithFrame:NSMakeRect(30,25,440,110)];pad.result=target.result;pad.identifier=@"pilot-pad";
            [window.contentView addSubview:pad];
            [window.contentView addSubview:modal];
            [window.contentView addSubview:target.field];[window.contentView addSubview:button];[window.contentView addSubview:target.result];
            // Reproduce Preview's overlapping document geometry. The backend
            // must distinguish the target by its compositor/AX title.
            __attribute__((objc_precise_lifetime)) NSWindow* overlap=[[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,500,360) styleMask:NSWindowStyleMaskTitled|NSWindowStyleMaskClosable backing:NSBackingStoreBuffered defer:NO];
            overlap.title=@"ComputerPilot overlapping identity fixture";
            [window makeKeyAndOrderFront:nil];[NSApp activateIgnoringOtherApps:YES];
            [overlap setFrame:window.frame display:YES];[overlap orderBack:nil];
            [NSApp run];return 0;
        }
        NSTask* child=nil;const char* phase="preflight";
        try {
            dp::Service service;auto preflight=service.execute("system.preflight",dp::Json::object());
            if(!preflight.value("ready",false)){std::cout<<"SKIP: grant Accessibility and Screen Recording before interactive tests\n";return 77;}
            child=[NSTask new];child.executableURL=[NSURL fileURLWithPath:[NSString stringWithUTF8String:dp::executable_path().c_str()]];child.arguments=@[@"fixture"];
            NSError* error=nil;if(![child launchAndReturnError:&error])throw std::runtime_error("Cannot launch disposable fixture");
            auto require=[](bool yes,const char* reason){if(!yes)throw std::runtime_error(reason);};
            dp::Json window;for(int i=0;i<50;++i){auto rows=service.execute("window.list",{{"pid",child.processIdentifier}})["windows"];for(const auto& row:rows)if(row.value("title",std::string{})=="ComputerPilot disposable macOS fixture") {
                // Compositor discovery can precede AX publication. Wait for a
                // usable read before the test starts sending input.
                try{service.execute("window.get",{{"windowRef",row["windowRef"]}});window=row;}
                catch(const std::runtime_error& error){if(std::string(error.what())!="AX window unavailable; use image mode")throw;}
            }if(!window.is_null())break;std::this_thread::sleep_for(std::chrono::milliseconds(100));}
            require(!window.is_null(),"Fixture window not found");auto ref=window.at("windowRef");
            auto before=service.execute("window.get",{{"windowRef",ref}})["bounds"];
            const auto fixtureWindows=service.execute("window.list",{{"pid",child.processIdentifier}})["windows"];
            bool overlapping=false;for(const auto& row:fixtureWindows)
                if(row.value("title",std::string{})=="ComputerPilot overlapping identity fixture"&&row["bounds"]==before)overlapping=true;
            if(!overlapping)throw std::runtime_error("Identity fixture windows did not overlap: "+dp::dump_json(fixtureWindows));
            for(const auto& row:fixtureWindows)if(row.value("title",std::string{})=="ComputerPilot overlapping identity fixture") {
                service.execute("window.activate",{{"windowRef",row["windowRef"]}});
                require(!service.execute("window.get",{{"windowRef",ref}}).value("foreground",true),"Overlapping windows were both reported focused");
            }
            auto activated=service.execute("window.activate",{{"windowRef",ref}});require(activated.value("foreground",false),"Fixture not focused");
            // Initial Cocoa placement can settle while activation is completing.
            // Compare observations against the activated, live window geometry.
            before=activated.at("bounds");phase="text input";
            auto tree=service.execute("ui.tree",{{"windowRef",ref}});dp::Json field,button;
            for(auto& e:tree["elements"]){if(e.value("automationId",std::string{})=="pilot-field")field=e;if(e.value("name",std::string{})=="Apply"&&e["role"]=="Button")button=e;}
            require(!field.is_null()&&!button.is_null(),"Fixture controls not exposed");
            auto filled=service.execute("ui.fill",{{"elementRef",field["elementRef"]},{"text","中文 / macOS 🌏"}});require(filled["verification"]=="passed","AX fill readback failed");
            service.execute("ui.focus",{{"elementRef",field["elementRef"]}});
            auto selected=service.execute("input.key_chord",{{"windowRef",ref},{"keys",{"WIN","A"}}});require(selected["status"]=="ok","Command+A dispatch failed");
            auto typed=service.execute("input.type_text",{{"windowRef",ref},{"text","Typed 🌏 中文"}});require(typed["status"]=="ok","Unicode key input dispatch failed");
            bool readback=false;dp::Json lastValue;
            for(int i=0;i<40;++i){auto value=service.execute("ui.get",{{"elementRef",field["elementRef"]}});lastValue=value;if(value["value"]=="Typed 🌏 中文"){readback=true;break;}std::this_thread::sleep_for(std::chrono::milliseconds(50));}
            if(!readback)throw std::runtime_error("CGEvent Unicode input readback failed: "+dp::dump_json(lastValue));
            service.execute("ui.click",{{"elementRef",button["elementRef"]}});
            tree=service.execute("ui.tree",{{"windowRef",ref}});bool applied=false;for(auto& e:tree["elements"])if(e.value("value",dp::Json())=="Applied: Typed 🌏 中文")applied=true;
            require(applied,"AX button did not update result");
            phase="screenshot";auto artifacts=dp::environment_path("DP_TEST_ARTIFACTS_DIR");
            auto output=artifacts.empty()?std::filesystem::temp_directory_path()/("dp-macos-test-"+std::to_string(dp::process_id())+".png"):artifacts/"native-window.png";
            auto captured=service.execute("capture.window",{{"windowRef",ref},{"output",output.string()},{"maxEdge",1600}});auto image=dp::load_image(output);
            require(image.width>0&&image.height>0&&captured["method"]=="macos.ScreenCaptureKit","ScreenCaptureKit failed");
            if(artifacts.empty())std::filesystem::remove(output);
            else dp::write_json(artifacts/"native-capture.json",captured);
            auto afterGeometry=service.execute("window.get",{{"windowRef",ref}})["bounds"];
            if(afterGeometry!=before)throw std::runtime_error("Observation changed geometry: before="+dp::dump_json(before)+" activated="+dp::dump_json(activated.value("bounds",dp::Json()))+" after="+dp::dump_json(afterGeometry));
            phase="modal sheet";tree=service.execute("ui.tree",{{"windowRef",ref}});dp::Json modalButton;
            for(auto& e:tree["elements"])if(e.value("name",std::string{})=="Open modal")modalButton=e;
            require(!modalButton.is_null(),"Modal fixture button missing");
            service.execute("ui.click",{{"elementRef",modalButton["elementRef"]}});
            dp::Json blocked;for(int i=0;i<40;++i){blocked=service.execute("window.get",{{"windowRef",ref}});if(!blocked.value("enabled",true))break;std::this_thread::sleep_for(std::chrono::milliseconds(50));}
            require(!blocked.value("enabled",true)&&blocked.contains("blockingWindow"),"Sheet did not identify its blocking window");
            auto stopped=service.execute("input.key_chord",{{"windowRef",ref},{"keys",{"ENTER"}}});
            require(stopped["code"]=="window_blocked"&&stopped["dispatch"]=="not_started","Input was sent to a sheet-blocked parent");
            auto popup=blocked["blockingWindow"]["windowRef"];auto popupTree=service.execute("ui.tree",{{"windowRef",popup}});dp::Json continueButton;
            for(auto& e:popupTree["elements"])if(e.value("name",std::string{})=="Continue")continueButton=e;
            require(!continueButton.is_null(),"Sheet controls unavailable");service.execute("ui.click",{{"elementRef",continueButton["elementRef"]}});
            [child terminate];[child waitUntilExit];std::cout<<"PASS disposable macOS AX, Unicode fill/input, Command chord, button, screenshot, geometry\n";return 0;
        } catch(const std::exception& e){if(child.running){[child terminate];[child waitUntilExit];}std::cerr<<phase<<": "<<e.what()<<'\n';return 1;}
    }
}
