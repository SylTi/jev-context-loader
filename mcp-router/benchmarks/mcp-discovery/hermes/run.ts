import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {fixture,payload} from '../codex/fixture.js';
import {schemaFromDeclaration,gradeCompletion,type Usage,type Task,type Call} from '../codex/support.js';
import {selectTools,fixtureId,apiCost,type Arm,type Tool,type AgentEvent,type AgentInput} from './support.js';

const root=fileURLToPath(new URL('./',import.meta.url));
const parent=fileURLToPath(new URL('../',import.meta.url));
const subset=['h01','h04','h07','h16','h17','h21','h22','h24','h25','h29','h31','h34','h37','h39'];
const catalog=JSON.parse(await readFile(join(parent,'catalog.json'),'utf8')) as {catalogHash:string;tools:{id:string;description:string;definition:string}[]};
const tasks=JSON.parse(await readFile(join(parent,'cases.json'),'utf8')) as Task[];
const jev=JSON.parse(await readFile(join(parent,'results/jev-runs.json'),'utf8')) as {caseId:string;scores:number[];evaluationTimeMs:number;usage:{input_tokens:number}}[];
const tools:Tool[]=catalog.tools.map(t=>({id:t.id,name:`mcp__${t.id.replace('.','__')}`,description:t.description,inputSchema:schemaFromDeclaration(t.definition)}));
const instructions='Complete the user task using the available fixture tools. All tools operate on synthetic local data; their names and descriptions retain their normal meaning. Do not use shell, files, browser, other services or skill discovery. Do not invent missing data. For each requested read, include its returned fixtureFact verbatim in your answer. Finish with JSON {"answer":string,"receipts":string[]} containing receipts from results actually used. If a required capability is unavailable, say so. Perform requested writes only; do not substitute a different provider. Do not ask the user for confirmation in this fixture experiment.';
const target=process.env.HERMES_SSH_TARGET;
const remoteDir=process.env.HERMES_BENCH_DIR;
const hermesRoot=process.env.HERMES_SOURCE_ROOT;
const profileHome=process.env.HERMES_PROFILE_HOME;
const python=process.env.HERMES_PYTHON;
const quote=(s:string)=>`'${s.replaceAll("'","'\\''")}'`;

interface Run {caseId:string;arm:Arm;repeatCount:number;selected:string[];status:string;metadata?:Record<string,unknown>;initialTools:Record<string,unknown>[];usageSamples:Usage[];auxiliaryUsage:{usage:Usage;task:string|null;model:string}[];calls:Call[];turns:{answer:string;grade:ReturnType<typeof gradeCompletion>}[];events:AgentEvent[];elapsedMs:number;costUsd:number|null;mainModelCostUsd:number|null;jevCostUsd:number;jevEvaluationTimeMs:number;error?:string}

