import {readFile,appendFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {fixture,payload} from '../benchmarks/mcp-discovery/codex/fixture.js';
import {schemaFromDeclaration,type Task} from '../benchmarks/mcp-discovery/codex/support.js';
import type {Ranker} from '../src/router.js';

export const benchmarkRoot=fileURLToPath(new URL('../benchmarks/mcp-discovery/',import.meta.url));
export const projectRoot=fileURLToPath(new URL('../',import.meta.url));
export const catalog=JSON.parse(await readFile(join(benchmarkRoot,'catalog.json'),'utf8')) as {tools:{id:string;name:string;description:string;definition:string}[];catalogHash:string};
export const tasks=JSON.parse(await readFile(join(benchmarkRoot,'cases.json'),'utf8')) as Task[];
export const jev=JSON.parse(await readFile(join(benchmarkRoot,'results/jev-runs.json'),'utf8')) as {caseId:string;scores:number[];usage:{input_tokens:number;output_tokens:number};evaluationTimeMs:number}[];
// MCP requires an object root, including reconstructed unions of object inputs.
export const tools:Tool[]=catalog.tools.map(t=>({name:t.name,description:t.description,inputSchema:{...schemaFromDeclaration(t.definition),type:'object'}}));
export function taskFor(id:string):Task {
  const task=tasks.find(t=>t.id===id);
  if(!task)throw new Error(`Unknown case: ${id}`);
  return task;
}
export async function log(path:string|undefined,event:unknown):Promise<void> {
  if(path)await appendFile(path,JSON.stringify(event)+'\n');
}
export function replayRanker(caseId:string,eventLog?:string):Ranker {
  const saved=jev.find(r=>r.caseId===caseId);
  if(!saved)throw new Error(`No Jev replay: ${caseId}`);
  return async(query,selected)=>{
    await log(eventLog,{event:'search',query,replayConditioningTask:taskFor(caseId).task});
    return {mode:'replay',model:'jev-1.13.0',usage:saved.usage,scores:selected.map(t=>{
      const index=catalog.tools.findIndex(c=>c.name===t.name);
      if(index<0)throw new Error(`Tool not in frozen catalog: ${t.name}`);
      return saved.scores[index]!;
    })};
  };
}
export async function serveFixtures(caseId:string,eventLog?:string):Promise<void> {
  const task=taskFor(caseId);
  const server=new Server({name:'benchmark-fixtures',version:'0.1.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}));
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const definition=catalog.tools.find(t=>t.name===request.params.name);
    if(!definition)throw new Error('Fixture tool unavailable');
    const call=fixture(task,definition.id,request.params.arguments??{});
    await log(eventLog,{event:'fixture',call});
    return {isError:!call.valid,content:[{type:'text',text:JSON.stringify(payload(call))}]};
  });
  await server.connect(new StdioServerTransport());
}
