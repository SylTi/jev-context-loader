import type { NoulResponse } from '@typesafe-ai/sdk';

export const MIN_MATCH_PROBABILITY = 0.75;

export function readProbability(answers: Record<string, NoulResponse>, id: string): number {
  const answer = answers[id];
  if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) {
    throw new Error(`Invalid Jev answer for ${id}`);
  }
  return answer.noul;
}
