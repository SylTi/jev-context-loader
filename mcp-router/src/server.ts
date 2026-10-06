import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {CallToolRequestSchema,ListToolsRequestSchema,type CallToolResult,type Tool} from '@modelcontextprotocol/sdk/types.js';
import {z} from 'zod';
import type {Router} from './router.js';

const schemas={
  search:z.object({query:z.string().trim().min(1)}).strict(),
  describe:z.object({ids:z.array(z.string()).min(1)}).strict(),
  call:z.object({id:z.string(),arguments:z.record(z.unknown())}).strict(),
};
const text=(value:unknown):CallToolResult=>({content:[{type:'text',text:JSON.stringify(value)}]});
export function bridgeTools(servers:string[]):Tool[] {
  return [
    {name:'search',description:`Find relevant upstream tools with Jev. Available servers: ${servers.join(', ')}. Search for the current task; reuse disclosed schemas. Empty matches do not prove a capability is absent.`,inputSchema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'describe',description:'Load full tool schemas by IDs returned from search or already known. Reuse these schemas while continuing the task.',inputSchema:{type:'object',properties:{ids:{type:'array',items:{type:'string'}}},required:['ids'],additionalProperties:false},annotations:{readOnlyHint:true}},
    {name:'call',description:'Invoke one upstream tool using its exact disclosed ID and arguments. Only execute operations requested by the user. Results preserve upstream content and errors.',inputSchema:{type:'object',properties:{id:{type:'string'},arguments:{type:'object'}},required:['id','arguments'],additionalProperties:false},annotations:{readOnlyHint:false,destructiveHint:true,idempotentHint:false,openWorldHint:true}},
  ];
}
export function createServer(router:Router):Server {
  const server=new Server({name:'jev-mcp-router',version:'0.1.0'},{capabilities:{tools:{}}});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:bridgeTools([...new Set(router.tools.map(t=>t.server))])}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    try {
      switch(request.params.name) {
        case 'search':return text(await router.search(schemas.search.parse(request.params.arguments).query));
        case 'describe':return text(router.describe(schemas.describe.parse(request.params.arguments).ids));
        case 'call':{
          const input=schemas.call.parse(request.params.arguments);
          return await router.call(input.id,input.arguments,request.params._meta,extra.signal);
        }
        default:throw new Error(`Unknown bridge tool: ${request.params.name}`);
      }
    }catch(error){return {...text({error:error instanceof Error?error.message:String(error)}),isError:true};}
  });
  return server;
}
