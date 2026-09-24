import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { JsonObject } from '../native/client.js';
import { assetPath, compareImageReference, type ReplayCapture, type ReplayStep } from './recipe.js';

export type VisualApi = { call(tool:string,args:JsonObject):Promise<JsonObject> };
const object=(value:unknown):JsonObject=>value && typeof value==='object' && !Array.isArray(value)
  ? value as JsonObject : {};
const controls=(value:unknown):JsonObject[]=>Array.isArray(value)
  ? value.filter(item=>item && typeof item==='object' && !Array.isArray(item)) as JsonObject[] : [];

export async function checkCapture(api:VisualApi,windowId:string,state:JsonObject,capture:ReplayCapture,
  runDirectory:string,sourceDirectory:string):Promise<void> {
  const matches=controls(state.controls).filter(control=>
    String(control.name??'').includes(capture.anchor.nameContains) && control.role===capture.anchor.role &&
    control.enabled!==false && control.offscreen!==true);
  if (matches.length!==1) throw new Error(`Capture anchor must match one visible control; found ${matches.length}`);
  const bounds=matches[0].bounds;
  if (!Array.isArray(bounds) || bounds.length!==4) throw new Error('Capture anchor has no bounds');
  const dpi=Number(object(state.layout).displayDpi);
  if (capture.anchor.inset.unit==='dip96' && (!Number.isFinite(dpi)||dpi<=0))
    throw new Error('Capture anchor display DPI is unknown');
  const scale=capture.anchor.inset.unit==='dip96'?dpi/96:1;
  const x=Number(bounds[0])+Math.round(capture.anchor.inset.x*scale);
  const y=Number(bounds[1])+Math.round(capture.anchor.inset.y*scale);
  const size=object(state.size);
  if (!Number.isInteger(x)||!Number.isInteger(y)||x<0||y<0||
    x+capture.width>Number(size.width)||y+capture.height>Number(size.height))
    throw new Error('Capture region is outside the observed window');
  const image=await api.call('get_window_state',{window_id:windowId,mode:'image',
    region:{x,y,width:capture.width,height:capture.height},image_delivery:'path'});
  if (image.status!=='ok') throw new Error(`Capture failed: ${JSON.stringify(image)}`);
  const path=String(object(image.capture).path??'');
  if (!path) throw new Error('Capture returned no image path');
  if (capture.savePath) {
    const output=assetPath(runDirectory,capture.savePath);
    await mkdir(dirname(output),{recursive:true});
    await copyFile(path,output);
  }
  if (capture.reference) await compareImageReference(path,assetPath(sourceDirectory,capture.reference.asset),
    capture.reference,capture.savePath??capture.reference.asset);
}

export async function waitForStableImage(api:VisualApi,windowId:string,settle:NonNullable<ReplayStep['settle']>):
  Promise<{polls:number;elapsedMs:number}> {
  const start=Date.now(),deadline=start+settle.timeoutMs;
  let last='',sameSince=0,polls=0;
  while (Date.now()<deadline) {
    const state=await api.call('get_window_state',{window_id:windowId,mode:'image',max_edge:800,
      image_delivery:'path'});
    if (state.status!=='ok') throw new Error(`Visual settling failed: ${JSON.stringify(state)}`);
    const ref=String(object(state.capture).imageRef??'');
    if (!ref) throw new Error('Visual settling has no image identity');
    polls++;
    if (ref!==last) {last=ref;sameSince=Date.now();}
    else if (Date.now()-sameSince>=settle.quietMs)
      return {polls,elapsedMs:Date.now()-start};
    await delay(Math.min(settle.pollMs,Math.max(1,deadline-Date.now())));
  }
  throw new Error(`Visual settling timed out after ${polls} observations`);
}
