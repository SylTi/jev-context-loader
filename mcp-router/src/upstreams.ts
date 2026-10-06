import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport,getDefaultEnvironment} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {z} from 'zod';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import type {Upstream} from './router.js';

const env=z.record(z.string());
export const configSchema=z.object({servers:z.record(z.discriminatedUnion('type',[
  z.object({type:z.literal('stdio'),command:z.string().min(1),args:z.array(z.string()).default([]),cwd:z.string().optional(),env:env.default({})}).strict(),
  z.object({type:z.literal('http'),url:z.string().url(),headers:env.default({})}).strict(),
]))}).strict();
export type Config=z.infer<typeof configSchema>;

function resolveEnv(bindings:Record<string,string>):Record<string,string> {
  return Object.fromEntries(Object.entries(bindings).map(([key,variable])=>{
    const value=process.env[variable];
    if(value===undefined)throw new Error(`Missing environment variable: ${variable}`);
    return [key,value];
  }));
}
export async function connectUpstreams(config:Config):Promise<Upstream[]> {
  const clients:Client[]=[];
  const upstreams:Upstream[]=[];
  try {
    for(const [name,spec] of Object.entries(config.servers)) {
      const client=new Client({name:'jev-mcp-router',version:'0.1.0'});
      clients.push(client);
      const transport=spec.type==='stdio'?new StdioClientTransport({command:spec.command,args:spec.args,cwd:spec.cwd,
        env:{...getDefaultEnvironment(),...resolveEnv(spec.env)},stderr:'inherit'}):
        new StreamableHTTPClientTransport(new URL(spec.url),{requestInit:{headers:resolveEnv(spec.headers)}});
      await client.connect(transport);
      upstreams.push({name,list:async cursor=>client.listTools(cursor?{cursor}:undefined),
        call:async(name,args,meta,signal)=>CallToolResultSchema.parse(await client.callTool({name,arguments:args,_meta:meta},CallToolResultSchema,{signal})),close:()=>client.close()});
    }
    return upstreams;
  }catch(error){await Promise.allSettled(clients.map(c=>c.close()));throw error;}
}