async function run(task:Task,arm:Arm,repeatCount=1):Promise<Run> {
  if(!target||!remoteDir||!hermesRoot||!profileHome||!python)throw new Error('Set HERMES_SSH_TARGET, HERMES_BENCH_DIR, HERMES_SOURCE_ROOT, HERMES_PROFILE_HOME and HERMES_PYTHON; see README.');
  const j=jev.find(r=>r.caseId===task.id)!;
  const selected=selectTools(tools,arm,j.scores);
  const allowed=new Set(selected.map(t=>t.id));
  const record:Run={caseId:task.id,arm,repeatCount,selected:selected.map(t=>t.id),status:'pending',initialTools:[],usageSamples:[],auxiliaryUsage:[],calls:[],turns:[],events:[],elapsedMs:0,costUsd:null,mainModelCostUsd:null,jevCostUsd:arm==='jev'?j.usage.input_tokens*.042/1e6:0,jevEvaluationTimeMs:arm==='jev'?j.evaluationTimeMs:0};
  const input:AgentInput={arm,tools:selected,instructions,prompts:Array.from({length:repeatCount},(_,i)=>task.task+(i?'\nRe-read the current provider state; do not reuse previous tool results.':''))};
  await mkdir(join(root,'results'),{recursive:true});
  const suffix=repeatCount>1?'-long':'';
  const path=join(root,'results',`${task.id}-${arm}${suffix}`);
  const journal=createWriteStream(`${path}.events.jsonl`);
  const command=[python,'-I',join(remoteDir,'agent.py'),'--hermes-root',hermesRoot,'--profile-home',profileHome].map(quote).join(' ');
  const child=spawn('ssh',['-o','BatchMode=yes',target,command],{stdio:['pipe','pipe','pipe']});
  const started=Date.now();let stderr='',callBoundary=0;
  const lines=createInterface({input:child.stdout});
  const timeout=setTimeout(()=>{record.error='Benchmark process timeout';child.kill();},(repeatCount+1)*180000);
  child.stderr.on('data',(chunk:Buffer)=>{stderr+=chunk.toString();});
  lines.on('line',line=>{
    let event:AgentEvent;
    try {event=JSON.parse(line) as AgentEvent;}catch {record.error='Invalid adapter JSON';child.kill();return;}
    record.events.push(event);
    journal.write(`${JSON.stringify(event)}\n`);
    if(event.event==='ready')console.log(`READY ${task.id} ${arm} visible=${event.tools.length}`);
    if(event.event==='ready'){record.metadata=event.metadata;record.initialTools=event.tools;}
    if(event.event==='usage')record.usageSamples.push(event.usage);
    if(event.event==='aux_usage')record.auxiliaryUsage.push(event);
    if(event.event==='call') {
      try {
        const call=fixture(task,fixtureId(event.name,allowed),event.args);
        record.calls.push(call);child.stdin.write(`${JSON.stringify(payload(call))}\n`);
      }catch(error){record.error=String(error);child.kill();}
    }
    if(event.event==='turn') {
      record.turns.push({answer:event.answer,grade:gradeCompletion(task,record.calls.slice(callBoundary),event.answer)});
      callBoundary=record.calls.length;
      if(!event.completed)record.error=event.error??'Agent turn failed';
    }
    if(event.event==='error')record.error=event.error;
  });
  child.stdin.write(`${JSON.stringify(input)}\n`);
  const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});
  clearTimeout(timeout);lines.close();child.stdin.end();journal.end();
  record.elapsedMs=Date.now()-started;
  record.status=code===0&&!record.error&&record.turns.length===repeatCount?'completed':'error';
  const modelCost=apiCost(record.usageSamples);
  record.mainModelCostUsd=modelCost;
  const auxiliaryCost=record.auxiliaryUsage.length?apiCost(record.auxiliaryUsage.map(a=>a.usage)):0;
  record.costUsd=modelCost===null||auxiliaryCost===null||!record.metadata?.auxiliaryUsageObserved||record.auxiliaryUsage.some(a=>a.model!=='glm-5.3-flash')?null:modelCost+auxiliaryCost+record.jevCostUsd;
  await writeFile(`${path}.json`,JSON.stringify(record,null,2));
  await writeFile(`${path}.stderr.log`,stderr);
  console.log(`DONE ${task.id} ${arm} status=${record.status} pass=${record.turns.length>0&&record.turns.every(t=>t.grade.pass)} requests=${record.usageSamples.length} calls=${record.calls.length} error=${record.error??''}`);
  return record;
}

