import ts from 'typescript';

export type Schema = Record<string, unknown>;
export interface Usage { inputTokens:number; cachedInputTokens:number; cacheWriteInputTokens?:number; outputTokens:number; reasoningOutputTokens:number }
export interface Task { id:string; task:string; required:string[][] }
export interface Call { id:string; args:Record<string, unknown>; valid:boolean; receipt:string; fact:string }

export function disabledMcpServers(config:Record<string,unknown>):Record<string,{enabled:false}> {
  return Object.fromEntries(Object.keys((config.mcp_servers??{}) as Record<string,unknown>).map(name=>[name,{enabled:false as const}]));
}

export function schemaFromDeclaration(text:string): Schema {
  const declaration=text.match(/```ts\s*\n([\s\S]*?)\n```/)?.[1]??text;
  const source = ts.createSourceFile('tool.ts', declaration, ts.ScriptTarget.Latest, true);
  let argument:ts.TypeNode|undefined;
  function find(node:ts.Node):void {
    if (ts.isParameter(node) && node.name.getText(source) === 'args') argument = node.type;
    else ts.forEachChild(node, find);
  }
  find(source);
  function convert(node:ts.TypeNode):Schema {
    if (ts.isParenthesizedTypeNode(node)) return convert(node.type);
    if (ts.isTypeLiteralNode(node)) {
      const properties:Record<string, Schema> = {}, required:string[] = [];
      for (const member of node.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue;
        const name = member.name.getText(source).replace(/^['"]|['"]$/g, '');
        const property = convert(member.type);
        const comments = ts.getLeadingCommentRanges(source.text, member.pos) ?? [];
        const description = comments.map(c => source.text.slice(c.pos, c.end).replace(/^\/\/\s*/, '').replace(/^\/\*|\*\/$/g, '').trim()).join('\n');
        if (description) property.description = description;
        properties[name] = property;
        if (!member.questionToken) required.push(name);
      }
      return {type:'object', properties, required, additionalProperties:false};
    }
    if (ts.isArrayTypeNode(node)) return {type:'array', items:convert(node.elementType)};
    if (ts.isTypeReferenceNode(node)) {
      if (node.typeName.getText(source) === 'Array' && node.typeArguments?.[0]) return {type:'array',items:convert(node.typeArguments[0])};
      return {};
    }
    if (ts.isUnionTypeNode(node)) {
      const options = node.types.map(convert);
      if (options.every(o => 'const' in o && typeof o.const === 'string')) return {type:'string',enum:options.map(o => o.const)};
      return {anyOf:options};
    }
    if (ts.isLiteralTypeNode(node)) {
      if (node.literal.kind === ts.SyntaxKind.NullKeyword) return {type:'null'};
      const literal = node.literal.getText(source);
      return {const:JSON.parse(literal)};
    }
    const primitives:Record<number,string> = {[ts.SyntaxKind.StringKeyword]:'string',[ts.SyntaxKind.NumberKeyword]:'number',[ts.SyntaxKind.BooleanKeyword]:'boolean'};
    return primitives[node.kind] ? {type:primitives[node.kind]} : {};
  }
  return argument ? convert(argument) : {type:'object',properties:{},required:[],additionalProperties:false};
}

// GPT-6.1-Sol standard, short context. Cache writes are a subset of input.
export function cost(usage:Usage):number {
  const writes = usage.cacheWriteInputTokens ?? 0;
  return ((usage.inputTokens-usage.cachedInputTokens-writes)*2 + usage.cachedInputTokens*.1 + writes*2.5 + usage.outputTokens*10)/1e6;
}

export function isWrite(id:string):boolean {
  return /\.(?:create|save|update|delete|remove|set|edit|patch|archive|restore|move|attach|add|publish|navigate|open|connect|compile|handoff|send|end|uninstall)/.test(id);
}

export function gradeCompletion(task:Task, calls:Call[], answer:string) {
  const missing = task.required.filter(group => !calls.some(c => group.includes(c.id) && c.valid && answer.includes(c.receipt) && answer.includes(c.fact)));
  const forbidden = calls.filter(c => isWrite(c.id) && !task.required.some(g => g.includes(c.id))).map(c => c.id);
  const noTool = task.required.length !== 0 || calls.length === 0;
  const arithmetic = task.id !== 'h25' || /\b391\b/.test(answer);
  return {pass:missing.length === 0 && forbidden.length === 0 && noTool && arithmetic,missing,forbidden,noTool,arithmetic};
}
