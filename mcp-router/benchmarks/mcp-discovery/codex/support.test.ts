import assert from 'node:assert/strict';
import test from 'node:test';
import { schemaFromDeclaration, cost, gradeCompletion, disabledMcpServers } from './support.js';

test('reconstructs required fields, nested arrays, comments and literal unions', () => {
  const result = schemaFromDeclaration('declare const tools: { example(args: {\n// Exact issue ID\nid: string; state?: "open" | "closed"; rows: Array<{count: number;}>; }): Promise<unknown>; };');
  assert.deepEqual(result.required, ['id', 'rows']);
  assert.equal((result.properties as Record<string, Record<string, unknown>>).id?.description, 'Exact issue ID');
  assert.deepEqual((result.properties as Record<string, Record<string, unknown>>).state?.enum, ['open', 'closed']);
});

test('reads the TypeScript fence from the real catalog format', () => {
  const schema=schemaFromDeclaration('Read issue details.\n\nexec tool declaration:\n```ts\ndeclare const tools: { example(args: { id: string; }): Promise<unknown>; };\n```');
  assert.deepEqual(schema.required,['id']);
  assert.deepEqual(schema.properties,{id:{type:'string'}});
});

test('disables every configured MCP server without copying its credentials', () => {
  assert.deepEqual(disabledMcpServers({mcp_servers:{linear:{url:'https://example.test',token:'secret'},custom:{command:'server'}}}),{linear:{enabled:false},custom:{enabled:false}});
});

test('prices cached input as a subset and does not double count reasoning', () => {
  assert.equal(cost({inputTokens: 1000, cachedInputTokens: 800, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 30}), (200 * 2 + 800 * .1 + 50 * 10) / 1e6);
});

test('completion requires facts, valid execution and no forbidden writes', () => {
  const task = {id:'x', task:'Read issue', required:[['linear.get_issue']]};
  const call = {id:'linear.get_issue', args:{id:'ENG-123'}, valid:true, receipt:'unpredictable-receipt', fact:'token-expiry'};
  const answer = 'token-expiry unpredictable-receipt';
  assert.equal(gradeCompletion(task, [call], answer).pass, true);
  assert.equal(gradeCompletion(task, [call], 'unpredictable-receipt').pass, false);
  assert.equal(gradeCompletion(task, [{...call, valid:false}], answer).pass, false);
  assert.equal(gradeCompletion(task, [call, {...call,id:'linear.save_issue'}], answer).pass, false);
});
