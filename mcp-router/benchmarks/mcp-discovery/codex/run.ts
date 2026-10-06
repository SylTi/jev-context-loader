import {fixture, payload} from './fixture.js';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { getEncoding } from 'js-tiktoken';
import { schemaFromDeclaration, cost, gradeCompletion, disabledMcpServers, type Schema, type Usage, type Task, type Call } from './support.js';

const root = fileURLToPath(new URL('./', import.meta.url));
const parent = fileURLToPath(new URL('../', import.meta.url));
interface Tool {id:string;name:string;description:string;definition:string}
interface FunctionSpec {type:'function';name:string;description:string;inputSchema:Schema;deferLoading:boolean}
interface Namespace {type:'namespace';name:string;description:string;tools:FunctionSpec[]}
interface Message {id?:number;method?:string;params?:Record<string,unknown>;result?:unknown;error?:unknown}
interface Run {caseId:string;arm:string;repeatCount:number;selected:string[];definitionTokens:number;elapsedMs:number;calls:Call[];answer:string;usage?:Usage;usageSamples:Usage[];status:string;grade:ReturnType<typeof gradeCompletion>;turns:{answer:string;grade:ReturnType<typeof gradeCompletion>}[];costUsd?:number;jevCostUsd:number;jevEvaluationTimeMs:number;events:Message[]}
const catalog = JSON.parse(await readFile(join(parent,'catalog.json'),'utf8')) as {tools:Tool[];catalogHash:string};
const cases = JSON.parse(await readFile(join(parent,'cases.json'),'utf8')) as Task[];
const jev = JSON.parse(await readFile(join(parent,'results/jev-runs.json'),'utf8')) as {caseId:string;scores:number[];evaluationTimeMs:number;usage:{input_tokens:number}}[];
const enc = getEncoding('o200k_base');
const subset = ['h01','h04','h07','h16','h17','h21','h22','h24','h25','h29','h31','h34','h37','h39'];
const config = {
  project_doc_max_bytes:0, web_search:'disabled', model_reasoning_effort:'medium',
  features:{apps:false,plugins:false,memories:false,multi_agent:false,shell_tool:false,skip_host_skill_discovery:true,skill_search:false,tool_suggest:false,browser_use:false,computer_use:false,sleep_tool:false,view_image:false,workspace_dependencies:false},
};
const overrides = Object.entries(config).flatMap(([k,v]) => {
  if (typeof v !== 'object') return ['-c',`${k}=${JSON.stringify(v)}`];
    return Object.entries(v).flatMap(([name,value]) => ['-c',`${k}.${name}=${JSON.stringify(value)}`]);
});
const instructions = 'Complete the user task using the available fixture tools. All tools operate on synthetic local data; their names and descriptions retain their normal meaning. Do not use shell, files, browser, other services or skill discovery. Do not invent missing data. For each requested read, include its returned fixtureFact verbatim in your answer. Finish with JSON {"answer":string,"receipts":string[]} containing receipts from results actually used. If a required capability is unavailable, say so. Perform requested writes only; do not substitute a different provider. Do not ask the user for confirmation in this fixture experiment.';
const summaries:Record<string,string> = {codex:'Manage Codex chats, desktop app, usage, projects and worktrees.',github:'Access GitHub repositories, issues, pull requests, code and Actions.',linear:'Access Linear issues, teams, projects, milestones, comments and documents.',spaces:'Read, search and edit ChatGPT Pages, Spaces, sharing and scheduled automations.'};

function specifications(arm:string, task:Task):Namespace[] {
  const scores = jev.find(r => r.caseId === task.id)!.scores;
  const picked = catalog.tools.filter((_,i) => arm !== 'jev' || scores[i]! >= .75);
  return Object.entries(summaries).flatMap(([name,description]) => {
    const tools = picked.filter(t => t.id.startsWith(`${name}.`)).map(t => ({type:'function' as const,name:t.id.split('.')[1]!,description:t.description,inputSchema:schemaFromDeclaration(t.definition),deferLoading:arm==='native'}));
    return tools.length ? [{type:'namespace' as const,name,description,tools}] : [];
  });
}

