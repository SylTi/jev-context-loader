import assert from 'node:assert/strict';
import test from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

test('real stdio proxy lists only bridge tools and executes a disclosed upstream fixture',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const client=new Client({name:'integration-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','scripts/replay-server.ts','h31'],cwd:root,stderr:'inherit'});
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name),['search','describe','call']);
    const read=(result:Awaited<ReturnType<typeof client.callTool>>)=>JSON.parse((CallToolResultSchema.parse(result).content[0] as {text:string}).text);
    const search=read(await client.callTool({name:'search',arguments:{query:'Read Linear issue ENG-123'}}));
    assert.equal(search.ranking.mode,'replay');
    const match=search.matches.find((t:{name:string})=>t.name.endsWith('get_issue'));
    assert.ok(match);
    const schemas=read(await client.callTool({name:'describe',arguments:{ids:[match.id]}}));
    assert.equal(schemas[0].inputSchema.type,'object');
    const result=await client.callTool({name:'call',arguments:{id:match.id,arguments:{id:'ENG-123'}}});
    assert.equal(result.isError,false);
    assert.equal(read(result).fixtureFact,'token-expiry-race-condition');
    assert.equal((await client.callTool({name:'call',arguments:{id:match.id,arguments:{}}})).isError,true);
  }finally {await client.close();}
});
