import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {getEncoding} from 'js-tiktoken';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {projectRoot,tools,taskFor} from './fixtures.js';

const enc=getEncoding('o200k_base');
const results=[];
for(const id of ['h31','h24']) {
  const client=new Client({name:'demo',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/replay-server.ts',id],cwd:projectRoot,stderr:'inherit'}));
    const bridge=(await client.listTools()).tools;
    const result=CallToolResultSchema.parse(await client.callTool({name:'search',arguments:{query:taskFor(id).task}}));
    const search=JSON.parse((result.content[0] as {text:string}).text);
    results.push({caseId:id,task:taskFor(id).task,transport:'actual MCP stdio',ranking:'frozen task-level Jev replay',
      exposedTools:bridge.length,bridgeDefinitionTokens:enc.encode(JSON.stringify(bridge)).length,
      eagerDefinitionTokens:enc.encode(JSON.stringify(tools)).length,search});
  }finally{await client.close();}
}
await mkdir(join(projectRoot,'results'),{recursive:true});
await writeFile(join(projectRoot,'results/demo.json'),JSON.stringify(results,null,2));
console.log(JSON.stringify(results,null,2));