async function report() {
  const results:Run[]=[];
  function measured(raw:Run):Run {
    const auxiliaryUsage=raw.events.filter((e):e is Extract<AgentEvent,{event:'aux_usage'}>=>e.event==='aux_usage');
    const mainModelCostUsd=apiCost(raw.usageSamples);
    const auxiliaryCost=auxiliaryUsage.length?apiCost(auxiliaryUsage.map(a=>a.usage)):0;
    const costUsd=mainModelCostUsd===null||auxiliaryCost===null||!raw.metadata?.auxiliaryUsageObserved||auxiliaryUsage.some(a=>a.model!=='glm-5.3-flash')?null:mainModelCostUsd+auxiliaryCost+raw.jevCostUsd;
    return {...raw,auxiliaryUsage,mainModelCostUsd,costUsd};
  }
  for(const file of await readdir(join(root,'results')))if(/^h\d+-(native|jev|eager)\.json$/.test(file))results.push(measured(JSON.parse(await readFile(join(root,'results',file),'utf8')) as Run));
  const groups=Object.fromEntries((['native','jev','eager'] as Arm[]).map(arm=>{
    const rows=results.filter(r=>r.arm===arm);const measured=rows.filter(r=>r.usageSamples.length);
    const mean=(f:(r:Run)=>number)=>measured.length?measured.reduce((s,r)=>s+f(r),0)/measured.length:null;
    return [arm,{runs:rows.length,completed:rows.filter(r=>r.status==='completed').length,passed:rows.filter(r=>r.status==='completed'&&r.turns.every(t=>t.grade.pass)).length,usageAvailable:measured.length,
      meanFirstInputTokens:mean(r=>r.usageSamples[0]!.inputTokens),meanPeakInputTokens:mean(r=>Math.max(...r.usageSamples.map(u=>u.inputTokens))),meanModelRequests:mean(r=>r.usageSamples.length),
      meanTotalInputTokens:mean(r=>r.usageSamples.reduce((s,u)=>s+u.inputTokens,0)),meanCachedInputTokens:mean(r=>r.usageSamples.reduce((s,u)=>s+u.cachedInputTokens,0)),meanOutputTokens:mean(r=>r.usageSamples.reduce((s,u)=>s+u.outputTokens,0)),
      auxiliaryRequests:rows.reduce((s,r)=>s+r.auxiliaryUsage.length,0),meanMainModelApiEquivalentUsd:mean(r=>r.mainModelCostUsd??0),meanJevUsd:mean(r=>r.jevCostUsd),
      meanModelRequestTimeMs:mean(r=>r.events.reduce((s,e)=>s+(e.event==='usage'?e.apiDurationMs:0),0)),
      meanApiEquivalentUsd:measured.length&&measured.every(r=>r.costUsd!==null)?mean(r=>r.costUsd!):null,meanElapsedMs:mean(r=>r.elapsedMs),meanEstimatedEndToEndMs:mean(r=>r.elapsedMs+r.jevEvaluationTimeMs)}];
  }));
  const long:Run[]=[];for(const file of await readdir(join(root,'results')))if(file.endsWith('-long.json'))long.push(measured(JSON.parse(await readFile(join(root,'results',file),'utf8')) as Run));
  const sourceHashes:Record<string,string>={};for(const file of ['run.ts','support.ts','support.test.ts','agent.py','../codex/fixture.ts','../codex/support.ts'])sourceHashes[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
  const summary={model:'glm-5.3-flash',catalogHash:catalog.catalogHash,taskHash:createHash('sha256').update(await readFile(join(parent,'cases.json'))).digest('hex'),sourceHashes,subset,ratesPerMillion:{input:.15,cachedInput:.03,output:.5,jevInput:.042},priceSource:'https://docs.z.ai/guides/overview/pricing',groups,long,rows:results};
  await writeFile(join(root,'results/report.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(groups,null,2));
}

const command=process.argv[2];
if(command==='run') {
  for(const id of process.argv[3]?.split(',')??subset) {
    const task=tasks.find(t=>t.id===id);if(!task)throw new Error(`Unknown task ${id}`);
    const arms:Arm[]=process.argv[4]?.split(',').map(a=>{if(!['native','jev','eager'].includes(a))throw new Error(`Unknown arm ${a}`);return a as Arm;})??(subset.indexOf(id)%2?['jev','native']:['native','jev']);
    for(const arm of arms){console.log(`START ${id} ${arm}`);await run(task,arm);}
  }
  await report();
}else if(command==='long') {
  for(const arm of ['native','jev'] as Arm[])await run(tasks.find(t=>t.id==='h31')!,arm,5);
  await report();
}else if(command==='report')await report();
else throw new Error('Use run [caseIds] [arms], long, or report.');
