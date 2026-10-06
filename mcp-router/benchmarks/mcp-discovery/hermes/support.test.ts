import assert from 'node:assert/strict';
import test from 'node:test';
import {selectTools, apiCost, fixtureId} from './support.js';

test('native retains all tools; replay retains the inclusive threshold and no others', () => {
  const tools=[{id:'linear.get_issue'},{id:'github.get_pr_info'},{id:'spaces.read_page'}];
  assert.deepEqual(selectTools(tools,'native',[.1,.75,.749]),tools);
  assert.deepEqual(selectTools(tools,'jev',[.1,.75,.749]),[tools[1]]);
  assert.throws(()=>selectTools(tools,'jev',[.75]),/score count/);
});

test('only names in the frozen catalog can reach the fixture executor', () => {
  const ids=new Set(['linear.get_issue']);
  assert.equal(fixtureId('mcp__linear__get_issue',ids),'linear.get_issue');
  assert.throws(()=>fixtureId('terminal',ids),/fixture/);
  assert.throws(()=>fixtureId('mcp__github__delete_issue',ids),/fixture/);
});

test('GLM cost counts cache as a subset and reasoning within output; unknown usage is unknown', () => {
  assert.equal(apiCost([{inputTokens:1000,cachedInputTokens:800,cacheWriteInputTokens:0,outputTokens:50,reasoningOutputTokens:30}]),(200*.15+800*.03+50*.5)/1e6);
  assert.equal(apiCost([]),null);
  assert.equal(apiCost([{inputTokens:1000,cachedInputTokens:0,cacheWriteInputTokens:20,outputTokens:50,reasoningOutputTokens:0}]),null);
});
