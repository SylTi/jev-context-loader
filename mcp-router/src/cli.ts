#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {configSchema,connectUpstreams} from './upstreams.js';
import {Router} from './router.js';
import {createJevRanker} from './jev.js';
import {createServer} from './server.js';

if(process.argv[2]==='--help') {
  console.log('jev-mcp-router <config.json>\nRequires TYPESAFE_API_KEY. Serves three tools over stdio.\nUpstream credentials are environment-variable bindings in config. See README.md.');
}else {
  let router:Router|undefined;
  try {
    const path=process.argv[2];
    if(!path)throw new Error('Usage: jev-mcp-router <config.json>');
    const rank=createJevRanker();
    const config=configSchema.parse(JSON.parse(await readFile(path,'utf8')));
    router=await Router.open(await connectUpstreams(config),rank);
    const server=createServer(router);
    const close=async()=>{await server.close();await router?.close();};
    process.once('SIGINT',()=>void close());
    process.once('SIGTERM',()=>void close());
    server.onclose=()=>{void router?.close();};
    await server.connect(new StdioServerTransport());
  }catch(error){await router?.close();console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
