import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { prepareCatalog, configurePolicy, decideCandidate, addRequested } from '../src/application.js';
import { saveApiKey } from '../src/auth.js';
import { candidateId, readState, saveState } from '../src/management.js';
import type { Installation, InstalledSkill } from '../src/contracts.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-app-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const router = join(root, '.agents/skills/jev-skills-router');
  await mkdir(router, { recursive: true });
  await writeFile(join(router, 'SKILL.md'), '---\nname: jev-skills-router\ndescription: Router.\n---\nBODY');
  const installation: Installation = { scope: 'project', root, routerPath: join(router, 'SKILL.md'),
    stateDirectory: join(root, '.agents/jev-skills-router'), providers: ['Codex', 'Claude Code'] };
  return { root, router, installation };
}

test('first invocation reports decisions and missing credentials rather than no matches', async (t) => {
  const f = await fixture(t);
  const list = async () => [];
  let result = await prepareCatalog([f.installation], { list });
  assert.equal(result.status, 'needs_decision');
  await configurePolicy(f.installation, 'keep');
  result = await prepareCatalog([f.installation], { list });
  assert.deepEqual(result.status, 'needs_setup');
  const source = join(f.root, 'custom.md');
  await writeFile(source, '---\nname: custom\ndescription: PRIVATE DESCRIPTION\n---\nPRIVATE BODY');
  await addRequested(f.installation, source);
  result = await prepareCatalog([f.installation], { list });
  assert.equal(result.status, 'needs_setup');
  if (result.status === 'needs_setup') assert.equal(result.reason, 'api_key');
  assert.equal(JSON.stringify(result).includes('PRIVATE DESCRIPTION'), false);
  assert.equal(JSON.stringify(result).includes('PRIVATE BODY'), false);
  assert.equal((await prepareCatalog([f.installation], { list, apiKey: 'test' })).status, 'prepared');
});

test('explicit addition clears an ignored candidate and folders use the existing skills CLI', async (t) => {
  const f = await fixture(t);
  await configurePolicy(f.installation, 'keep');
  const source = join(f.root, 'unique');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), '---\nname: unique\ndescription: A task.\n---\nBODY');
  const entries: InstalledSkill[] = [{ name: 'unique', path: source, scope: 'project', agents: ['Claude Code'] }];
  const list = async () => entries;
  const result = await prepareCatalog([f.installation], { list });
  assert.equal(result.status, 'needs_decision');
  if (result.status !== 'needs_decision') throw new Error('Expected decision');
  const id = result.requests[0]!.candidate!.id;
  await decideCandidate(f.installation, id, false, list);
  const other = { name: 'other', description: 'Another task.', path: join(f.root, 'other.md') };
  await writeFile(other.path, '---\nname: other\ndescription: Another task.\n---\nOTHER');
  await addRequested(f.installation, other.path);
  const saved = await readState(f.installation);
  saved.ignored.push(candidateId(other));
  await saveState(f.installation, saved);
  const calls: string[][] = [];
  await addRequested(f.installation, source, ['unique'], async (args, cwd) => {
    calls.push(args);
    const destination = join(cwd, '.agents/skills/unique');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'SKILL.md'), await readFile(join(source, 'SKILL.md')));
    return '';
  });
  assert.deepEqual(calls, [['add', source, '--agent', 'codex', '--yes', '--skill', 'unique']]);
  assert.equal((await readState(f.installation)).ignored.includes(id), false);
  assert.equal((await readState(f.installation)).ignored.includes(candidateId(other)), true);
});

test('catalog migration survives replacement of the installed router directory', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.router, 'skills/custom'), { recursive: true });
  await writeFile(join(f.router, 'skills/custom/SKILL.md'), '---\nname: custom\ndescription: A task.\n---\nPRESERVED');
  await configurePolicy(f.installation, 'keep');
  await prepareCatalog([f.installation], { list: async () => [], apiKey: 'test' });
  await mkdir(join(f.router, 'skills/second'), { recursive: true });
  await writeFile(join(f.router, 'skills/second/SKILL.md'), '---\nname: second\ndescription: Another task.\n---\nSECOND');
  await prepareCatalog([f.installation], { list: async () => [], apiKey: 'test' });
  assert.match(await readFile(join(f.installation.stateDirectory, 'skills/legacy/second/SKILL.md'), 'utf8'), /SECOND/);
  await rm(f.router, { recursive: true });
  assert.match(await readFile(join(f.installation.stateDirectory, 'skills/legacy/custom/SKILL.md'), 'utf8'), /PRESERVED/);
  assert.equal((await readState(f.installation)).policy, 'keep');
});

test('failed key validation preserves credentials and successful validation saves a private file', async (t) => {
  const f = await fixture(t);
  const path = join(f.root, 'config/credentials.json');
  const client = (valid: boolean) => new TypeSafeClient({ apiKey: 'test', fetch: async () => valid ?
    Response.json({ model: 'jev-latest', answers: { auth: { type: 'noul', noul: 1 } }, usage: { input_tokens: 0, output_tokens: 0 } }) :
    Response.json({ error: { message: 'invalid key' } }, { status: 401 }) });
  await saveApiKey('old-key', path, client(true));
  await assert.rejects(saveApiKey('bad-key', path, client(false)));
  assert.equal(JSON.parse(await readFile(path, 'utf8')).apiKey, 'old-key');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
});
