export interface OpenCodeTokens {input:number;output:number;reasoning:number;cache:{read:number;write:number}}
// OpenCode stores non-cached input and visible output separately from cache/reasoning.
export function contextTokens(tokens:OpenCodeTokens):number {return tokens.input+tokens.cache.read+tokens.cache.write;}
export function glmCost(samples:OpenCodeTokens[]):number|null {
  if(!samples.length||samples.some(t=>t.cache.write>0))return null;
  return samples.reduce((sum,t)=>sum+(t.input*.15+t.cache.read*.03+(t.output+t.reasoning)*.5)/1e6,0);
}

export function replayCosts(modelCostUsd:number|null,rankingInputTokens:number,uncachedSearches:number) {
  const singleRouteJevCostUsd=uncachedSearches?rankingInputTokens*.042/1e6:0;
  const perSearchJevCostUsd=singleRouteJevCostUsd*uncachedSearches;
  return {singleRouteJevCostUsd,perSearchJevCostUsd,
    singleRouteTotalCostUsd:modelCostUsd===null?null:modelCostUsd+singleRouteJevCostUsd,
    perSearchTotalCostUsd:modelCostUsd===null?null:modelCostUsd+perSearchJevCostUsd};
}
