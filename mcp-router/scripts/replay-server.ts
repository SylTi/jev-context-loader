import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {join} from 'node:path';
import {Router} from '../src/router.js';
import {connectUpstreams,configSchema} from '../src/upstreams.js';
import {createServer} from '../src/server.js';
import {projectRoot,replayRanker} from './fixtures.js';

const caseId=process.argv[2]??'h31',eventLog=process.argv[3];
const sources=await connectUpstreams(configSchema.parse({servers:{fixture:{type:'stdio',command:process.execPath,
  args:['--import',join(projectRoot,'node_modules/tsx/dist/loader.mjs'),join(projectRoot,'scripts/fixture-server.ts'),caseId,...eventLog?[eventLog]:[]]}}}));
const router=await Router.open(sources,replayRanker(caseId,eventLog));
const server=createServer(router);
server.onclose=()=>{void router.close();};
await server.connect(new StdioServerTransport());
