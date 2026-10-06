import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { getEncoding } from 'js-tiktoken';

export interface Tool { id: string; name: string; description: string; definition: string; tokens: number }
export interface Ranked { id: string; score: number }
interface Case { id: string; split: 'development' | 'held_out'; language: 'en' | 'fr'; kind: string; task: string; required: string[][] }
interface Run { caseId: string; scores: number[]; uiElapsedMs: number; model: string; source: string;
  evaluationTimeMs: number; usage: {input_tokens: number; output_tokens: number} }
const encoding = getEncoding('o200k_base');
const count = (text: string) => encoding.encode(text).length;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const words = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const load = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
const save = async (path: string, value: unknown) => writeFile(path, JSON.stringify(value, null, 2) + '\n');

export function bm25(tools: Tool[], query: string): Ranked[] {
  const docs = tools.map(t => words(t.name + ' ' + t.description));
  const frequencies = docs.map(d => { const f = new Map<string, number>(); for (const w of d) f.set(w, (f.get(w) ?? 0) + 1); return f; });
  const average = docs.reduce((n,d) => n+d.length, 0) / docs.length;
  const terms = [...new Set(words(query))];
  const documentFrequency = new Map(terms.map(term => [term, frequencies.filter(f => f.has(term)).length]));
  return tools.map((tool,i) => ({id:tool.id, score:terms.reduce((sum,term) => {
    const df = documentFrequency.get(term)!;
    const tf = frequencies[i]!.get(term) ?? 0;
    if (!tf) return sum;
    const idf = Math.log(1 + (tools.length - df + 0.5)/(df+0.5));
    return sum + idf * tf * 2.2 / (tf + 1.2*(0.25 + 0.75*docs[i]!.length/average));
  },0)})).filter(r => r.score > 0).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id));
}

export function selectBudget(tools: Tool[], ranked: Ranked[], budget: number): string[] {
  const byId = new Map(tools.map(t => [t.id,t]));
  const chosen: string[] = [];
  let remaining = budget;
  for (const item of ranked) {
    const size = byId.get(item.id)!.tokens;
    if (size <= remaining) { chosen.push(item.id); remaining -= size; }
  }
  return chosen;
}

export function grade(required: string[][], selected: string[]) {
  const hit = required.filter(group => group.some(id => selected.includes(id))).length;
  const allowed = new Set(required.flat());
  const relevant = selected.filter(id => allowed.has(id)).length;
  return {recall: required.length ? hit/required.length : selected.length ? 0 : 1,
    complete: required.length ? hit === required.length : selected.length === 0,
    precision: selected.length ? relevant/selected.length : required.length ? 0 : 1,
    extra:selected.length-relevant};
}

function questions(tools: Tool[]) {
  return Object.fromEntries(tools.map((tool,i) => ['t'+i, {type:'noul', instructions:{
    question:'Should this tool be available to complete the current task? Evaluate each tool independently; multiple tools may be required. Respect explicit requested services, exclusions, and instructions not to use tools. Include necessary prerequisite operations, but shared keywords alone do not make a tool relevant.',
    tool:{name:tool.name, description:tool.description},
  }}]));
}

