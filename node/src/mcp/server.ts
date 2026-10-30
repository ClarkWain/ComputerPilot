import { readFile } from 'node:fs/promises';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import tools from './tools.json' with { type: 'json' };
import { operationFailed, type AgentApi } from '../agent/api.js';
import type { JsonObject } from '../native/client.js';
import { acquireDesktopLock } from '../replay/lock.js';
import type { ReplayRecorder } from '../replay/record.js';

export const publicTools = tools;

function inlineCapture(value: JsonObject): JsonObject | undefined {
  let cursor=value;
  for(let depth=0;depth<8;depth++) {
    if(cursor.failure && typeof cursor.failure==='object') cursor=cursor.failure as JsonObject;
    else break;
  }
  const capture:JsonObject=cursor.capture && typeof cursor.capture==='object'?cursor.capture as JsonObject:cursor;
  if(capture.delivery==='inline' && typeof capture.path==='string' && typeof capture.imageRef==='string') return capture;
  return undefined;
}

export function createServer(agent: AgentApi, preflight?: JsonObject, recorder?: ReplayRecorder): McpServer {
  const serverInfo={name:'desktop-pilot',version:'0.4.0',
    _meta:{'desktopPilot/desktopPreflight':preflight??{}}};
  const server=new McpServer(serverInfo, {
    instructions:'DesktopPilot must run in the same Windows session and input desktop as the target app. If preflight.ready is false, correct launch context. Use list_windows, get_window_state, then execute_semantic for a matching profile or execute_batch. Tool JSON is in structuredContent; content carries images only. Remote hosts need image_delivery:inline with mode:image or both. Inspect completed, failedIndex and dispatch before another action. References are worker-generation-local; do not replay uncertain input. Startup desktopPreflight: '+JSON.stringify(preflight??{})
  });
  for(const tool of publicTools) {
    server.registerTool(tool.name, {
      description:tool.description,
      inputSchema:fromJsonSchema<JsonObject>(tool.inputSchema as unknown as Parameters<typeof fromJsonSchema>[0]),
      annotations:tool.annotations
    }, async (args, context) => {
      let release:(()=>Promise<void>)|undefined;
      try {
        if(tool.name==='execute_semantic'||tool.name==='execute_batch'||tool.name==='get_window_state')
          release=await acquireDesktopLock();
      } catch(error) {
        return {content:[],structuredContent:{status:'error',code:'desktop_busy',dispatch:'not_started',
          message:error instanceof Error?error.message:String(error)},isError:true};
      }
      let value:JsonObject,recordingId:string|undefined;
      try {
        if(recorder && (tool.name==='execute_semantic'||tool.name==='execute_batch'))
          recordingId=await recorder.intent(tool.name,args);
      } catch(error) {
        await release?.();
        return {content:[],structuredContent:{status:'error',code:'recording_failed',dispatch:'not_started',
          message:error instanceof Error?error.message:String(error)},isError:true};
      }
      try { value=await agent.call(tool.name,args, { signal:context.mcpReq.signal }); }
      finally { await release?.(); }
      recorder?.observe(tool.name,args,value);
      if (recordingId) {
        try {await recorder!.receipt(recordingId,value);}
        catch(error) {return {content:[],structuredContent:{status:'error',code:'recording_failed_after_dispatch',
          dispatch:'unknown',message:error instanceof Error?error.message:String(error),actionResult:value},isError:true};}
      }
      const content: Array<{type:'image';mimeType:string;data:string}> = [];
      if(tool.name==='get_window_state'||tool.name==='execute_semantic') {
        const capture=inlineCapture(value);
        if(capture) {
          try { content.push({type:'image',mimeType:typeof capture.mimeType==='string'?capture.mimeType:'image/png',
            data:(await readFile(capture.path as string)).toString('base64')}); }
          catch(error) { return {content:[],structuredContent:{...value,status:'error',code:'image_read_failed',
            message:String(error),actionResult:value,
            ...(tool.name==='execute_semantic' && value.dispatch===undefined?{dispatch:'unknown'}:{})},isError:true}; }
        }
      }
      return {content,structuredContent:value,isError:operationFailed(value)};
    });
  }
  return server;
}
