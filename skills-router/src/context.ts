import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ROUTER_NAME, type DestinationResult, type Installation, type InventoryReader, type Scope } from './contracts.js';
import { listInstalled } from './npm.js';

export async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function resolveInstallations(options: { cwd?: string; home?: string; list?: InventoryReader } = {}): Promise<Installation[]> {
  const home = resolve(options.home ?? homedir());
  const list = options.list ?? listInstalled;
  const installations: Installation[] = [];
  async function add(root: string, scope: Scope): Promise<boolean> {
    const inventory = await list(root, scope === 'global');
    const router = inventory.find((skill) => skill.name === ROUTER_NAME);
    if (!router) return false;
    installations.push({ scope, root, routerPath: join(await realpath(router.path), 'SKILL.md'),
      stateDirectory: join(root, '.agents', ROUTER_NAME), providers: router.agents });
    return true;
  }
  await add(home, 'global');
  let directory = await realpath(resolve(options.cwd ?? process.cwd()));
  while (true) {
    // Ask the user's CLI for the nearest installed project; no harness-path registry is duplicated here.
    if (directory !== home && await add(directory, 'project')) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return installations;
}

export function selectDestination(installations: Installation[], scope?: Scope): DestinationResult {
  if (scope) {
    const installation = installations.find((item) => item.scope === scope);
    if (!installation) throw new Error(`No ${scope} jev-skills-router installation is available. Install it through npx skills first.`);
    return { status: 'selected', installation };
  }
  if (!installations.length) throw new Error('No jev-skills-router installation found. Install it through npx skills first.');
  if (installations.length === 1) return { status: 'selected', installation: installations[0]! };
  return { status: 'scope_required', question: 'Where should this skill be added?',
    destinations: installations.map((item) => ({ scope: item.scope, path: join(item.stateDirectory, 'skills') })) };
}
