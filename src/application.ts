import { TypeSafeClient } from '@typesafe-ai/sdk';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Candidate, Installation, InventoryReader, OriginalPolicy, Scope } from './contracts.js';
import { exists } from './context.js';
import { getApiKey } from './auth.js';
import { execSkills, listInstalled } from './npm.js';
import { candidateId, copyVerified, folderHash, mergeCatalogs, readState, reconcile, saveState, skillFolder } from './management.js';
import { discoverSkills, routeTask, type SkillMetadata } from './router.js';
import { refreshDescription } from './description.js';
import { readSkillMetadata } from './metadata.js';

export interface DecisionRequest {
  scope: Scope;
  kind: 'original_policy' | 'uncommon_skill';
  question: string;
  options: string[];
  candidate?: Candidate;
}

export type Preparation = { status: 'prepared'; catalog: SkillMetadata[] } |
  { status: 'needs_decision'; requests: DecisionRequest[] } |
  { status: 'needs_setup'; reason: 'api_key' | 'empty_catalog'; message: string; command?: string[] } |
  { status: 'needs_attention'; conflicts: Array<{ scope: Scope; name: string; path: string; reason: string }> };

async function migrateCatalog(installation: Installation): Promise<void> {
  await mkdir(join(installation.stateDirectory, 'skills'), { recursive: true });
  const legacy = join(dirname(installation.routerPath), 'skills');
  if (await exists(legacy)) {
    const before = await folderHash(legacy);
    async function merge(source: string, destination: string): Promise<void> {
      if (await exists(join(source, 'SKILL.md'))) { await copyVerified(source, destination); return; }
      await mkdir(destination, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        const path = join(source, entry.name);
        if (entry.isDirectory() || entry.isSymbolicLink() && (await stat(path)).isDirectory()) await merge(path, join(destination, entry.name));
        else {
          const contents = await readFile(path);
          await writeFile(join(destination, entry.name), contents);
          if (!(await readFile(join(destination, entry.name))).equals(contents)) throw new Error(`Import verification failed: ${path}`);
        }
      }
    }
    await merge(legacy, join(installation.stateDirectory, 'skills/legacy'));
    if (await folderHash(legacy) !== before) throw new Error('Manual catalog changed during migration. Original preserved.');
    await rm(legacy, { recursive: true });
  }
  const cache = join(dirname(installation.routerPath), '.jev-skills-router-cache.json');
  const durable = join(installation.stateDirectory, '.jev-skills-router-cache.json');
  if (await exists(cache) && !await exists(durable)) await writeFile(durable, await readFile(cache));
}

export async function configurePolicy(installation: Installation, policy: OriginalPolicy): Promise<void> {
  const state = await readState(installation);
  state.policy = policy;
  await saveState(installation, state);
}

export async function decideCandidate(installation: Installation, id: string, accepted: boolean, list: InventoryReader = listInstalled): Promise<void> {
  const inventory = await list(installation.root, installation.scope === 'global');
  let found = false;
  for (const entry of inventory) {
    if (!entry.agents.some((provider) => installation.providers.includes(provider))) continue;
    const metadata = await readSkillMetadata(join(entry.path, 'SKILL.md'));
    if (metadata && candidateId(metadata) === id) found = true;
  }
  if (!found) throw new Error('Candidate changed or disappeared. Run discovery again before deciding.');
  const state = await readState(installation);
  state.ignored = state.ignored.filter((value) => value !== id);
  state.approved = state.approved.filter((value) => value !== id);
  (accepted ? state.approved : state.ignored).push(id);
  await saveState(installation, state);
}

