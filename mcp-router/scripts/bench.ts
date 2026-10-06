import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {projectRoot,taskFor,jev} from './fixtures.js';
import {gradeCompletion,type Call} from '../benchmarks/mcp-discovery/codex/support.js';
import {glmCost,replayCosts,type OpenCodeTokens} from './metrics.js';

// Claude is deliberately not invoked. This runner uses installed OpenCode V2 only.
const binary=process.env.OPENCODE_BINARY??'opencode2';
const model=process.env.OPENCODE_BENCH_MODEL??'zai-coding-plan/glm-5.3-flash';
const instructions='Complete the user task using the available fixture tools. All tools operate on synthetic local data. Do not use shell, files, browser, other services, skills or delegation. Do not invent missing data. For each requested read, include its returned fixtureFact verbatim. Finish with JSON {"answer":string,"receipts":string[]} containing receipts from results actually used. If a required capability is unavailable, say so. Perform requested writes only. Do not substitute a different provider. Do not ask for confirmation in this fixture experiment.';
const ids=process.argv[2]?.split(',')??['h01','h04','h07','h16','h17','h21','h22','h24','h25','h29','h31','h34','h37','h39'];
const requestedArms=process.argv[3]?.split(',');
await mkdir(join(projectRoot,'results/opencode'),{recursive:true});
benchmark:for(const caseId of ids)for(const arm of requestedArms??(ids.indexOf(caseId)%2?['jev','native']:['native','jev'])) {
  if(!['native','jev'].includes(arm))throw new Error(`Unknown arm: ${arm}`);
  const task=taskFor(caseId);
  const temp=await mkdtemp(join(tmpdir(),'jev-mcp-bench-'));
  let cleanup=()=>{};
  try {
  const configHome=join(temp,'config');await mkdir(join(configHome,'opencode'),{recursive:true});
  const eventLog=join(projectRoot,'results/opencode',`${caseId}-${arm}.fixtures.jsonl`);
  await writeFile(eventLog,'');
  const command=[process.execPath,'--import',join(projectRoot,'node_modules/tsx/dist/loader.mjs'),join(projectRoot,'scripts',arm==='native'?'fixture-server.ts':'replay-server.ts'),caseId,eventLog];
  const permissions=[{action:'*',resource:'*',effect:'deny'},{action:'fixture_*',resource:'*',effect:'allow'},
    ...(arm==='native'?[{action:'execute',resource:'*',effect:'allow'}]:[])];
  const config={model,snapshots:false,warming:false,plugins:[],skills:[],mcp:{servers:{fixture:{type:'local',command,codemode:arm==='native'}}},
    agents:{benchmark:{mode:'primary',description:'Synthetic fixture benchmark',system:instructions,permissions}},permissions};
  await writeFile(join(temp,'opencode.json'),JSON.stringify(config,null,2));
  await writeFile(join(configHome,'opencode/opencode.json'),'{}');
  let stdout='',stderr='';
  const started=Date.now();
  console.log(`START ${caseId} ${arm} ${model}`);
  // Hold one private authenticated server open while its plugin catalogs settle.
  const runtimeEnv={...process.env,XDG_CONFIG_HOME:configHome,OPENCODE_SERVER_PASSWORD:randomBytes(32).toString('base64url')};
  const server=spawn(binary,['serve','--stdio','--port','0'],{cwd:temp,env:runtimeEnv,stdio:['pipe','pipe','pipe']});
  cleanup=()=>{server.stdin.end();server.kill();};
  let serverOutput='',serverError='';
  server.stderr.on('data',(d:Buffer)=>{serverError+=d.toString();});
  const url=await new Promise<string>((resolve,reject)=>{
    const startup=setTimeout(()=>reject(new Error('Private server startup timeout')),20000);
    server.on('error',error=>{clearTimeout(startup);reject(error);});
    server.on('exit',()=>{clearTimeout(startup);reject(new Error('Private server exited before ready'));});
    server.stdout.on('data',(d:Buffer)=>{
      serverOutput+=d.toString();
      if(serverOutput.includes('\n')){clearTimeout(startup);resolve((JSON.parse(serverOutput.split('\n')[0]!) as {url:string}).url);}
    });
  });
  const headers={Authorization:`Basic ${Buffer.from(`opencode:${runtimeEnv.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`};
  const registrySnapshots:unknown[]=[];
  for(let i=0;i<20;i++) {
    const response=await fetch(new URL('/api/agent',url),{headers});
    const data:unknown=response.ok?await response.json():null;
    const snapshot=data as {data?:{id:string;mode:string;permissions:unknown}[]}|null;
    registrySnapshots.push(snapshot?.data?.map(a=>({id:a.id,mode:a.mode,permissions:a.permissions}))??[]);
    if(snapshot?.data?.some(a=>a.id==='benchmark'))break;
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const mcpSnapshots:unknown[]=[];
  let connected=false;
  for(let i=0;i<40;i++) {
    const response=await fetch(new URL('/api/mcp',url),{headers});
    const data:unknown=response.ok?await response.json():null;
    mcpSnapshots.push(data);
    const catalog=data as {data?:{name:string;status:{status:string}}[]}|null;
    if(catalog?.data?.some(s=>s.name==='fixture'&&s.status.status==='connected')){connected=true;break;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  // Explicit API location avoids this preview CLI checking agents in another location.
  const api=async(path:string,body?:unknown):Promise<Record<string,unknown>>=>{
    const response=await fetch(new URL(path,url),{method:body===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(180000)});
    const data=await response.text();
    if(!response.ok)throw new Error(`OpenCode ${path}: ${response.status} ${data}`);
    return data?JSON.parse(data) as Record<string,unknown>:{};
  };
  let code=0,sessionID:string|undefined,pluginSnapshot:unknown;
  let messages:Record<string,unknown>[]=[];
  try {
    if(!connected)throw new Error('Fixture MCP server did not connect; refusing inference');
    const contract=await api('/openapi.json');
    await writeFile(join(projectRoot,'results/opencode/openapi.json'),JSON.stringify(contract,null,2));
    const refs=(contract.components as {schemas:Record<string,{properties?:Record<string,unknown>}>}).schemas;
    const modelField=refs['Model.Ref']?.properties?.model?'model':'id';
    const paths=contract.paths as Record<string,{post?:{operationId:string}}>;
    const waitPath=Object.entries(paths).find(([,route])=>route.post?.operationId.endsWith('session.wait'))?.[0];
    if(!waitPath)throw new Error('Installed OpenCode does not expose session wait');
    // Connected MCP status can precede tool registration in this preview runtime.
    await api('/api/plugin/await-activation',{});
    pluginSnapshot=await api('/api/plugin');
    await new Promise(resolve=>setTimeout(resolve,1000));
    const [providerID,modelID]=model.split('/');
    const created=await api('/api/session',{title:`MCP benchmark ${caseId} ${arm}`,agent:'benchmark',model:{providerID,[modelField]:modelID},location:{directory:temp}});
    sessionID=(created.data as {id:string}).id;
    await api(`/api/session/${sessionID}/prompt`,{text:task.task});
    await api(waitPath.replace('{sessionID}',sessionID),{});
    const response=await api(`/api/session/${sessionID}/message?limit=100&order=asc`);
    messages=response.data as Record<string,unknown>[];
    stdout=messages.map(m=>JSON.stringify(m)).join('\n');
  }catch(error){code=1;stderr=error instanceof Error?error.message:String(error);}
  cleanup();
  const events:Record<string,unknown>[]=[];
  for(const line of stdout.split('\n'))try{events.push(JSON.parse(line) as Record<string,unknown>);}catch{}
  let fixtureEvents:{event:string;call?:Call;query?:string}[]=[];
  try{fixtureEvents=(await readFile(eventLog,'utf8')).trim().split('\n').filter(Boolean).map(l=>JSON.parse(l));}catch{}
  const calls=fixtureEvents.filter(e=>e.event==='fixture').map(e=>e.call!);
  const assistants=events.filter(e=>e.type==='assistant');
  const answer=assistants.flatMap(e=>(e.content as {type:string;text?:string}[]).filter(p=>p.type==='text').map(p=>p.text??'')).join('\n');
  const usage=assistants.filter(e=>e.tokens).map(e=>({tokens:e.tokens as OpenCodeTokens,cost:e.cost as number,model:e.model}));
  const missingUsage=assistants.length!==usage.length||assistants.some(e=>e.error);
  const uncachedSearches=arm==='jev'?fixtureEvents.filter(e=>e.event==='search').length:0;
  const saved=jev.find(r=>r.caseId===caseId)!;
  const modelCost=missingUsage?null:glmCost(usage.map(u=>u.tokens));
  const estimates=replayCosts(modelCost,saved.usage.input_tokens,uncachedSearches);
  const jevCostUsd=estimates.singleRouteJevCostUsd;
  const result={caseId,arm,model,code,status:code===0&&answer&&!missingUsage?'completed':'error',elapsedMs:Date.now()-started,
    config,sessionID,registrySnapshots,mcpSnapshots,pluginSnapshot,startupBarrier:'plugin activation plus 1 second catalog settle',events,calls,answer,usage,fixtureEvents,grade:gradeCompletion(task,calls,answer),
    ranking:arm==='jev'?'fixed task-level Jev replay':'native OpenCode V2 Code Mode',modelCostUsd:modelCost,
    jevCostUsd,totalCostUsd:estimates.singleRouteTotalCostUsd,...estimates};
  const path=join(projectRoot,'results/opencode',`${caseId}-${arm}`);
  await writeFile(path+'.json',JSON.stringify(result,null,2));
  await writeFile(path+'.stdout.jsonl',stdout);
  await writeFile(path+'.stderr.log',stderr);
  console.log(`DONE ${caseId} ${arm} status=${result.status} pass=${result.grade.pass} calls=${calls.length} modelRequests=${usage.length}`);
  if(result.status!=='completed'){console.error(stderr.slice(-2000)||'No completed output from OpenCode');process.exitCode=1;break benchmark;}
  }finally{cleanup();await rm(temp,{recursive:true,force:true});}
}
