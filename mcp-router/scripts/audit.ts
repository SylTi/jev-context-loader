import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {catalog,jev,projectRoot,taskFor} from './fixtures.js';
import {contextTokens,glmCost,replayCosts,type OpenCodeTokens} from './metrics.js';
import {gradeCompletion,type Call} from '../benchmarks/mcp-discovery/codex/support.js';

interface Message {type:string;agent?:string;error?:unknown;tokens?:OpenCodeTokens;model?:{id:string;providerID:string};content?:{type:string;name?:string}[]}
interface Run {
  caseId:string;arm:string;status:string;model:string;code:number;calls:Call[];answer:string;
  events:Message[];usage:{tokens:OpenCodeTokens;model:{id:string;providerID:string}}[];
  fixtureEvents:{event:string;query?:string;replayConditioningTask?:string;call?:Call}[];
  grade:ReturnType<typeof gradeCompletion>;modelCostUsd:number|null;jevCostUsd:number;totalCostUsd:number|null;
  config:{permissions:{action:string;resource:string;effect:string}[];mcp:{servers:Record<string,unknown>}};
  registrySnapshots:{id:string;permissions:{action:string;resource:string;effect:string}[]}[][];
  mcpSnapshots:{data?:{name:string;status:{status:string}}[]}[];
}
const ids=process.argv[2]?.split(',')??['h01','h04','h07','h16','h17','h21','h22','h24','h25','h29','h31','h34','h37','h39'];
const directory=join(projectRoot,'results/opencode');
const failures:string[]=[],rows:unknown[]=[];
for(const id of ids)for(const arm of ['native','jev']) {
  try {
    const run=JSON.parse(await readFile(join(directory,`${id}-${arm}.json`),'utf8')) as Run;
    assert.equal(run.caseId,id);assert.equal(run.arm,arm);assert.equal(run.status,'completed');assert.equal(run.code,0);
    assert.equal(run.model,'zai-coding-plan/glm-5.3-flash');
    assert.ok(run.usage.length>0);
    const assistants=run.events.filter(e=>e.type==='assistant');
    assert.equal(assistants.length,run.usage.length,'Every assistant request must report usage');
    for(const message of assistants){assert.equal(message.agent,'benchmark');assert.ok(!message.error);}
    for(const usage of run.usage) {
      assert.equal(usage.model.id,'glm-5.3-flash');assert.equal(usage.model.providerID,'zai-coding-plan');
      for(const n of [usage.tokens.input,usage.tokens.output,usage.tokens.reasoning,usage.tokens.cache.read,usage.tokens.cache.write])assert.ok(Number.isFinite(n)&&n>=0);
    }
    // Diagnostic for the observed preview-runtime startup race, not a tokenizer estimate.
    // Empty catalog requests had 272-276 tokens (bridge) or 626 (Code Mode).
    assert.ok(contextTokens(run.usage[0]!.tokens)>=(arm==='native'?2000:500),'Missing-catalog startup attempt; exclude and retain separately');
    assert.deepEqual(Object.keys(run.config.mcp.servers),['fixture']);
    assert.deepEqual(run.config.permissions[0],{action:'*',resource:'*',effect:'deny'});
    const registered=run.registrySnapshots.flat().filter(a=>a.id==='benchmark').at(-1);
    assert.ok(registered?.permissions.some(r=>r.action==='*'&&r.resource==='*'&&r.effect==='deny'));
    assert.ok(run.mcpSnapshots.some(s=>s.data?.some(m=>m.name==='fixture'&&m.status.status==='connected')));
    const toolNames=assistants.flatMap(m=>m.content??[]).filter(c=>c.type==='tool').map(c=>c.name!);
    assert.ok(toolNames.every(name=>name.startsWith('fixture_')||arm==='native'&&name==='execute'),'Unexpected non-fixture tool');
    assert.ok(run.calls.every(call=>catalog.tools.some(t=>t.id===call.id)));
    assert.deepEqual(run.calls,run.fixtureEvents.filter(e=>e.event==='fixture').map(e=>e.call));
    const grade=gradeCompletion(taskFor(id),run.calls,run.answer);
    assert.deepEqual(run.grade,grade);assert.deepEqual(grade.forbidden,[],'Unrequested fixture writes');
    const searches=run.fixtureEvents.filter(e=>e.event==='search');
    assert.ok(searches.every(s=>s.replayConditioningTask===taskFor(id).task));
    const routingFee=arm==='jev'&&searches.length?jev.find(r=>r.caseId===id)!.usage.input_tokens*.042/1e6:0;
    assert.equal(run.jevCostUsd,routingFee);
    const modelCost=glmCost(run.usage.map(u=>u.tokens));
    assert.notEqual(modelCost,null);assert.equal(run.modelCostUsd,modelCost);
    assert.equal(run.totalCostUsd,modelCost!+routingFee);
    const estimates=replayCosts(modelCost,jev.find(r=>r.caseId===id)!.usage.input_tokens,searches.length);
    rows.push({caseId:id,arm,pass:grade.pass,modelRequests:run.usage.length,fixtureCalls:run.calls.length,
      firstContextTokens:contextTokens(run.usage[0]!.tokens),peakContextTokens:Math.max(...run.usage.map(u=>contextTokens(u.tokens))),
      totalCostUsd:run.totalCostUsd,...estimates,searches:searches.length,toolNames});
  }catch(error){failures.push(`${id}/${arm}: ${error instanceof Error?error.message:String(error)}`);}
}
const hashes:Record<string,string>={};
for(const folder of ['src','scripts'])for(const file of await readdir(join(projectRoot,folder)))if(file.endsWith('.ts')) {
  hashes[`${folder}/${file}`]=createHash('sha256').update(await readFile(join(projectRoot,folder,file))).digest('hex');
}
const result={passed:failures.length===0,expectedRuns:ids.length*2,auditedRuns:rows.length,catalogHash:catalog.catalogHash,
  failures,rows,auditTimeSourceHashes:hashes,
  limitations:['Source hashes describe audit-time files, not a captured provider request body.',
    'Tool-less startup exclusions use observed token counts plus transcripts; outgoing tool definitions were not intercepted.',
    'Usage covers retained assistant turns. Hidden provider retries and auxiliary requests are not independently measured.',
    'Jev scores and routing fees are frozen task-level replay, not fresh inference.']};
await writeFile(join(directory,'audit.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({passed:result.passed,auditedRuns:rows.length,expectedRuns:result.expectedRuns,failures},null,2));
if(failures.length)process.exitCode=1;
