import test from 'node:test';
import assert from 'node:assert/strict';

const { mergeObservation } = await import(new URL('../../../../examples/onboarding/merge-observation.mjs',import.meta.url).href);
const full = () => ({status:'ok',window_id:'w',title:'Before',foreground:true,coordinateSpace:'image_pixels',
  inputSize:{width:400,height:300},controls:[{control_id:'a',name:'Title',value:'old',enabled:false},
    {control_id:'b',name:'Removed'}],semantic:{profiles:[{id:'test'}]},
  capture:{path:'full.png',width:400,height:300},change:{kind:'full',reason:'initial'}});

test('delta example merges top-level metadata and preserves unchanged fields without mutating its baseline',()=>{
  const previous=full();
  const updated=mergeObservation(previous,{status:'ok',window_id:'w',change:{kind:'delta'},
    window:{set:{title:'After'},unset:['foreground']},controls:{removed:['b'],
      updated:[{control_id:'a',set:{value:'new'},unset:['enabled']}],added:[{control_id:'c',name:'Added'}]}});
  assert.equal(updated.title,'After');assert.equal('foreground' in updated,false);
  assert.deepEqual(updated.controls,[{control_id:'a',name:'Title',value:'new'},{control_id:'c',name:'Added'}]);
  assert.deepEqual(updated.semantic,previous.semantic);assert.equal(updated.coordinateSpace,'image_pixels');
  assert.equal(previous.title,'Before');assert.equal(previous.controls[0].value,'old');
  const unchanged=mergeObservation(updated,{status:'ok',window_id:'w',change:{kind:'unchanged'}});
  assert.deepEqual(unchanged.controls,updated.controls);assert.equal(unchanged.capture.path,'full.png');
});

test('delta example keeps full-frame coordinates and patch location without composing pixels',()=>{
  const patch={kind:'patch',path:'patch.png',fullPath:'new-full.png',rect:{x:100,y:80,width:20,height:20},
    frame:{width:400,height:300},width:20,height:20};
  const state=mergeObservation(full(),{status:'ok',window_id:'w',change:{kind:'delta'},capture:patch});
  assert.deepEqual(state.capture,patch);assert.deepEqual(state.inputSize,{width:400,height:300});
  assert.equal(state.coordinateSpace,'image_pixels');
});

test('delta example rejects lost baselines and unknown controls and resets from full state',()=>{
  const delta={status:'ok',window_id:'w',change:{kind:'delta'},controls:{updated:[{control_id:'missing',set:{value:'x'}}]}};
  assert.throws(()=>mergeObservation(undefined,delta),/baseline/);
  assert.throws(()=>mergeObservation({...full(),window_id:'other'},delta),/baseline/);
  assert.throws(()=>mergeObservation(full(),delta),/Unknown updated/);
  assert.throws(()=>mergeObservation(full(),{status:'error',code:'worker_closed'}),/failed/);
  const reset={...full(),title:'Reset',controls:[],change:{kind:'full',reason:'worker_changed'}};
  assert.deepEqual(mergeObservation(full(),reset),reset);
});
