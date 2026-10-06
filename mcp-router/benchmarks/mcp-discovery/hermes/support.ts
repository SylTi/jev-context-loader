import type {Schema, Usage} from '../codex/support.js';

export type Arm='native'|'jev'|'eager';
export interface Tool {id:string;name:string;description:string;inputSchema:Schema}
export interface AgentInput {arm:Arm;tools:Tool[];prompts:string[];instructions:string}
export type AgentEvent =
  | {event:'ready';metadata:Record<string,unknown>;tools:Record<string,unknown>[]}
  | {event:'call';name:string;args:Record<string,unknown>}
  | {event:'usage';usage:Usage;apiDurationMs:number;servedModel:string}
  | {event:'aux_usage';usage:Usage;task:string|null;model:string}
  | {event:'api_request';model:string;toolCount:number;toolNames:string[]}
  | {event:'turn';answer:string;messages:Record<string,unknown>[];completed:boolean;error?:string}
  | {event:'error';error:string};

export function selectTools<T>(tools:T[],arm:Arm,scores:number[]):T[] {
  if(scores.length!==tools.length)throw new Error('Jev score count differs from catalog');
  return tools.filter((_,i)=>arm!=='jev'||scores[i]!>=.75);
}

export function fixtureId(name:string,ids:Set<string>):string {
  const id=name.replace(/^mcp__/,'').replace('__','.');
  if(!name.startsWith('mcp__')||!ids.has(id))throw new Error(`Unavailable fixture: ${name}`);
  return id;
}

// API-equivalent list prices, not charges for Coding Plan. No documented write rate.
export function apiCost(samples:Usage[]):number|null {
  if(!samples.length||samples.some(u=>(u.cacheWriteInputTokens??0)>0))return null;
  return samples.reduce((sum,u)=>sum+((u.inputTokens-u.cachedInputTokens)*.15+u.cachedInputTokens*.03+u.outputTokens*.5)/1e6,0);
}
