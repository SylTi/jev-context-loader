import {noul,TypeSafeClient,type NoulQuestion,type NoulResponse} from '@typesafe-ai/sdk';
import type {Ranker} from './router.js';

interface JevClient {
  systemOne(request:{state:{task:string};questions:Record<string,NoulQuestion>}):Promise<{
    answers:Record<string,NoulResponse>;model:string;usage:{input_tokens:number;output_tokens:number}
  }>;
}
export function createJevRanker(client:JevClient=new TypeSafeClient()):Ranker {
  return async(query,tools)=>{
    const questions:Record<string,NoulQuestion>={};
    tools.forEach((tool,i)=>{
      questions[`t${i}`]=noul({
        question:'Should this tool be available to complete the current task? Evaluate each tool independently; multiple tools may be required. Respect explicit requested services, exclusions, and instructions not to use tools. Include necessary prerequisite operations, but shared keywords alone do not make a tool relevant.',
        tool:{name:tool.name,description:tool.description??''},
      });
    });
    const response=await client.systemOne({state:{task:query},questions});
    return {mode:'live',model:response.model,usage:response.usage,scores:tools.map((_,i)=>{
      const answer=response.answers[`t${i}`];
      if(!answer||answer.type!=='noul')throw new Error(`Missing Jev score: t${i}`);
      return answer.noul;
    })};
  };
}
