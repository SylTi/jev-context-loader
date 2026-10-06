import { spawn } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';

export async function findNpmCli(): Promise<string> {
  const candidates: string[] = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      const executable = await realpath(join(folder, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
      if (executable.endsWith('npm-cli.js')) candidates.push(executable);
      candidates.push(join(dirname(executable), 'node_modules/npm/bin/npm-cli.js'));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    candidates.push(join(folder, 'node_modules/npm/bin/npm-cli.js'), join(folder, '../lib/node_modules/npm/bin/npm-cli.js'));
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile() && candidate.endsWith('npm-cli.js')) return realpath(candidate);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  throw new Error('Cannot locate npm-cli.js. Install Node.js with npm and put npm on PATH.');
}

export async function runNpm(args: string[], cwd: string, capture = false): Promise<string> {
  // Run npm's JavaScript with Node, avoiding Windows .cmd execution and shell interpolation.
  const child = spawn(process.execPath, [await findNpmCli(), ...args], {
    cwd, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', shell: false,
  });
  let output = '';
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) throw new Error(`npm ${args[0]} failed with exit status ${code}.`);
  return output.trim();
}

export async function runSkills(args: string[], cwd: string): Promise<void> {
  await execSkills(args, cwd);
}

export async function findSkillsCli(cwd: string): Promise<string> {
  const installed = async (candidates: string[]): Promise<string | undefined> => {
    for (const candidate of candidates) {
      try { if ((await stat(candidate)).isFile()) return realpath(candidate); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    return undefined;
  };
  const candidates: string[] = [];
  if (process.env.JEV_SKILLS_ROUTER_SKILLS_CLI) candidates.push(process.env.JEV_SKILLS_ROUTER_SKILLS_CLI);
  try {
    const require = createRequire(join(cwd, 'package.json'));
    candidates.push(join(dirname(require.resolve('skills/package.json')), 'bin/cli.mjs'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND')) throw error;
  }
  for (const folder of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      const path = await realpath(join(folder, process.platform === 'win32' ? 'skills.cmd' : 'skills'));
      if (path.endsWith('.mjs') || path.endsWith('.js')) candidates.push(path);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    candidates.push(join(folder, 'node_modules/skills/bin/cli.mjs'), join(folder, '../skills/bin/cli.mjs'));
  }
  const preferred = await installed(candidates);
  if (preferred) return preferred;
  const global = await installed([join(await runNpm(['root', '--global'], cwd, true), 'skills/bin/cli.mjs')]);
  if (global) return global;
  const cache = join(await runNpm(['config', 'get', 'cache'], cwd, true), '_npx');
  const cached: Array<{ path: string; modified: number }> = [];
  try {
    for (const folder of await readdir(cache)) {
      const path = join(cache, folder, 'node_modules/skills/bin/cli.mjs');
      try { cached.push({ path, modified: (await stat(join(cache, folder))).mtimeMs }); } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  candidates.push(...cached.sort((a, b) => b.modified - a.modified).map((item) => item.path));
  const cachedCli = await installed(candidates);
  if (cachedCli) return cachedCli;
  throw new Error('No installed or cached skills CLI found. Run your chosen version of npx skills once, then retry.');
}

export async function execSkills(args: string[], cwd: string): Promise<string> {
  const child = spawn(process.execPath, [await findSkillsCli(cwd), ...args], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  if (code !== 0) throw new Error(`skills ${args[0]} failed with exit status ${code}: ${stderr.trim() || stdout.trim()}`);
  return stdout.trim();
}

export async function listInstalled(root: string, global: boolean): Promise<import('./contracts.js').InstalledSkill[]> {
  const output = await execSkills(['list', '--json', ...(global ? ['--global'] : [])], root);
  let value: unknown;
  try { value = JSON.parse(output); } catch {
    throw new Error('Your skills CLI does not support list --json. Update it explicitly before using automatic discovery.');
  }
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry.name !== 'string' || typeof entry.path !== 'string' ||
      !Array.isArray(entry.agents) || entry.agents.some((agent: unknown) => typeof agent !== 'string') ||
      entry.scope !== (global ? 'global' : 'project'))) throw new Error('Invalid skills list --json inventory.');
  return value;
}
