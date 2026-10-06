import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { findNpmCli, findSkillsCli } from '../src/npm.js';

const execute = promisify(execFile);
const source = fileURLToPath(new URL('../', import.meta.url));
const references = ['references/setup.md', 'references/catalog.md'];

async function sandbox(t: { after(fn: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-install space-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const home = join(root, 'home');
  await Promise.all([project, join(home, '.codex'), join(home, '.claude')].map((path) => mkdir(path, { recursive: true })));
  const cli = await findSkillsCli(source);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'), APPDATA: join(home, 'AppData/Roaming'),
    TYPESAFE_API_KEY: '', JEV_SKILLS_ROUTER_ROOTS: '', DISABLE_TELEMETRY: '1',
    JEV_SKILLS_ROUTER_SKILLS_CLI: cli };
  const skills = (args: string[]) => execute(process.execPath, [cli, ...args], { cwd: project, env });
  const installed = async (global = false) => {
    const entries = JSON.parse((await skills(['list', '--json', ...(global ? ['--global'] : [])])).stdout);
    return entries.find((entry: { name: string }) => entry.name === 'jev-skills-router').path as string;
  };
  const preload = join(root, 'mock.mjs');
  await writeFile(preload, `const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!init?.body) return originalFetch(url, init);
      const request = JSON.parse(init.body);
      if (!request.questions) return originalFetch(url, init);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) =>
        [id, { type: 'noul', noul: request.state.purpose === 'catalog-classification' ?
          request.state.stage === 'groups' ?
            question.instructions.group.label === 'documents and office work' ? 0.9 : 0.1 :
            question.instructions.category.label === 'Presentations' ? 0.9 : 0.1 : 0.9 }]));
      return Response.json({ model: 'jev-latest', answers, usage: { input_tokens: 0, output_tokens: 0 } });
    };`);
  const apiEnv: NodeJS.ProcessEnv = { ...env, TYPESAFE_API_KEY: 'test-key', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
  const invoke = async (script: string, args: string[], task?: string, environment = apiEnv, cwd = project) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, env: environment });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(task);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr);
    return JSON.parse(stdout);
  };
  const makeSkill = async (name: string, body = 'BODY', directory = join(root, name)) => {
    await mkdir(join(directory, 'references'), { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: PowerPoint decks.\n---\n${body}`);
    await writeFile(join(directory, 'references/style.md'), 'PRESERVED RESOURCE');
    return directory;
  };
  return { root, project, home, env, apiEnv, skills, installed, invoke, makeSkill };
}

for (const agent of ['codex', 'claude-code']) {
  test(`skills installs a self-contained launcher for ${agent}`, { timeout: 120000 }, async (t) => {
    const f = await sandbox(t);
    await f.skills(['add', source, '--skill', 'jev-skills-router', '--agent', agent, '--yes']);
    const installed = await f.installed();
    await rm(join(installed, 'node_modules'), { recursive: true, force: true });
    await rm(join(installed, 'dist'), { recursive: true, force: true });
    const launcher = join(installed, 'scripts/route.mjs');
    const help = await execute(process.execPath, [launcher, '--help'], { cwd: f.project, env: f.env });
    assert.match(help.stdout, /Usage:/);
    const result = await f.invoke(launcher, ['route'], 'Hello', f.env);
    assert.equal(result.status, 'needs_decision');
    assert.ok((await stat(join(f.project, '.agents/jev-skills-router/skills'))).isDirectory());
    assert.ok(await readFile(join(installed, 'SKILL.md'), 'utf8'));
    for (const reference of references) assert.ok(await readFile(join(installed, reference), 'utf8'));
  });
}

test('npm tarball installs a runnable CLI that manages the applicable skills installation', { timeout: 180000 }, async (t) => {
  const f = await sandbox(t);
  const npmCli = await findNpmCli();
  const packed = await execute(process.execPath, [npmCli, 'pack', source, '--ignore-scripts', '--json', '--pack-destination', f.root], { cwd: f.project });
  const tarball = (JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>)[0];
  assert.ok(tarball);
  const { filename, files } = tarball;
  assert.ok(files.some((file) => file.path === 'SKILL.md'));
  for (const reference of references) assert.ok(files.some((file) => file.path === reference), reference);
  assert.equal(files.some((file) => /^(src|test|node_modules)\//.test(file.path)), false);
  const prefix = join(f.root, 'npm prefix');
  await execute(process.execPath, [npmCli, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(f.root, filename)], { cwd: f.project });
  const bin = process.platform === 'win32' ? prefix : join(prefix, 'bin');
  const env: NodeJS.ProcessEnv = { ...f.apiEnv };
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = [bin, dirname(process.execPath), env[pathKey] ?? ''].join(delimiter);
  const invoke = async (args: string[], task?: string) => {
    const child = process.platform === 'win32' ?
      spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `jev-skills-router ${args.join(' ')}`], { cwd: f.project, env }) :
      spawn('jev-skills-router', args, { cwd: f.project, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(task);
    const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    assert.equal(code, 0, stderr);
    return stdout;
  };
  assert.match(await invoke(['--help']), /Usage:/);
  const cliDirectory = (await invoke(['path'])).trim();
  for (const reference of references) assert.ok(await readFile(join(cliDirectory, reference), 'utf8'));
  await f.skills(['add', source, '--skill', 'jev-skills-router', '--agent', 'codex', '--yes']);
  await f.skills(['add', await f.makeSkill('ppt'), '--agent', 'codex', '--yes']);
  assert.equal(JSON.parse(await invoke(['configure', '--policy', 'keep', '--json'])).status, 'ready');
  const routed = JSON.parse(await invoke(['route', '--json'], 'Create a presentation'));
  assert.equal(routed.skills[0].name, 'ppt');
  assert.ok(routed.skills[0].path.startsWith(f.project));
});

test('shared install exposes add, update and route through the platform command', { timeout: 180000 }, async (t) => {
  const f = await sandbox(t);
  await f.skills(['add', source, '--skill', 'jev-skills-router', '--agent', 'codex', 'claude-code', '--yes']);
  const installed = await f.installed();
  const linked = join(f.project, '.claude/skills/jev-skills-router');
  assert.equal(await realpath(installed), await realpath(linked));
  await rm(join(installed, 'node_modules'), { recursive: true, force: true });
  await rm(join(installed, 'dist'), { recursive: true, force: true });
  const script = join(installed, 'scripts/jev-skills-router.mjs');
  const bin = join(f.root, 'bin');
  await execute(process.execPath, [script, 'setup', '--bin-dir', bin], { cwd: f.project, env: f.env });
  const command = join(bin, process.platform === 'win32' ? 'jev-skills-router.cmd' : 'jev-skills-router');
  assert.ok((await stat(command)).isFile());
  const invoke = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...f.apiEnv };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
    env[pathKey] = bin + delimiter + (env[pathKey] ?? '');
    return process.platform === 'win32' ?
      execute(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `jev-skills-router ${args.map((arg) => `"${arg}"`).join(' ')}`], { cwd: f.project, env }) :
      execute('jev-skills-router', args, { cwd: f.project, env });
  };
  assert.equal((await invoke(['path'])).stdout.trim(), await realpath(installed));
  assert.match((await invoke(['--help'])).stdout, /Usage:/);
  await invoke(['configure', '--policy', 'keep']);
  const skill = await f.makeSkill('ppt', 'Read references/style.md.', join(f.root, 'my skill'));
  await invoke(['add', skill]);
  const privateRoot = join(f.project, '.agents/jev-skills-router/skills');
  assert.equal(await readFile(join(privateRoot, '.agents/skills/ppt/references/style.md'), 'utf8'), 'PRESERVED RESOURCE');
  assert.match(await readFile(join(linked, 'SKILL.md'), 'utf8'), /Presentations/);
  const result = await f.invoke(script, ['route'], 'Create a presentation');
  assert.equal(result.skills[0].name, 'ppt');
  const managed = await f.makeSkill('managed', 'MANAGED BODY');
  await invoke(['add', managed, '--skill', 'managed']);
  const lock = JSON.parse(await readFile(join(privateRoot, 'skills-lock.json'), 'utf8'));
  assert.equal(lock.skills.managed.sourceType, 'local');
  await invoke(['update']);
  assert.match(await readFile(join(privateRoot, '.agents/skills/managed/SKILL.md'), 'utf8'), /MANAGED BODY/);
  await f.skills(['add', source, '--skill', 'jev-skills-router', '--agent', 'codex', 'claude-code', '--yes']);
  assert.equal((await f.invoke(script, ['discover'])).status, 'ready');
  assert.match(await readFile(join(privateRoot, '.agents/skills/managed/SKILL.md'), 'utf8'), /MANAGED BODY/);
});

test('global and project installations ask for the add scope and route global duplicates first', { timeout: 180000 }, async (t) => {
  const f = await sandbox(t);
  await f.skills(['add', source, '--skill', 'jev-skills-router', '--agent', 'codex', '--yes', '--global']);
  await f.skills(['add', source, '--skill', 'jev-skills-router', '--agent', 'codex', '--yes']);
  const script = join(await f.installed(), 'scripts/jev-skills-router.mjs');
  const skill = await f.makeSkill('shared', 'GLOBAL BODY');
  assert.equal((await f.invoke(script, ['add', skill])).status, 'scope_required');
  await f.invoke(script, ['configure', '--global', '--policy', 'keep']);
  await f.invoke(script, ['configure', '--project', '--policy', 'keep']);
  await f.invoke(script, ['add', skill, '--global']);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: shared\ndescription: PowerPoint decks.\n---\nPROJECT BODY');
  assert.equal((await f.invoke(script, ['add', skill, '--project'])).status, 'scope_conflict');
  const subdirectory = join(f.project, 'nested/working');
  await mkdir(subdirectory, { recursive: true });
  const result = await f.invoke(script, ['route'], 'Create a presentation', f.apiEnv, subdirectory);
  assert.equal(result.skills.length, 1);
  assert.match(result.skills[0].instructions, /GLOBAL BODY/);
  assert.ok(result.skills[0].path.startsWith(f.home));
});

test('external additions are reconciled on the next invocation and ignored candidates reset', { timeout: 180000 }, async (t) => {
  const f = await sandbox(t);
  await f.skills(['add', source, '--skill', 'jev-skills-router', '--agent', 'codex', 'claude-code', '--yes']);
  const script = join(await f.installed(), 'scripts/jev-skills-router.mjs');
  await f.invoke(script, ['configure', '--policy', 'disable']);
  const common = await f.makeSkill('common');
  await f.skills(['add', common, '--agent', 'codex', 'claude-code', '--yes']);
  assert.equal((await f.invoke(script, ['discover'])).status, 'ready');
  const stateDirectory = join(f.project, '.agents/jev-skills-router');
  const state = JSON.parse(await readFile(join(stateDirectory, 'state.json'), 'utf8'));
  assert.equal(state.policy, 'disable');
  const record = Object.values(state.imports)[0] as { backup: string };
  assert.equal(await readFile(join(record.backup, 'references/style.md'), 'utf8'), 'PRESERVED RESOURCE');
  const unique = await f.makeSkill('unique');
  await f.skills(['add', unique, '--agent', 'codex', '--yes']);
  const pending = await f.invoke(script, ['discover']);
  assert.equal(pending.status, 'needs_decision');
  const id = pending.requests[0].candidate.id;
  assert.equal((await f.invoke(script, ['ignore', '--candidate', id])).status, 'ready');
  assert.equal((await f.invoke(script, ['discover'])).status, 'ready');
  assert.equal((await f.invoke(script, ['discover', '--reset'])).status, 'needs_decision');
  assert.equal((await f.invoke(script, ['accept', '--candidate', id])).status, 'ready');
  const route = await f.invoke(script, ['route'], 'Create a presentation');
  assert.deepEqual(route.skills.map((entry: { name: string }) => entry.name).sort(), ['common', 'unique']);
});