export async function prepareCatalog(installations: Installation[], options: { list?: InventoryReader; apiKey?: string } = {}): Promise<Preparation> {
  const list = options.list ?? listInstalled;
  const requests: DecisionRequest[] = [];
  const conflicts: Array<{ scope: Scope; name: string; path: string; reason: string }> = [];
  const catalogs: Array<{ scope: Scope; skills: SkillMetadata[] }> = [];
  for (const installation of installations) {
    await migrateCatalog(installation);
    const state = await readState(installation);
    if (!state.policy) {
      requests.push({ scope: installation.scope, kind: 'original_policy',
        question: `For existing and future skills imported into the ${installation.scope} catalog, what should happen to their originals?`,
        options: ['disable', 'delete', 'keep'] });
      continue;
    }
    // Removal can expose another same-name copy hidden by upstream's name-based inventory.
    let inventory = await list(installation.root, installation.scope === 'global');
    const seen = new Set<string>();
    while (true) {
      const signature = JSON.stringify(inventory);
      if (seen.has(signature)) break;
      seen.add(signature);
      const result = await reconcile(installation, inventory);
      for (const candidate of result.pending) requests.push({ scope: installation.scope, kind: 'uncommon_skill', candidate,
        question: `${candidate.name} is available in ${candidate.providers.join(', ')}. Share it through this ${installation.scope} router installation?`,
        options: ['import', 'ignore'] });
      conflicts.push(...result.conflicts.map((conflict) => ({ ...conflict, scope: installation.scope })));
      if (state.policy === 'keep' || result.imported === 0 || result.imported === result.conflicts.length) break;
      inventory = await list(installation.root, installation.scope === 'global');
    }
    const skills = await discoverSkills([join(installation.stateDirectory, 'skills')]);
    if (!skills.length) await refreshDescription(installation.routerPath, [], undefined, installation.stateDirectory);
    catalogs.push({ scope: installation.scope, skills });
  }
  if (requests.length) return { status: 'needs_decision', requests: requests.filter((request, index) =>
    requests.findIndex((item) => item.scope === request.scope && item.kind === request.kind && item.candidate?.id === request.candidate?.id) === index) };
  if (conflicts.length) return { status: 'needs_attention', conflicts };
  const catalog = mergeCatalogs(catalogs);
  if (!catalog.length) return { status: 'needs_setup', reason: 'empty_catalog', message: 'No task skills are available. Add a skill with jev-skills-router add SOURCE.' };
  if (!options.apiKey) return { status: 'needs_setup', reason: 'api_key',
    message: 'Jev requires your API key. Run auth in your own terminal; never send the key through chat.',
    command: ['node', join(dirname(installations[0]!.routerPath), 'scripts/jev-skills-router.mjs'), 'auth'] };
  return { status: 'prepared', catalog };
}

export async function refreshInstallations(installations: Installation[], catalog: SkillMetadata[], apiKey: string): Promise<void> {
  const client = new TypeSafeClient({ apiKey });
  for (const installation of installations) {
    // The project description reflects its combined view; global descriptions remain global.
    const visible = installation.scope === 'global' ? await discoverSkills([join(installation.stateDirectory, 'skills')]) : catalog;
    await refreshDescription(installation.routerPath, visible, client, installation.stateDirectory);
  }
}

export async function routeManaged(installations: Installation[], task: string, loaded: string[], list?: InventoryReader) {
  if (!task.trim()) throw new Error('Task must not be blank.');
  const apiKey = await getApiKey();
  const preparation = await prepareCatalog(installations, { list, apiKey });
  if (preparation.status !== 'prepared') return preparation;
  await refreshInstallations(installations, preparation.catalog, apiKey!);
  return { status: 'ready', ...await routeTask({ task, roots: [], catalog: preparation.catalog, loaded }, new TypeSafeClient({ apiKey: apiKey! })) };
}

export async function addRequested(installation: Installation, source: string, names: string[] = [], run = execSkills): Promise<string[]> {
  await migrateCatalog(installation);
  const root = join(installation.stateDirectory, 'skills');
  const before = new Map(await Promise.all((await discoverSkills([root])).map(async (skill) => [skill.path, await readFile(skill.path, 'utf8')] as const)));
  const requested = new Set(names);
  const local = resolve(source);
  if (await exists(local)) {
    const entry = local.toLowerCase().endsWith('.md') ? local : join(local, 'SKILL.md');
    if (await exists(entry)) {
      const metadata = await readSkillMetadata(entry);
      if (metadata) requested.add(metadata.name);
    } else for (const metadata of await discoverSkills([local])) requested.add(metadata.name);
  }
  if (await exists(local) && local.toLowerCase().endsWith('.md')) {
    const metadata = await readSkillMetadata(local);
    if (!metadata) throw new Error(`Not a task skill: ${source}`);
    const destination = join(root, '.agents/skills', skillFolder(metadata.name));
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'SKILL.md'), await readFile(local));
  } else {
    if (!await exists(local) && /^(?:[./\\]|[a-z]:[\\/])/i.test(source)) throw new Error(`Skill path does not exist: ${source}`);
    await run(['add', await exists(local) ? local : source, '--agent', 'codex', '--yes',
      ...(names.length ? ['--skill', ...names] : [])], root);
  }
  const lockPath = join(root, 'skills-lock.json');
  if (await exists(lockPath)) {
    const lock: { skills: Record<string, { source?: string; sourceUrl?: string }> } = JSON.parse(await readFile(lockPath, 'utf8'));
    for (const [name, record] of Object.entries(lock.skills)) {
      if (record.source === source || record.sourceUrl === source) requested.add(name);
    }
  }
  const state = await readState(installation);
  const added: string[] = [];
  for (const metadata of await discoverSkills([root])) {
    if (!requested.has(metadata.name) && before.get(metadata.path) === await readFile(metadata.path, 'utf8')) continue;
    added.push(metadata.name);
    const id = candidateId(metadata);
    state.ignored = state.ignored.filter((value) => value !== id);
    if (!state.approved.includes(id)) state.approved.push(id);
  }
  await saveState(installation, state);
  return added;
}
