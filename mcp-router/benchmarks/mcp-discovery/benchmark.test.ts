import assert from 'node:assert/strict';
import test from 'node:test';
import { bm25, selectBudget, grade } from './benchmark.js';

const tools = [
  {id:'a', name:'github_read_issue', description:'Read one issue from GitHub.', definition:'A', tokens:110},
  {id:'b', name:'linear_read_issue', description:'Read one issue from Linear.', definition:'B', tokens:90},
  {id:'c', name:'linear_add_comment', description:'Publish a comment.', definition:'C', tokens:50},
];

test('BM25 resolves service-specific overlap and abstains on zero lexical overlap', () => {
  assert.equal(bm25(tools, 'Linear issue')[0]?.id, 'b');
  assert.deepEqual(bm25(tools, 'zyxwvut'), []);
});
test('budget selection never exceeds the schema budget or consults labels', () => {
  assert.deepEqual(selectBudget(tools, [{id:'a',score:3},{id:'b',score:2},{id:'c',score:1}], 150), ['a']);
  assert.deepEqual(selectBudget(tools, [{id:'a',score:3},{id:'b',score:2},{id:'c',score:1}], 100), ['b']);
});
test('grading accepts alternatives, catches omitted requirements, and treats no-tool cases separately', () => {
  assert.deepEqual(grade([['a','b'],['c']], ['b']), {recall:0.5, complete:false, precision:1, extra:0});
  assert.deepEqual(grade([], []), {recall:1, complete:true, precision:1, extra:0});
  assert.deepEqual(grade([], ['a']), {recall:0, complete:false, precision:0, extra:1});
});
