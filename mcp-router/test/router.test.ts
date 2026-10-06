import assert from 'node:assert/strict';
import test from 'node:test';
import type {CallToolResult, Tool} from '@modelcontextprotocol/sdk/types.js';
import {Router, type Ranking, type Upstream} from '../src/router.js';
import {createJevRanker} from '../src/jev.js';

const tool:Tool={name:'read',description:'Read one issue.',inputSchema:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}};
function upstream(name:string):Upstream & {calls:unknown[]} {
  const calls:unknown[]=[];
  return {name,calls,list:async cursor=>cursor?{tools:[{...tool,name:'write'}]}:{tools:[tool],nextCursor:'p2'},
    call:async (name,args,meta)=>{calls.push({name,args,meta});return {isError:true,content:[{type:'text',text:'upstream failure'}],structuredContent:{id:args.id}};},close:async()=>{}};
}
const ranking:Ranking={scores:[.75,.74,.9,.1],mode:'live',model:'jev',usage:{input_tokens:100,output_tokens:10}};

test('pages all upstreams, preserves duplicate names, thresholds and caches query ranking',async()=>{
  let invocations=0;
  const router=await Router.open([upstream('a'),upstream('b')],async(query,tools)=>{assert.equal(query,'read issue');assert.equal(tools.length,4);invocations++;return ranking;});
  assert.equal(new Set(router.tools.map(t=>t.id)).size,4);
  const result=await router.search(' read issue ');
  assert.deepEqual(result.matches.map(m=>m.probability),[.9,.75]);
  assert.equal(result.matches[0]?.server,'b');
  assert.equal(result.cached,false);
  assert.equal((await router.search('read issue')).cached,true);
  assert.equal(invocations,1);
  assert.equal(router.describe([router.tools[0]!.id])[0]?.inputSchema,tool.inputSchema);
  await router.close();
});

test('validates the original schema before dispatch and preserves upstream result and metadata',async()=>{
  const source=upstream('a');
  const router=await Router.open([source],async()=>({...ranking,scores:[0,0]}));
  const id=router.tools[0]!.id;
  await assert.rejects(router.call(id,{id:42}),/Invalid arguments/);
  await assert.rejects(router.call(id,{id:'X',extra:true}),/Invalid arguments/);
  await assert.rejects(router.call('unknown',{id:'X'}),/Unknown tool/);
  assert.equal(source.calls.length,0);
  const result=await router.call(id,{id:'X'},{trace:'opaque'});
  assert.equal(result.isError,true);
  assert.deepEqual(result.structuredContent,{id:'X'});
  assert.deepEqual(source.calls,[{name:'read',args:{id:'X'},meta:{trace:'opaque'}}]);
  assert.deepEqual((await router.search('unrelated')).matches,[]);
  assert.equal(router.describe([id]).length,1);
  await router.close();
});

test('invalid Jev replies fail and failed searches are retried',async()=>{
  let count=0;
  const router=await Router.open([upstream('a')],async()=>({...ranking,scores:++count===1?[NaN,0]:[.8,0]}));
  await assert.rejects(router.search('read'),/Invalid ranking/);
  assert.equal((await router.search('read')).matches.length,1);
  assert.equal(count,2);
  await router.close();
});

test('Jev adapter sends only routing metadata and retains usage',async()=>{
  const rank=createJevRanker({systemOne:async request=>{
    assert.deepEqual(request.state,{task:'read issue'});
    assert.equal(JSON.stringify(request).includes('inputSchema'),false);
    return {model:'jev-test',usage:{input_tokens:123,output_tokens:4},answers:{t0:{type:'noul',noul:.8}}};
  }});
  const result=await rank('read issue',[{...tool,id:'["a","read"]',server:'a'}]);
  assert.deepEqual(result.scores,[.8]);
  assert.equal(result.usage?.input_tokens,123);
});
