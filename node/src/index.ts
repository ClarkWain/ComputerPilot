import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { NativeClient } from './native/client.js';
import { AgentApi } from './agent/api.js';
import { ProfileEngine } from './profiles/engine.js';
import { createServer } from './mcp/server.js';
import { NodeVision } from './vision/service.js';
import { createPrivateCall } from './agent/router.js';
import { ReplayRecorder } from './replay/record.js';

const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const nativePath=process.env.DP_NATIVE_EXE ?? [
  resolve(packageRoot,'native/desktop-pilot-native.exe'),
  resolve(packageRoot,'build/release/Release/desktop-pilot-native.exe')
].find(existsSync) ?? resolve(packageRoot,'native/desktop-pilot-native.exe');
const profilesPath=process.env.DP_PROFILES_DIR ?? resolve(packageRoot,'profiles');
const native=new NativeClient(nativePath);
process.stdin.once('end',()=>native.close());
try {
  const hello=await native.start();
  if(hello.preflight.ready===false) process.stderr.write(`DesktopPilot DESKTOP ENVIRONMENT ERROR: ${JSON.stringify(hello.preflight)}\n`);
  const call=createPrivateCall(native,new NodeVision());
  const profiles=new ProfileEngine((operation,args,options)=>{
    const requested=Number(args.providerTimeoutMs);
    const timeoutMs=Number.isInteger(requested)&&requested>0?Math.min(requested+2000,600000):
      operation==='ui.tree'||operation==='ui.find'||operation==='ui.get'?8000:60000;
    return call(operation,args,{timeoutMs,signal:options?.signal});
  },profilesPath);
  const agent=new AgentApi(native,profiles);
  const recorder=process.env.DP_REPLAY_RECORD_DIR
    ?await ReplayRecorder.create(process.env.DP_REPLAY_RECORD_DIR):undefined;
  if (recorder) process.stderr.write(`DesktopPilot Replay recording: ${recorder.path}\n`);
  await serveStdio(()=>createServer(agent,hello.preflight,recorder));
} catch(error) {
  process.stderr.write(`DesktopPilot failed to start: ${error instanceof Error?error.message:String(error)}\n`);
  native.close();process.exitCode=1;
}
