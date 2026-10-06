import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ROUTER_NAME, type CatalogState, type InstalledSkill, type Installation, type ReconcileResult, type Scope } from './contracts.js';
import { exists } from './context.js';
import { readSkillMetadata } from './metadata.js';
import type { SkillMetadata } from './router.js';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const candidateId = ({ name, description }: SkillMetadata) => sha256(sha256(name) + sha256(description));
export const skillFolder = (name: string) => name.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+|[.-]+$/g, '') || sha256(name);

export async function readState(installation: Installation): Promise<CatalogState> {
  const path = join(installation.stateDirectory, 'state.json');
  if (!await exists(path)) return { ignored: [], approved: [], imports: {} };
  const value: CatalogState = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(value.ignored) || !Array.isArray(value.approved) || !value.imports ||
      typeof value.imports !== 'object' || Array.isArray(value.imports) ||
      value.policy !== undefined && !['disable', 'delete', 'keep'].includes(value.policy)) {
    throw new Error(`Invalid catalog state: ${path}`);
  }
  return value;
}

export async function saveState(installation: Installation, state: CatalogState): Promise<void> {
  await mkdir(installation.stateDirectory, { recursive: true });
  const path = join(installation.stateDirectory, 'state.json');
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify(state, null, 2) + '\n');
  await rename(temporary, path);
}

export async function resetIgnored(installation: Installation): Promise<void> {
  const state = await readState(installation);
  state.ignored = [];
  await saveState(installation, state);
}

export async function folderHash(directory: string): Promise<string> {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const contents: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const directoryEntry = entry.isDirectory() || entry.isSymbolicLink() && (await stat(path)).isDirectory();
    contents.push(JSON.stringify([entry.name, directoryEntry ? await folderHash(path) : sha256(await readFile(path))]));
  }
  return sha256(contents.join('\n'));
}

export async function copyVerified(source: string, destination: string): Promise<string> {
  await mkdir(join(destination, '..'), { recursive: true });
  const stage = destination + '.importing';
  await rm(stage, { recursive: true, force: true });
  await cp(source, stage, { recursive: true, dereference: true });
  const hash = await folderHash(source);
  if (await folderHash(stage) !== hash) throw new Error(`Skill changed while importing: ${source}. Original preserved.`);
  await rm(destination, { recursive: true, force: true });
  await rename(stage, destination);
  return hash;
}

export async function reconcile(installation: Installation, inventory: InstalledSkill[]): Promise<ReconcileResult> {
  const state = await readState(installation);
  const result: ReconcileResult = { pending: [], conflicts: [], imported: 0 };
  if (!state.policy) return result;
  for (const entry of inventory) {
    if (entry.name === ROUTER_NAME || !entry.agents.some((agent) => installation.providers.includes(agent))) continue;
    const source = await realpath(entry.path);
    const insideState = relative(installation.stateDirectory, source);
    if (!insideState || !insideState.startsWith('..' + sep) && insideState !== '..' && !isAbsolute(insideState)) continue;
    const metadata = await readSkillMetadata(join(source, 'SKILL.md'));
    if (!metadata) continue;
    const id = candidateId(metadata);
    if (state.ignored.includes(id)) continue;
    const previouslyImported = Object.values(state.imports).some((record) => record.name === metadata.name);
    const common = installation.providers.length > 0 && installation.providers.every((provider) => entry.agents.includes(provider));
    if (!common && !previouslyImported && !state.approved.includes(id)) {
      result.pending.push({ id, name: metadata.name, providers: entry.agents, sourcePath: entry.path });
      continue;
    }
    const destination = join(installation.stateDirectory, 'skills/.agents/skills', skillFolder(metadata.name));
    const recordKey = sha256(resolve(entry.path));
    const previous = state.imports[recordKey];
    const contentHash = await folderHash(source);
    if (!previous || previous.contentHash !== contentHash || !await exists(destination) || state.policy !== 'keep') {
      await copyVerified(source, destination);
    }
    const record = { name: metadata.name, sourcePath: entry.path, destination, contentHash };
    state.imports[recordKey] = record;
    if (entry.source && entry.sourceType && entry.sourceType !== 'local') {
      const lockPath = join(installation.stateDirectory, 'skills/skills-lock.json');
      const lock: { version: number; skills: Record<string, unknown> } = await exists(lockPath) ? JSON.parse(await readFile(lockPath, 'utf8')) : { version: 1, skills: {} };
      if (!lock.skills[metadata.name]) lock.skills[metadata.name] = {
        source: entry.source, sourceType: entry.sourceType, ...(entry.sourceUrl ? { sourceUrl: entry.sourceUrl } : {}), computedHash: '',
      };
      await writeFile(lockPath, JSON.stringify(lock, null, 2) + '\n');
    }
    await saveState(installation, state);
    result.imported++;
    if (state.policy !== 'keep') {
      if (entry.agents.some((agent) => !installation.providers.includes(agent))) {
        result.conflicts.push({ name: entry.name, path: entry.path, reason: 'Original is also used by providers outside this installation. It was imported and left active.' });
        continue;
      }
      if (await folderHash(source) !== contentHash) throw new Error(`Skill changed before removing original: ${source}. Original preserved.`);
      if (state.policy === 'disable') {
        const backup = join(installation.stateDirectory, 'backups', sha256(resolve(entry.path)), contentHash);
        await copyVerified(source, backup);
        state.imports[sha256(resolve(entry.path))] = { ...record, backup };
        await saveState(installation, state);
      }
      // Remove only the exact inventory entry. A symlink never causes deletion of its target.
      await rm(entry.path, { recursive: true });
    }
  }
  return result;
}

export function mergeCatalogs(catalogs: Array<{ scope: Scope; skills: SkillMetadata[] }>): SkillMetadata[] {
  const skills = new Map<string, SkillMetadata>();
  for (const catalog of [...catalogs].sort((a, b) => a.scope === b.scope ? 0 : a.scope === 'global' ? 1 : -1)) {
    for (const skill of catalog.skills) skills.set(skill.name, skill);
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}
