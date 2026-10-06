import { noul, TypeSafeClient, type NoulQuestion } from '@typesafe-ai/sdk';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CATEGORIES, CATEGORY_GROUPS, type Category } from './categories.js';
import { MIN_MATCH_PROBABILITY, readProbability } from './judgments.js';
import { writeRouterDescription } from './metadata.js';
import type { SkillMetadata } from './router.js';

interface Classification {
  groups: string[];
  categories: string[];
}

interface ClassificationCache {
  taxonomyHash: string;
  skills: Record<string, Classification>;
}

const CLASSIFICATION_BATCH_SIZE = 128;

const question = 'Is the task family in `category` an intended use of this skill? ' +
  'Judge each category independently. Respect the skill description\'s scope and exclusions. ' +
  'An incidental mention or a supporting step is insufficient.';
const groupQuestion = 'Does this skill support at least one intended task within `group`? ' +
  'Use the domain scope in its description. Any supported task counts; the skill need not cover the whole domain. ' +
  'Judge each domain independently, including shared tasks. A skill may match several domains. ' +
  'An incidental mention or a supporting step is insufficient.';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const hash = (value: unknown) => sha256(JSON.stringify(value));
const taxonomyHash = hash({ strategy: 'shared-domain-hierarchy-v1', groups: CATEGORY_GROUPS, categories: CATEGORIES,
  groupQuestion, question, threshold: MIN_MATCH_PROBABILITY });

async function readCache(path: string): Promise<ClassificationCache> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { taxonomyHash, skills: {} };
    throw error;
  }
  const cache: ClassificationCache = JSON.parse(source);
  if (cache.taxonomyHash !== taxonomyHash) return { taxonomyHash, skills: {} };
  const ids = new Set(CATEGORIES.map((category) => category.id));
  const groups = new Set(CATEGORY_GROUPS.map((group) => group.label));
  if (!cache.skills || typeof cache.skills !== 'object' || Array.isArray(cache.skills) ||
      Object.values(cache.skills).some((matches) => !matches ||
        !Array.isArray(matches.groups) || matches.groups.some((group) => !groups.has(group)) ||
        !Array.isArray(matches.categories) || matches.categories.some((id) => !ids.has(id)))) {
    throw new Error(`Invalid jev-skills-router classification cache: ${path}`);
  }
  return cache;
}

function describe(classifications: Classification[]): string {
  const suffix = '. Route new matching tasks first; reuse results and loaded skills; reroute only on material scope changes.';
  if (!classifications.length) return 'Discover user-installed skills through jev-skills-router. Its catalog is currently empty' + suffix;
  const matched = new Set(classifications.flatMap((classification) => classification.categories));
  const categories = CATEGORIES.filter((category) => matched.has(category.id));
  const broad = new Set(classifications.flatMap((classification) => classification.groups));
  const domains = CATEGORY_GROUPS.filter((group) => broad.has(group.label)).map((group) => group.label);
  if (!domains.length) return 'Use jev-skills-router when explicitly requested; no catalog capabilities currently meet the classification threshold' + suffix;
  const format = (labels: string[]) => 'Route ' + labels.join(', ') +
    ' tasks through jev-skills-router' + suffix;
  const detailed = format([...domains, ...categories.map((category) => category.label)]);
  if (detailed.length <= 1024) return detailed;
  const selected = [...domains];
  const represented = new Set<string>();
  const compact = [...categories].sort((a, b) => a.label.length - b.label.length);
  const include = (category: Category): boolean => {
    if (selected.includes(category.label) || format([...selected, category.label]).length > 1024) return false;
    selected.push(category.label);
    for (const group of category.groups) represented.add(group);
    return true;
  };
  // Give distinct domains a detailed match before filling the remaining space.
  for (const domain of domains) {
    if (represented.has(domain)) continue;
    for (const category of compact) {
      if (category.groups.includes(domain) && include(category)) break;
    }
  }
  for (const category of compact) include(category);
  return format(selected);
}

export async function refreshDescription(path: string, catalog: SkillMetadata[], client?: TypeSafeClient, cacheDirectory = dirname(path)): Promise<void> {
  const cachePath = join(cacheDirectory, '.jev-skills-router-cache.json');
  const cache = await readCache(cachePath);
  const unique = new Map(catalog.map(({ name, description }) =>
    [sha256(sha256(name) + sha256(description)), { name, description }]));
  const skills: Record<string, Classification> = {};
  // Bound question batches as the taxonomy grows. Metadata is cached only after every batch succeeds.
  for (const [fingerprint, skill] of unique) {
    if (cache.skills[fingerprint]) {
      skills[fingerprint] = cache.skills[fingerprint];
      continue;
    }
    const groupQuestions = Object.fromEntries(CATEGORY_GROUPS.map((group, index) =>
      [`g${index}`, noul({ question: groupQuestion, group: { label: group.label, description: group.description } })]));
    const { answers: groupAnswers } = await (client ??= new TypeSafeClient()).systemOne({
      state: { purpose: 'catalog-classification', stage: 'groups', skill }, questions: groupQuestions,
    });
    const accepted = CATEGORY_GROUPS.filter((_group, index) =>
      readProbability(groupAnswers, `g${index}`) >= MIN_MATCH_PROBABILITY).map((group) => group.label);
    // Shared leaves are classified once if any accepted parent makes them reachable.
    const candidates = CATEGORIES.filter((category) => category.groups.some((group) => accepted.includes(group)));
    const matches: string[] = [];
    for (let offset = 0; offset < candidates.length; offset += CLASSIFICATION_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + CLASSIFICATION_BATCH_SIZE);
      const questions: Record<string, NoulQuestion> = Object.fromEntries(batch.map((category, index) =>
        [`c${offset + index}`, noul({ question, category: { label: category.label, groups: category.groups } })]));
      const { answers } = await (client ??= new TypeSafeClient()).systemOne({
        state: { purpose: 'catalog-classification', stage: 'categories', skill }, questions,
      });
      matches.push(...batch.filter((_category, index) =>
        readProbability(answers, `c${offset + index}`) >= MIN_MATCH_PROBABILITY).map((category) => category.id));
    }
    skills[fingerprint] = { groups: accepted, categories: matches };
  }
  await writeRouterDescription(path, describe(Object.values(skills)));
  const next = JSON.stringify({ taxonomyHash, skills });
  if (next !== JSON.stringify(cache)) await writeFile(cachePath, next + '\n');
}
