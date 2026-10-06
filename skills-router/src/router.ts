import { noul, TypeSafeClient, type NoulQuestion } from '@typesafe-ai/sdk';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readSkillMetadata } from './metadata.js';
import { refreshDescription } from './description.js';
import { MIN_MATCH_PROBABILITY, readProbability } from './judgments.js';

export interface SkillMetadata {
  name: string;
  description: string;
  path: string;
}

export interface RouteInput {
  task: string;
  roots: string[];
  loaded?: string[];
  routerPath?: string;
  catalog?: SkillMetadata[];
  cacheDirectory?: string;
}

export interface DisclosedSkill extends SkillMetadata {
  instructions: string;
  matchProbability: number;
}

export interface RouteResult {
  skills: DisclosedSkill[];
}

export { MIN_MATCH_PROBABILITY };

export async function discoverSkills(roots: string[]): Promise<SkillMetadata[]> {
  const visited = new Set<string>();
  const files = new Set<string>();
  const catalog: SkillMetadata[] = [];
  async function addFile(path: string): Promise<void> {
    const canonical = await realpath(path);
    if (files.has(canonical)) return;
    files.add(canonical);
    const skill = await readSkillMetadata(canonical);
    if (skill) catalog.push(skill);
  }
  async function walk(directory: string, root = false): Promise<void> {
    const canonical = await realpath(directory);
    if (visited.has(canonical)) return;
    visited.add(canonical);
    const entries = await readdir(canonical, { withFileTypes: true });
    if (!root && entries.some((entry) => entry.name === 'SKILL.md')) {
      await addFile(join(canonical, 'SKILL.md'));
      return;
    }
    for (const entry of entries) {
      if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
      const path = join(canonical, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDirectory = (await stat(path)).isDirectory();
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
          throw error;
        }
      }
      if (isDirectory) {
        await walk(path);
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        await addFile(path);
      }
    }
  }
  for (const root of roots) await walk(resolve(root), true);
  return catalog.sort((a, b) => a.path.localeCompare(b.path));
}

export async function routeTask(input: RouteInput, client?: TypeSafeClient): Promise<RouteResult> {
  if (!input.task.trim()) throw new Error('Task must not be blank.');
  const loaded = new Set(await Promise.all((input.loaded ?? []).map((path) => realpath(path))));
  const catalog = input.catalog ?? await discoverSkills(input.roots);
  if (input.routerPath) await refreshDescription(input.routerPath, catalog, client, input.cacheDirectory);
  const candidates = catalog.filter((skill) => !loaded.has(skill.path));
  if (!candidates.length) return { skills: [] };

  const questions: Record<string, NoulQuestion> = {};
  candidates.forEach((skill, index) => {
    questions[`s${index}`] = noul({
      question: 'Should this skill be used for the current task or phase? ' +
        'Evaluate it independently; other skills may also apply. ' +
        'Respect explicit skill requests and the description\'s triggers and exclusions. ' +
        'Shared keywords alone do not make a skill relevant.',
      skill: { name: skill.name, description: skill.description },
    });
  });
  const { answers } = await (client ?? new TypeSafeClient()).systemOne({
    state: { task: input.task },
    questions,
  });
  const selected: (SkillMetadata & { matchProbability: number })[] = [];
  for (const [index, skill] of candidates.entries()) {
    const matchProbability = readProbability(answers, `s${index}`);
    if (matchProbability >= MIN_MATCH_PROBABILITY) selected.push({ ...skill, matchProbability });
  }
  return {
    skills: await Promise.all(selected.map(async (skill) => ({
      ...skill, instructions: await readFile(skill.path, 'utf8'),
    }))),
  };
}
