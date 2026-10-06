import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));

async function run(args: string[], stdin = '', environment: NodeJS.ProcessEnv = {}, preload?: string, cwd = project) {
  const child = spawn(process.execPath, [
    '--import', 'tsx', ...(preload ? ['--import', pathToFileURL(preload).href] : []), 'src/cli.ts', ...args,
  ], { cwd, env: { ...process.env, TYPESAFE_API_KEY: '', JEV_SKILLS_ROUTER_ROOTS: '', XDG_CONFIG_HOME: join(cwd, 'test-config'), JEV_SKILLS_ROUTER_SKILLS_CLI: join(cwd, '_fixture-skills.mjs'), ...environment } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(stdin);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr };
}

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-cli-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function stagedRouter(t: TestContext) {
  const parent = await fixture(t);
  const root = join(parent, '.agents/skills/jev-skills-router');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, '_fixture-skills.mjs'), `import { existsSync } from 'node:fs';
    import { join } from 'node:path';
    const path = join(process.cwd(), '.agents/skills/jev-skills-router');
    console.log(JSON.stringify(!process.argv.includes('--global') && existsSync(path) ?
      [{name:'jev-skills-router',path,scope:'project',agents:['Codex','Claude Code']}] : []));`);
  await cp(join(project, 'src'), join(root, 'src'), { recursive: true });
  await cp(join(project, 'SKILL.md'), join(root, 'SKILL.md'));
  await cp(join(project, 'package.json'), join(root, 'package.json'));
  await symlink(join(project, 'node_modules'), join(root, 'node_modules'), 'junction');
  return root;
}

test('CLI emits all matching skills from one request without unrelated instructions', async (t) => {
  const root = await fixture(t);
  const router = await stagedRouter(t);
  for (const [name, body] of [['pdf', 'SELECTED PDF BODY'], ['docs', 'SELECTED DOCS BODY'], ['deploy', 'PRIVATE DEPLOY BODY']]) {
    await mkdir(join(root, name!));
    await writeFile(join(root, name!, 'SKILL.md'), `---\nname: ${name}\ndescription: Work on ${name}.\n---\n${body}\n`);
  }
  const preload = join(root, 'mock.mjs');
  await writeFile(preload, `
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      if (request.state.purpose === 'catalog-classification') {
        const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul', noul: 0.1 }]));
        return Response.json({model: 'jev-latest', answers, usage: {input_tokens: 10, output_tokens: 0}});
      }
      if (request.state.task !== 'Read this PDF and create a Word document\\n') throw new Error('Task changed');
      if (init.body.includes('BODY')) throw new Error('Skill instructions leaked');
      if (Object.keys(request.questions).length !== 3) throw new Error('Candidates lost');
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, {
        type: 'noul', noul: question.instructions.skill.name === 'deploy' ? 0.1 : 0.9,
      }]));
      return Response.json({model: 'jev-latest', answers, usage: {input_tokens: 10, output_tokens: 0}});
    };
  `);
  const result = await run([], 'Read this PDF and create a Word document\n', {
    JEV_SKILLS_ROUTER_ROOTS: JSON.stringify([root]), TYPESAFE_API_KEY: 'test-key',
  }, preload, router);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.skills.map((skill: { name: string }) => skill.name), ['docs', 'pdf']);
  assert.match(output.skills[0].instructions, /SELECTED DOCS BODY/);
  assert.match(output.skills[1].instructions, /SELECTED PDF BODY/);
  assert.equal(result.stdout.includes('PRIVATE DEPLOY BODY'), false);
  assert.equal(result.stdout.trim().split('\n').length, 1);
});

test('CLI add and path work from an unrelated working directory and never disclose metadata in stdout', async (t) => {
  const root = await fixture(t);
  const router = await stagedRouter(t);
  const source = join(root, 'custom skill.md');
  await writeFile(source, '---\nname: custom\ndescription: SECRET CATALOG METADATA\n---\nPRIVATE BODY');
  const preload = join(root, 'mock.mjs');
  await writeFile(preload, `globalThis.fetch = async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.state.purpose !== 'catalog-classification') throw new Error('Unexpected request');
    if (init.body.includes('PRIVATE BODY')) throw new Error('Instructions leaked');
    return Response.json({model: 'jev-latest', answers: Object.fromEntries(Object.keys(request.questions).map(id =>
      [id, {type: 'noul', noul: 0.1}])), usage: {input_tokens: 0, output_tokens: 0}});
  };`);
  await run(['configure', '--policy', 'keep'], '', {}, undefined, router);
  const added = await run(['add', source], '', { TYPESAFE_API_KEY: 'test' }, preload, router);
  assert.equal(added.code, 0, added.stderr);
  assert.equal(added.stdout.includes('SECRET CATALOG METADATA'), false);
  assert.equal(added.stdout.includes('PRIVATE BODY'), false);
  assert.match(await readFile(resolve(router, '../../jev-skills-router/skills/.agents/skills/custom/SKILL.md'), 'utf8'), /PRIVATE BODY/);
  const path = await run(['path'], '', {}, undefined, router);
  assert.equal(path.code, 0, path.stderr);
  assert.equal(path.stdout.trim(), await realpath(router));
  const missing = await run(['add', join(root, 'absent')], '', {}, undefined, router);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /does not exist/);
});

test('setup uses npm global prefix with the correct platform bin layout', async (t) => {
  const router = await stagedRouter(t);
  const root = await fixture(t);
  const prefix = join(root, 'npm prefix');
  const npmCli = join(root, 'npm-cli.js');
  await writeFile(npmCli, `process.stdout.write(${JSON.stringify(prefix)});`);
  await mkdir(join(router, 'scripts'));
  await writeFile(join(router, 'scripts/jev-skills-router.mjs'), 'console.log("fixture");');
  const result = await run(['setup'], '', { npm_execpath: npmCli }, undefined, router);
  assert.equal(result.code, 0, result.stderr);
  const command = process.platform === 'win32' ? join(prefix, 'jev-skills-router.cmd') : join(prefix, 'bin/jev-skills-router');
  assert.ok((await readFile(command, 'utf8')).includes('jev-skills-router launcher'));
  assert.equal(JSON.parse(result.stdout).executable, command);
});

test('CLI help and an empty catalog work without credentials', async (t) => {
  const root = await fixture(t);
  const router = await stagedRouter(t);
  const help = await run(['--help'], '', {}, undefined, router);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  const empty = await run(['--skills-root', root], 'Hello', {}, undefined, router);
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), { skills: [] });
});

test('CLI input and authentication errors use stderr and a nonzero exit', async (t) => {
  const root = await fixture(t);
  const router = await stagedRouter(t);
  const invalidRoots = await run([], 'Hello', { JEV_SKILLS_ROUTER_ROOTS: '[42]' }, undefined, router);
  assert.equal(invalidRoots.code, 1);
  const blank = await run(['--skills-root', root], '   ', {}, undefined, router);
  assert.equal(blank.code, 1);
  assert.match(blank.stderr, /Task/);
  await writeFile(join(root, 'SKILL.md'), '---\nname: pdf\ndescription: Read PDFs.\n---\nBODY');
  const missingKey = await run(['--skills-root', root], 'Read PDFs', {}, undefined, router);
  assert.equal(missingKey.code, 1);
  assert.equal(missingKey.stdout, '');
  assert.match(missingKey.stderr, /API key/);
});
