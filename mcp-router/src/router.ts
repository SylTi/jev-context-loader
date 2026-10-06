import {Ajv, type ValidateFunction} from 'ajv';
import {Ajv2020} from 'ajv/dist/2020.js';
import type {CallToolResult, ListToolsResult, Tool} from '@modelcontextprotocol/sdk/types.js';

export interface Upstream {
  name:string;
  list(cursor?:string):Promise<ListToolsResult>;
  call(name:string,args:Record<string,unknown>,meta?:Record<string,unknown>,signal?:AbortSignal):Promise<CallToolResult>;
  close():Promise<void>;
}
export interface CatalogTool extends Tool {id:string;server:string}
export interface Ranking {scores:number[];mode:'live'|'replay';model:string;usage?:{input_tokens:number;output_tokens:number}}
export type Ranker=(query:string,tools:CatalogTool[])=>Promise<Ranking>;
export interface SearchResult {
  matches:{id:string;server:string;name:string;description?:string;probability:number}[];
  availableServers:string[];
  threshold:number;
  cached:boolean;
  ranking:Omit<Ranking,'scores'>;
}

export class Router {
  readonly tools:CatalogTool[]=[];
  private entries=new Map<string,{tool:CatalogTool;upstream:Upstream;validate:ValidateFunction}>();
  private searches=new Map<string,Promise<SearchResult>>();
  private constructor(private upstreams:Upstream[],private rank:Ranker){}

  static async open(upstreams:Upstream[],rank:Ranker):Promise<Router> {
    const router=new Router(upstreams,rank);
    const ajv=new Ajv({strict:false,allErrors:true});
    const modern=new Ajv2020({strict:false,allErrors:true});
    try {
      for(const upstream of upstreams) {
        let cursor:string|undefined;
        do {
          const page=await upstream.list(cursor);
          for(const tool of page.tools) {
            const id=JSON.stringify([upstream.name,tool.name]);
            if(router.entries.has(id))throw new Error(`Duplicate upstream tool: ${id}`);
            const publicTool={...tool,id,server:upstream.name};
            const validator=tool.inputSchema.$schema==='https://json-schema.org/draft/2020-12/schema'?modern:ajv;
            router.entries.set(id,{tool:publicTool,upstream,validate:validator.compile(tool.inputSchema)});
            router.tools.push(publicTool);
          }
          cursor=page.nextCursor;
        }while(cursor);
      }
      return router;
    }catch(error){await router.close();throw error;}
  }

  async search(rawQuery:string):Promise<SearchResult> {
    const query=rawQuery.trim();
    if(!query)throw new Error('Query must not be blank');
    const cached=this.searches.get(query);
    if(cached)return {...await cached,cached:true};
    const pending=(async()=>{
      const ranking=this.tools.length?await this.rank(query,this.tools):{scores:[],mode:'live' as const,model:'none'};
      if(ranking.scores.length!==this.tools.length||ranking.scores.some(s=>!Number.isFinite(s)||s<0||s>1))throw new Error('Invalid ranking returned by Jev');
      const matches=this.tools.map((t,i)=>({id:t.id,server:t.server,name:t.name,description:t.description,probability:ranking.scores[i]!}))
        .filter(t=>t.probability>=.75).sort((a,b)=>b.probability-a.probability);
      const {scores,...accounting}=ranking;
      return {matches,availableServers:this.upstreams.map(s=>s.name),threshold:.75,cached:false,ranking:accounting};
    })();
    this.searches.set(query,pending);
    try{return await pending;}catch(error){this.searches.delete(query);throw error;}
  }

  describe(ids:string[]):CatalogTool[] {return ids.map(id=>this.entry(id).tool);}
  async call(id:string,args:Record<string,unknown>,meta?:Record<string,unknown>,signal?:AbortSignal):Promise<CallToolResult> {
    const entry=this.entry(id);
    if(!entry.validate(args))throw new Error(`Invalid arguments for ${id}: ${JSON.stringify(entry.validate.errors)}`);
    return entry.upstream.call(entry.tool.name,args,meta,signal);
  }
  private entry(id:string) {
    const entry=this.entries.get(id);
    if(!entry)throw new Error(`Unknown tool: ${id}`);
    return entry;
  }
  async close():Promise<void> {await Promise.allSettled(this.upstreams.map(s=>s.close()));}
}