async function prepare() {
  const raw = await load<{source:string;tools:Array<{name:string;description:string}>}>('raw-tools.json');
  const tools: Tool[] = raw.tools.map(t => ({
    id:t.name.replace('mcp__codex_app__','codex.').replace('mcp__linear__','linear.').replace('mcp__codex_apps__github_','github.').replace('mcp__codex_apps__chatgpt_space_','spaces.'),
    name:t.name, description:t.description.split('exec tool declaration:')[0]!.trim(), definition:t.description,
    tokens:count(t.name+'\n'+t.description),
  }));
  const cases = await load<Case[]>('cases.json');
  const ids = new Set(tools.map(t=>t.id));
  for (const c of cases) for (const id of c.required.flat()) if (!ids.has(id)) throw new Error('Unknown label: '+id);
  await mkdir('results', {recursive:true});
  await save('catalog.json', {source:raw.source, tokenizer:'o200k_base', catalogHash:hash(tools), tools});
  await save('manifest.json', {catalogHash:hash(tools), casesHash:hash(cases), caseCount:cases.length, toolCount:tools.length,
    fullCatalogTokens:count(tools.map(t=>t.name+'\n'+t.definition).join('\n\n')), sumPerToolTokens:tools.reduce((n,t)=>n+t.tokens,0),
    budgets:[2000,5000], threshold:0.75, bm25:{k1:1.2,b:0.75,tokenization:'Unicode words, lowercase and remove diacritics; no stemming, synonyms or translation'}});
  const q = questions(tools);
  await save('questions.json',q);
  const escape = (s:string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  await writeFile('payloads.html', '<!doctype html><meta charset="utf-8"><title>MCP benchmark payloads</title><h1>MCP benchmark payloads</h1>'+
    '<p>Public tool metadata and synthetic task text only. Never execute these tools.</p><pre id="questions">'+escape(JSON.stringify(q))+'</pre>'+
    cases.map(c=>'<section><h2>'+c.id+'</h2><pre id="state-'+c.id+'">'+escape(JSON.stringify({task:c.task}))+'</pre></section>').join('\n'));
  console.log(JSON.stringify({status:'prepared',tools:tools.length,cases:cases.length,questionTokens:count(JSON.stringify(q)),fullCatalogTokens:count(tools.map(t=>t.name+'\n'+t.definition).join('\n\n'))}));
}

async function report() {
  const catalog = await load<{catalogHash:string; tools:Tool[]}>('catalog.json');
  const manifest = await load<{catalogHash:string;casesHash:string;fullCatalogTokens:number}>('manifest.json');
  const cases = await load<Case[]>('cases.json');
  if (hash(cases)!==manifest.casesHash || hash(catalog.tools)!==manifest.catalogHash) throw new Error('Frozen inputs changed.');
  let runs: Run[] = [];
  try { runs = await load<Run[]>('results/jev-runs.json'); } catch(e) { if ((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
  const byId = new Map(catalog.tools.map(t=>[t.id,t]));
  const rows: Array<Record<string,string|number|boolean|string[]>> = [];
  for (const c of cases) {
    const start=performance.now(); const baseline=bm25(catalog.tools,c.task); const bm25Ms=performance.now()-start;
    const run=runs.find(r=>r.caseId===c.id);
    if (run && (run.scores.length!==catalog.tools.length || run.scores.some(s=>!Number.isFinite(s)||s<0||s>1))) throw new Error('Invalid scores for '+c.id);
    const ranked=run ? run.scores.map((score,i)=>({id:catalog.tools[i]!.id,score})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id)) : [];
    const selections: Array<{method:string;selected:string[];elapsedMs:number}> = [
      ...[2000,5000].map(budget=>({method:'bm25_'+budget,selected:selectBudget(catalog.tools,baseline,budget),elapsedMs:bm25Ms})),
      ...(run ? [
        {method:'jev_0.75',selected:ranked.filter(r=>r.score>=0.75).map(r=>r.id),elapsedMs:run.uiElapsedMs??0},
        ...[2000,5000].map(budget=>({method:'jev_'+budget,selected:selectBudget(catalog.tools,ranked.filter(r=>r.score>0),budget),elapsedMs:run.uiElapsedMs??0})),
      ] : []),
    ];
    for (const s of selections) rows.push({caseId:c.id,split:c.split,language:c.language,kind:c.kind,method:s.method,
      ...grade(c.required,s.selected), selected:s.selected, selectedCount:s.selected.length,
      schemaTokens:s.selected.reduce((n,id)=>n+byId.get(id)!.tokens,0),elapsedMs:s.elapsedMs});
  }
  const summarize=(filtered:typeof rows)=>[...new Set(filtered.map(r=>String(r.method)))].map(method=>{
    const records=filtered.filter(r=>r.method===method);
    const positive=records.filter(r=>r.kind!=='none');
    const negative=records.filter(r=>r.kind==='none');
    const mean=(items:typeof rows,key:string)=>items.length?items.reduce((n,r)=>n+Number(r[key]),0)/items.length:0;
    return {method,cases:records.length,positiveCases:positive.length,meanRequiredRecall:mean(positive,'recall'),
      completePositive:positive.filter(r=>r.complete).length,noToolCorrect:negative.filter(r=>r.complete).length,noToolCases:negative.length,
      meanSchemaTokens:mean(records,'schemaTokens'),meanSelectedTools:mean(records,'selectedCount'),meanNonLabelledTools:mean(records,'extra')};
  });
  const heldout=rows.filter(r=>r.split==='held_out');
  const percentile=(values:number[],p:number)=>values.length?[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1]:null;
  const runtime={models:[...new Set(runs.map(r=>r.model))],inputTokens:runs.reduce((n,r)=>n+r.usage.input_tokens,0),
    outputTokens:runs.reduce((n,r)=>n+r.usage.output_tokens,0),
    evaluationMs:{p50:percentile(runs.map(r=>r.evaluationTimeMs),0.5),p95:percentile(runs.map(r=>r.evaluationTimeMs),0.95)},
    uiElapsedMs:{p50:percentile(runs.map(r=>r.uiElapsedMs),0.5),p95:percentile(runs.map(r=>r.uiElapsedMs),0.95)},
    percentileMethod:'nearest rank',timingSource:'evaluationTimeMs is playground-reported server evaluation; uiElapsedMs includes browser automation'};
  const output={manifest, jevCompleted:runs.length,runtime,rows,summary:{development:summarize(rows.filter(r=>r.split==='development')),
    heldOut:summarize(heldout),heldOutEnglish:summarize(heldout.filter(r=>r.language==='en')),heldOutFrench:summarize(heldout.filter(r=>r.language==='fr'))}};
  await save('results/report.json',output);
  await writeFile('results/rows.csv','case,split,language,kind,method,recall,complete,precision,schemaTokens,selectedCount,extra\n'+rows.map(r=>[r.caseId,r.split,r.language,r.kind,r.method,r.recall,r.complete,r.precision,r.schemaTokens,r.selectedCount,r.extra].join(',')).join('\n')+'\n');
  console.log(JSON.stringify({jevCompleted:runs.length,fullCatalogTokens:manifest.fullCatalogTokens,runtime,summary:output.summary},null,2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command=process.argv[2];
  if(command==='prepare') await prepare(); else if(command==='report') await report(); else throw new Error('Use prepare or report.');
}
