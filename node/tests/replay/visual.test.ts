import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { checkCapture, waitForStableImage } from '../../src/replay/visual.js';
import type { JsonObject } from '../../src/native/client.js';

test('capture uses a visible control and DPI inset, then compares the image',async()=>{
  const root=await mkdtemp(join(tmpdir(),'dp-visual-'));
  try {
    await mkdir(join(root,'assets'));
    const bytes=Buffer.alloc(2*2*3,255);
    await sharp(bytes,{raw:{width:2,height:2,channels:3}}).png().toFile(join(root,'assets','reference.png'));
    const capturePath=join(root,'assets','reference.png');
    let region:JsonObject={};
    const api={async call(tool:string,args:JsonObject):Promise<JsonObject>{
      assert.equal(tool,'get_window_state');region=args.region as JsonObject;
      return {status:'ok',capture:{path:capturePath}};
    }};
    const state:JsonObject={layout:{displayDpi:144},size:{width:1600,height:1000},
      controls:[{name:'画布',role:'Pane',bounds:[30,249,900,800]}]};
    const condition={anchor:{nameContains:'画布',role:'Pane',inset:{x:3,y:5,unit:'dip96' as const}},
      width:2,height:2,savePath:'stage.png',
      reference:{asset:'assets/reference.png',channelTolerance:0,maxChangedPercent:0}};
    await checkCapture(api,'w1',state,condition,root,root);
    assert.deepEqual(region,{x:35,y:257,width:2,height:2});
    assert.deepEqual(await readFile(join(root,'stage.png')),await readFile(capturePath));
    const bad={...condition,anchor:{...condition.anchor,nameContains:'missing'}};
    await assert.rejects(checkCapture(api,'w1',state,bad,root,root),/anchor must match one/);
    await sharp(Buffer.alloc(2*2*3,0),{raw:{width:2,height:2,channels:3}})
      .png().toFile(join(root,'assets','wrong.png'));
    await assert.rejects(checkCapture(api,'w1',state,{...condition,
      reference:{...condition.reference,asset:'assets/wrong.png'}},root,root),/changed|difference|reference/i);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('visual settling requires repeated identical observations',async()=>{
  let polls=0;
  const api={async call():Promise<JsonObject>{
    polls++;
    return {status:'ok',capture:{imageRef:polls===1?'first':'stable'}};
  }};
  const result=await waitForStableImage(api,'w1',{mode:'image',quietMs:50,pollMs:25,timeoutMs:500});
  // A delayed timer can satisfy quietMs on the first repeated stable image.
  assert.ok(result.polls>=3);
  assert.ok(result.elapsedMs>=50);
});