async function run(task:Task, arm:string, repeatCount=1):Promise<Run> {
  const specs = specifications(arm,task);
  const selected = specs.flatMap(ns => ns.tools.map(t => `${ns.name}.${t.name}`));
  const j = jev.find(r => r.caseId===task.id)!;
  const result:Run = {caseId:task.id,arm,repeatCount,selected,definitionTokens:enc.encode(JSON.stringify(specs)).length,elapsedMs:0,calls:[],answer:'',usageSamples:[],status:'pending',grade:gradeCompletion(task,[],''),turns:[],jevCostUsd:arm==='jev'?j.usage.input_tokens*.042/1e6:0,jevEvaluationTimeMs:arm==='jev'?j.evaluationTimeMs:0,events:[]};
  const child = spawn(process.env.CODEX_BINARY??'codex',['--no-daemon','app-server','--stdio','-c','mcp_servers={}',...overrides],{cwd:root,stdio:['pipe','pipe','pipe']});
  let seq=0, stderr='';
  const pending = new Map<number,{method:string;resolve:(v:Record<string,unknown>)=>void;reject:(e:unknown)=>void}>();
  let finish:(v:void)=>void = ()=>{}, fail:(e:unknown)=>void = ()=>{};
  let completion:Promise<void>=Promise.resolve();
  function prepareTurn() {
    completion=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});
    void completion.catch(()=>{});
  }
  function abort(error:unknown) {for(const waiter of pending.values())waiter.reject(error);pending.clear();fail(error);}
  const send = (message:Message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  function request(method:string,params:Record<string,unknown>):Promise<Record<string,unknown>> {
    return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{method,resolve,reject});send({id,method,params});});
  }
  child.stderr.on('data', (chunk:Buffer) => {stderr+=chunk.toString();});
  child.on('error',abort);
  child.on('exit',code=>{if(result.status==='pending')abort(new Error(`app-server exited ${code}: ${stderr.slice(-1500)}`));});
  const lines = createInterface({input:child.stdout});
  lines.on('line',line => {
    let message:Message;
    try {message=JSON.parse(line) as Message;} catch {return;}
    // Config may contain credentials. Retain names only, and omit unrelated account telemetry.
    const privateConfig=message.id!==undefined&&pending.get(message.id)?.method==='config/read';
    if(privateConfig) {
      const cfg=(message.result as {config?:Record<string,unknown>}|undefined)?.config??{};
      result.events.push({id:message.id,result:{configuredMcpServerNames:Object.keys(disabledMcpServers(cfg))}});
    }else if(!message.method?.startsWith('account/'))result.events.push(message);
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if(message.error)waiter?.reject(message.error);else waiter?.resolve(message.result as Record<string,unknown>);
      return;
    }
    if (message.method==='item/tool/call') {
      const p = message.params!;
      const args = (typeof p.arguments==='string'?JSON.parse(p.arguments):p.arguments) as Record<string,unknown>;
      const id = p.namespace ? `${p.namespace}.${p.tool}` : String(p.tool);
      const call = fixture(task,id,args);
      result.calls.push(call);
      const data=payload(call);
      send({id:message.id,result:{success:call.valid,contentItems:[{type:'inputText',text:JSON.stringify(data)}]}});
    } else if(message.id !== undefined && message.method) {
      send({id:message.id,error:{code:-32601,message:'Unavailable in benchmark client'}});
    }
    if(message.method==='thread/tokenUsage/updated') {
      const usage = message.params!.tokenUsage as {total:Usage;last:Usage};
      result.usage=usage.total;
      if(usage.last.inputTokens>0)result.usageSamples.push(usage.last);
    }
    if(message.method==='item/completed') {
      const item=message.params!.item as {type:string;text?:string;phase?:string};
      if(item.type==='agentMessage' && item.phase !== 'commentary')result.answer=item.text??result.answer;
    }
    if(message.method==='turn/completed') {
      const turn=message.params!.turn as {status:string;error?:unknown};
      result.status=turn.status;
      finish();
    }
  });
  const timeout = setTimeout(()=>abort(new Error('benchmark run exceeded time limit')),180000*repeatCount);
  const started=Date.now();
  try {
    await request('initialize',{clientInfo:{name:'jev_discovery_benchmark',title:'Jev discovery benchmark',version:'0.1.0'},capabilities:{experimentalApi:true}});
    send({method:'initialized',params:{}});
    const effective=await request('config/read',{includeLayers:false,cwd:root});
    const isolatedConfig={...config,mcp_servers:disabledMcpServers(effective.config as Record<string,unknown>)};
    result.events.push({method:'benchmark/isolation',params:{disabledMcpServerNames:Object.keys(isolatedConfig.mcp_servers),apps:false,plugins:false}});
    const thread = await request('thread/start',{model:'gpt-6.1-sol',serviceTier:'default',cwd:root,approvalPolicy:'never',sandbox:'read-only',ephemeral:true,environments:[],baseInstructions:instructions,dynamicTools:specs,config:isolatedConfig});
    const threadId=(thread.thread as {id:string}).id;
    for(let index=0;index<repeatCount;index++) {
      prepareTurn();result.status='pending';result.answer='';
      const firstCall=result.calls.length;
      // Re-read fresh provider state each turn; definitions can remain loaded.
      const text=index===0?task.task:`${task.task}\nRe-read the current provider state; do not reuse previous tool results.`;
      await request('turn/start',{threadId,input:[{type:'text',text}],effort:'medium',serviceTierForTurn:'default',environments:[]});
      await completion;
      result.turns.push({answer:result.answer,grade:gradeCompletion(task,result.calls.slice(firstCall),result.answer)});
      if(result.status!=='completed')break;
    }
  } catch(error) {result.status='error';result.events.push({method:'benchmark/error',params:{error:String(JSON.stringify(error))}});} finally {
    clearTimeout(timeout);result.elapsedMs=Date.now()-started;
    child.stdin.end();child.kill();lines.close();
  }
  result.grade=gradeCompletion(task,result.calls,result.answer);
  if(result.turns.some(t=>!t.grade.pass)||result.turns.length!==repeatCount)result.grade.pass=false;
  if(result.usage)result.costUsd=cost(result.usage)+result.jevCostUsd;
  await mkdir(join(root,'results'),{recursive:true});
  const suffix=repeatCount>1?'-long':'';
  await writeFile(join(root,'results',`${task.id}-${arm}${suffix}.json`),JSON.stringify(result,null,2));
  await writeFile(join(root,'results',`${task.id}-${arm}${suffix}.stderr.log`),stderr);
  return result;
}

