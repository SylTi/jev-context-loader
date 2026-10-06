import assert from 'node:assert/strict';
import { realpath, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { reconcile, resetIgnored, readState, saveState, candidateId, mergeCatalogs } from '../src/management.js';
import { resolveInstallations, selectDestination } from '../src/context.js';
import type { Installation, InstalledSkill } from '../src/contracts.js';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-management space-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const router = join(root, '.agents/skills/jev-skills-router');
  await mkdir(router, { recursive: true });
  await writeFile(join(router, 'SKILL.md'), '---\nname: jev-skills-router\ndescription: Router.\n---\nBODY');
  const installation: Installation = { scope: 'project', root, routerPath: join(router, 'SKILL.md'),
    stateDirectory: join(root, '.agents/jev-skills-router'), providers: ['Codex', 'Claude Code'] };
  async function skill(name: string, providers: string[], body = 'BODY', description = 'Task skill.') {
    const path = join(root, 'external', name);
    await mkdir(join(path, 'references'), { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
    await writeFile(join(path, 'references/style.md'), 'RESOURCE');
    return { name, path, agents: providers, scope: 'project' } satisfies InstalledSkill;
  }
  return { root, installation, skill };
}

test('common imports are automatic, uncommon decisions persist, and reset only clears ignored candidates', async (t) => {
  const f = await fixture(t);
  const common = await f.skill('common', ['Codex', 'Claude Code']);
  const unique = await f.skill('unique', ['Claude Code']);
  await saveState(f.installation, { policy: 'keep', ignored: [], approved: [], imports: {} });
  let result = await reconcile(f.installation, [common, unique]);
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0]!.name, 'unique');
  assert.match(await readFile(join(f.installation.stateDirectory, 'skills/.agents/skills/common/SKILL.md'), 'utf8'), /BODY/);
  assert.equal(await readFile(join(f.installation.stateDirectory, 'skills/.agents/skills/common/references/style.md'), 'utf8'), 'RESOURCE');
  const state = await readState(f.installation);
  state.ignored.push(result.pending[0]!.id);
  await saveState(f.installation, state);
  result = await reconcile(f.installation, [common, unique]);
  assert.equal(result.pending.length, 0);
  await resetIgnored(f.installation);
  assert.equal((await readState(f.installation)).policy, 'keep');
  assert.equal((await reconcile(f.installation, [common, unique])).pending.length, 1);
});

test('disable preserves a verified backup and reapplies the saved choice to an unchanged reinstall', async (t) => {
  const f = await fixture(t);
  const original = await f.skill('common', ['Codex', 'Claude Code']);
  await saveState(f.installation, { policy: 'disable', ignored: [], approved: [], imports: {} });
  await reconcile(f.installation, [original]);
  await assert.rejects(readFile(join(original.path, 'SKILL.md')), { code: 'ENOENT' });
  const state = await readState(f.installation);
  assert.ok(Object.values(state.imports)[0]!.backup);
  assert.equal(await readFile(join(Object.values(state.imports)[0]!.backup!, 'references/style.md'), 'utf8'), 'RESOURCE');
  await f.skill('common', ['Codex', 'Claude Code'], 'UPDATED BODY');
  await reconcile(f.installation, [original]);
  assert.match(await readFile(join(f.installation.stateDirectory, 'skills/.agents/skills/common/SKILL.md'), 'utf8'), /UPDATED BODY/);
  await assert.rejects(readFile(join(original.path, 'SKILL.md')), { code: 'ENOENT' });
});

test('an uncommon skill is not deleted until approved and originals used by other providers are preserved', async (t) => {
  const f = await fixture(t);
  const original = await f.skill('unique', ['Claude Code']);
  await saveState(f.installation, { policy: 'delete', ignored: [], approved: [], imports: {} });
  const first = await reconcile(f.installation, [original]);
  assert.equal(first.pending.length, 1);
  assert.ok(await readFile(join(original.path, 'SKILL.md'), 'utf8'));
  const state = await readState(f.installation);
  state.approved.push(first.pending[0]!.id);
  await saveState(f.installation, state);
  await reconcile(f.installation, [original]);
  await assert.rejects(readFile(join(original.path, 'SKILL.md')), { code: 'ENOENT' });
  const shared = await f.skill('shared', ['Codex', 'Claude Code', 'Cursor']);
  const result = await reconcile(f.installation, [shared]);
  assert.equal(result.conflicts.length, 1);
  assert.ok(await readFile(join(shared.path, 'SKILL.md'), 'utf8'));
});

test('global skills win by declared name regardless of path order', async (t) => {
  const f = await fixture(t);
  const local = await f.skill('same', ['Codex'], 'LOCAL');
  const global = { name: 'same', description: 'Global version.', path: join(f.root, 'global/SKILL.md') };
  const merged = mergeCatalogs([{ scope: 'project', skills: [{ name: 'same', description: 'Local.', path: join(local.path, 'SKILL.md') }] },
    { scope: 'global', skills: [global] }]);
  assert.deepEqual(merged, [global]);
});

test('scope selection asks only for genuine ambiguity and finds project installs from subdirectories', async (t) => {
  const f = await fixture(t);
  const home = join(f.root, 'home');
  const globalRouter = join(home, '.agents/skills/jev-skills-router');
  await mkdir(globalRouter, { recursive: true });
  await writeFile(join(globalRouter, 'SKILL.md'), '---\nname: jev-skills-router\ndescription: Router.\n---');
  const cwd = join(f.root, 'src/nested');
  await mkdir(cwd, { recursive: true });
  const list = async (root: string, global: boolean): Promise<InstalledSkill[]> => global || root === f.root ? [
    { name: 'jev-skills-router', path: global ? globalRouter : join(root, '.agents/skills/jev-skills-router'),
      agents: ['Codex'], scope: global ? 'global' : 'project' },
  ] : [];
  const installations = await resolveInstallations({ cwd, home, list });
  assert.deepEqual(installations.map((i) => i.scope), ['global', 'project']);
  assert.equal(installations[1]!.root, f.root);
  assert.equal(selectDestination(installations).status, 'scope_required');
  assert.equal(selectDestination(installations, 'global').status, 'selected');
  assert.equal(selectDestination([installations[0]!]).status, 'selected');
  assert.throws(() => selectDestination([installations[0]!], 'project'), /project/i);
});

test('candidate identity follows name and description, not copied paths or body changes', () => {
  assert.equal(candidateId({ name: 'pdf', description: 'PDFs.', path: 'a' }), candidateId({ name: 'pdf', description: 'PDFs.', path: 'b' }));
  assert.notEqual(candidateId({ name: 'pdf', description: 'PDFs.', path: 'a' }), candidateId({ name: 'pdf', description: 'New task.', path: 'a' }));
});
