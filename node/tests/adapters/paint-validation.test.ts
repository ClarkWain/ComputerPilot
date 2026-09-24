import test from 'node:test';
import assert from 'node:assert/strict';
import { ProfileEngine } from '../../src/profiles/engine.js';
import { runClassic } from '../../src/adapters/classic-paint.js';
import { runModern } from '../../src/adapters/modern-paint.js';

test('classic Paint validates the whole batch before desktop access', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('mspaint-classic-zh-CN');
  let calls = 0;
  const result = await runClassic(async () => { calls++; return {}; }, 'w1', profile, [
    { action: 'drawing.drawCircle', args: { center: [100, 100], radius: 20 } },
    { action: 'drawing.drawPolygon', args: { points: [[1, 1], [2, 2], [3, 3]] } }
  ]);
  assert.equal(result.dispatch, 'not_started');
  assert.equal(result.completed, 0);
  assert.equal(calls, 0);
});

test('classic Paint refreshes enabled ribbon controls and clicks the fill popup in its own window', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('mspaint-classic-zh-CN');
  const element = (name: string, role: string, elementRef: string, enabled = true) =>
    ({ name, role, elementRef, enabled, bounds: { x: 0, y: 0, width: 30, height: 30 } });
  const base = [element('100%', 'Text', 'zoom'), element('画布', 'Pane', 'canvas'),
    element('椭圆形', 'ListItem', 'ellipse'), element('矩形', 'ListItem', 'rectangle'),
    element('铅笔', 'Button', 'commit')];
  const tree = (elements: unknown[]) => ({status:'ok',elements,stopReason:'complete',
    truncated:false,has_more:false,evidenceComplete:true});
  const initial = tree([...base, element('填充','50031','fill',false)]);
  const refreshed = tree([...base, element('填充','50031','fill')]);
  const window = {windowRef:'main',pid:42,enabled:true,foreground:true,minimized:false,dpi:144,
    bounds:{x:0,y:0,width:1650,height:1031}};
  let selected=false,popup=false,refreshedReads=0,popupClick=false;
  const result=await runClassic(async(op,args) => {
    if(op==='system.session') return {inputDesktopAccessible:true,lockState:'unlocked'};
    if(op==='window.get') return window;
    if(op==='ui.get') return {bounds:args.elementRef==='canvas'
      ?{x:0,y:0,width:603,height:696}:{x:0,y:0,width:30,height:30}};
    if(op==='input.click') { if(!selected)selected=true;else popup=true;return {status:'ok'}; }
    if(op==='ui.tree') {
      if(args.windowRef==='main') {refreshedReads++;return refreshed;}
      return tree([element('纯色','MenuItem','solid')]);
    }
    if(op==='window.list') return {windows:[window,...(popup
      ?[{windowRef:'fill-menu',foreground:true,enabled:true,visible:true}]:[])]};
    if(op==='ui.click') {popupClick=args.windowRef==='fill-menu'&&args.elementRef==='solid';
      return {status:'error',message:'diagnostic stop after verified popup click'};}
    throw new Error(`Unexpected operation: ${op}`);
  },'main',profile,[{action:'drawing.drawRectangle',args:{position:[30,40],size:[80,40],fill:[255,0,0]}}],initial);
  assert.equal(refreshedReads,1);
  assert.equal(popupClick,true);
  assert.match(result.message,/diagnostic stop after verified popup click/);
});

test('modern Paint validates width and path before desktop access', async () => {
  const profile = await new ProfileEngine(async () => ({})).load('mspaint-modern-zh-CN');
  let calls = 0;
  const result = await runModern(async () => { calls++; return {}; }, 'w1', profile, [
    { action: 'drawing.selectBrush', args: { brush: 'brush' } },
    { action: 'drawing.drawPolyline', args: { points: [[1, 1], [1, 1]],
      stroke: { color: [1, 2, 3], width: 7 } } }
  ]);
  assert.equal(result.dispatch, 'not_started');
  assert.equal(result.completed, 0);
  assert.equal(calls, 0);
});
