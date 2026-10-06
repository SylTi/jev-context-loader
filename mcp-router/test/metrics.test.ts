import assert from 'node:assert/strict';
import test from 'node:test';
import {contextTokens,glmCost,replayCosts} from '../scripts/metrics.js';

test('OpenCode accounting includes cached context and reasoning output once',()=>{
  const usage={input:1000,output:100,reasoning:200,cache:{read:9000,write:0}};
  assert.equal(contextTokens(usage),10000);
  assert.equal(glmCost([usage]),.00057);
  assert.equal(glmCost([]),null);
  assert.equal(glmCost([{...usage,cache:{read:9000,write:5}}]),null);
});

test('replay prices uncached searches separately and retains the optimistic one-route estimate',()=>{
  const costs=replayCosts(.001,50000,12);
  assert.ok(Math.abs(costs.singleRouteTotalCostUsd!-.0031)<1e-12);
  assert.ok(Math.abs(costs.perSearchTotalCostUsd!-.0262)<1e-12);
  assert.equal(replayCosts(.001,50000,0).perSearchTotalCostUsd,.001);
  assert.equal(replayCosts(null,50000,1).perSearchTotalCostUsd,null);
});