async function report() {
  const results:Run[]=[];
  for(const id of subset)for(const arm of ['eager','native','jev']) {
    try {results.push(JSON.parse(await readFile(join(root,'results',`${id}-${arm}.json`),'utf8')) as Run);}catch{}
  }
  const groups=Object.fromEntries(['eager','native','jev'].map(arm=>{
    const rows=results.filter(r=>r.arm===arm);
    const average=(f:(r:Run)=>number)=>rows.reduce((sum,r)=>sum+f(r),0)/rows.length;
    return [arm,{runs:rows.length,completed:rows.filter(r=>r.status==='completed').length,passed:rows.filter(r=>r.grade.pass && r.status==='completed').length,meanFirstInputTokens:average(r=>r.usageSamples[0]?.inputTokens??0),meanPeakInputTokens:average(r=>Math.max(0,...r.usageSamples.map(s=>s.inputTokens))),meanModelRequests:average(r=>r.usageSamples.length),meanTotalInputTokens:average(r=>r.usage?.inputTokens??0),meanCachedInputTokens:average(r=>r.usage?.cachedInputTokens??0),meanCacheWriteInputTokens:average(r=>r.usage?.cacheWriteInputTokens??0),meanOutputTokens:average(r=>r.usage?.outputTokens??0),meanCostUsd:average(r=>r.costUsd??0),meanElapsedMs:average(r=>r.elapsedMs),meanEstimatedEndToEndMs:average(r=>r.elapsedMs+r.jevEvaluationTimeMs)}];
  }));
  const longReuse:Record<string,unknown>={};
  for(const arm of ['eager','native','jev']) {
    try {
      const row=JSON.parse(await readFile(join(root,'results',`h31-${arm}-long.json`),'utf8')) as Run;
      longReuse[arm]={turns:row.turns.length,passedTurns:row.turns.filter(t=>t.grade.pass).length,status:row.status,peakInputTokens:Math.max(...row.usageSamples.map(s=>s.inputTokens)),usage:row.usage,costUsd:row.costUsd,elapsedMs:row.elapsedMs,jevRoutingCalls:arm==='jev'?1:0};
    }catch{}
  }
  const userAgents=[...new Set(results.flatMap(r=>r.events.flatMap(e=>{
    const value=(e.result as {userAgent?:string}|undefined)?.userAgent;
    return value?[value]:[];
  })))];
  const sourceFilesSha256:Record<string,string>={};
  for(const file of ['run.ts','support.ts','support.test.ts'])sourceFilesSha256[file]=createHash('sha256').update(await readFile(join(root,file))).digest('hex');
  const summary={model:'gpt-6.1-sol',reasoning:'medium',cliUserAgents:userAgents,ratesPerMillion:{input:2,cachedInput:.1,cacheWriteInput:2.5,output:10,jevInput:.042},pricingSource:'https://developers.openai.com/api/docs/pricing',catalogHash:catalog.catalogHash,taskFileSha256:createHash('sha256').update(await readFile(join(parent,'cases.json'))).digest('hex'),sourceFilesSha256,subset,groups,longReuse,rows:results.map(({events,...r})=>r)};
  await mkdir(join(root,'results'),{recursive:true});
  await writeFile(join(root,'results','report.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(groups,null,2));
}

const command=process.argv[2];
if(command==='run') {
  const ids=process.argv[3]?.split(',')??subset;
  for(const id of ids) {
    const allArms=['eager','native','jev'];
    const offset=subset.indexOf(id)%3;
    const arms=process.argv[4]?.split(',')??[...allArms.slice(offset),...allArms.slice(0,offset)];
    for(const arm of arms) {
    const task=cases.find(t=>t.id===id);if(!task)throw new Error(`Unknown task ${id}`);
    console.log(`START ${id} ${arm}`);
    const r=await run(task,arm);
    console.log(`DONE ${id} ${arm} ${r.status} pass=${r.grade.pass} input=${r.usage?.inputTokens} calls=${r.calls.length}`);
    }
  }
  await report();
}else if(command==='long') {
  const task=cases.find(t=>t.id==='h31')!;
  for(const arm of ['eager','native','jev']) {
    console.log(`START long ${arm}`);
    const r=await run(task,arm,5);
    console.log(`DONE long ${arm} ${r.status} pass=${r.grade.pass} input=${r.usage?.inputTokens} calls=${r.calls.length}`);
  }
}else if(command==='report')await report();
else if(command==='schemas') {
  await writeFile(join(root,'tools.json'),JSON.stringify(catalog.tools.map(t=>({id:t.id,...specifications('eager',cases[0]!).find(ns=>ns.name===t.id.split('.')[0])!.tools.find(f=>f.name===t.id.split('.')[1])!})),null,2));
}
