import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {fixture,payload} from '../codex/fixture.js';
import {gradeCompletion,type Call,type Task,type Usage} from '../codex/support.js';
import type {AgentEvent,Arm} from './support.js';

const root=fileURLToPath(new URL('./',import.meta.url));
const tasks=JSON.parse(await readFile(join(root,'../cases.json'),'utf8')) as Task[];
const catalog=JSON.parse(await readFile(join(root,'../catalog.json'),'utf8')) as {tools:{id:string}[]};
const jev=JSON.parse(await readFile(join(root,'../results/jev-runs.json'),'utf8')) as {caseId:string;scores:number[];usage:{input_tokens:number}}[];
interface Row {caseId:string;arm:Arm;repeatCount:number;selected:string[];status:string;metadata:Record<string,unknown>;initialTools:{function:{name:string}}[];usageSamples:Usage[];calls:Call[];turns:{answer:string;grade:ReturnType<typeof gradeCompletion>}[];events:AgentEvent[];jevCostUsd:number}
const report=JSON.parse(await readFile(join(root,'results/report.json'),'utf8')) as {subset:string[];rows:Row[];long:Row[]};
const main=report.rows.filter(r=>r.arm!=='eager');
assert.equal(main.length,28);
assert.equal(new Set(main.map(r=>`${r.caseId}-${r.arm}`)).size,28);
for(const id of report.subset)for(const arm of ['native','jev'])assert.ok(main.some(r=>r.caseId===id&&r.arm===arm));
assert.equal(report.long.length,2);
const receipts=new Set<string>();
let modelRequests=0,fixtureCalls=0,auxiliaryRequests=0,searchCalls=0;
for(const row of [...main,...report.long]) {
  assert.equal(row.status,'completed');
  assert.equal(row.metadata.model,'glm-5.3-flash');
  assert.equal(row.metadata.isolated,true);
  assert.equal(row.metadata.auxiliaryUsageObserved,true);
  const saved=jev.find(r=>r.caseId===row.caseId)!;
  const selection=catalog.tools.filter((_,i)=>row.arm==='native'||saved.scores[i]!>=.75).map(t=>t.id);
  assert.deepEqual(row.selected,selection);
  assert.equal(row.metadata.fixtureCount,selection.length);
  assert.deepEqual(new Set(row.initialTools.map(t=>t.function.name)),new Set(row.arm==='native'?['tool_search','tool_describe','tool_call']:selection.map(id=>`mcp__${id.replace('.','__')}`)));
  assert.equal(row.jevCostUsd,row.arm==='jev'?saved.usage.input_tokens*.042/1e6:0);
  assert.equal(row.turns.length,row.repeatCount);
  assert.equal(row.repeatCount,report.long.includes(row)?5:1);
  const task=tasks.find(t=>t.id===row.caseId)!;
  for(const call of row.calls) {
    assert.ok(selection.includes(call.id));
    const expected=fixture(task,call.id,call.args);
    assert.equal(call.valid,expected.valid);
    assert.equal(call.fact,expected.fact);
    assert.ok(!receipts.has(call.receipt));receipts.add(call.receipt);
    fixtureCalls++;
    // Ensure the retained tool results carry the runner's receipt, not model-invented data.
    const text=JSON.stringify(row.events.filter(e=>e.event==='turn'));
    assert.ok(text.includes(call.receipt));
    assert.equal(payload(call).receipt,call.receipt);
  }
  let callBoundary=0,executed=0,turnIndex=0;
  for(const event of row.events) {
    if(event.event==='call')executed++;
    if(event.event==='usage') {
      assert.equal(event.servedModel,'glm-5.3-flash');modelRequests++;
      const u=event.usage;
      for(const value of Object.values(u))assert.ok(Number.isFinite(value)&&value>=0);
      assert.ok(u.cachedInputTokens+(u.cacheWriteInputTokens??0)<=u.inputTokens);
      assert.ok(u.reasoningOutputTokens<=u.outputTokens);
    }
    if(event.event==='aux_usage')auxiliaryRequests++;
    if(event.event==='turn') {
      assert.deepEqual(row.turns[turnIndex]!.grade,gradeCompletion(task,row.calls.slice(callBoundary,executed),event.answer));
      callBoundary=executed;
      turnIndex++;
    }
  }
  assert.deepEqual(row.usageSamples,row.events.filter((e):e is Extract<AgentEvent,{event:'usage'}>=>e.event==='usage').map(e=>e.usage));
  const final=row.events.filter((e):e is Extract<AgentEvent,{event:'turn'}>=>e.event==='turn').at(-1)!;
  searchCalls+=final.messages.reduce((sum,message)=>sum+((message.tool_calls??[]) as {function?:{name?:string}}[]).filter(c=>c.function?.name==='tool_search').length,0);
}
const summary={status:'PASS',mainRuns:main.length,longRuns:report.long.length,userTurns:main.length+10,modelRequests,fixtureCalls,auxiliaryRequests,searchCalls};
await writeFile(join(root,'results/audit.json'),JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary));
