import { NativeCallError, type JsonObject, type NativeCallOptions } from '../native/client.js';

export type NativeGateway = { call(operation:string,args?:JsonObject,options?:NativeCallOptions):Promise<JsonObject> };
export type VisionGateway = { call(operation:string,args:JsonObject,signal?:AbortSignal):Promise<JsonObject> };

/** Node business operations stay in process; only Windows platform operations cross JSONL. */
export function createPrivateCall(native:NativeGateway, vision:VisionGateway) {
  return async (operation:string,args:JsonObject={},options:NativeCallOptions={}):Promise<JsonObject> => {
    if (options.signal?.aborted) return new NativeCallError('cancelled','Request cancelled before dispatch','not_started').toResult();
    if (operation==='vision.ocr'||operation==='vision.parse') {
      try {
        const value=await vision.call(operation,args,options.signal);
        if (options.signal?.aborted) return new NativeCallError('cancelled','Request cancelled during vision operation','not_started').toResult();
        return value;
      } catch(error) {
        if (options.signal?.aborted) return new NativeCallError('cancelled','Request cancelled during vision operation','not_started').toResult();
        return {status:'error',code:error instanceof TypeError||error instanceof RangeError?'invalid_arguments':'vision_operation_failed',
          message:error instanceof Error?error.message:String(error),dispatch:'not_started'};
      }
    }
    return native.call(operation,args,options);
  };
}
