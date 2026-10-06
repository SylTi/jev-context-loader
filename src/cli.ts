import { parseArgs } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { discoverSkills, routeTask } from './router.js';
import { setupCommand } from './launcher.js';
import { resolveInstallations, selectDestination } from './context.js';
import { getApiKey, promptKey, saveApiKey } from './auth.js';
import { addRequested, configurePolicy, decideCandidate, prepareCatalog, refreshInstallations, routeManaged } from './application.js';
import { resetIgnored } from './management.js';
import { execSkills } from './npm.js';
import type { Installation, OriginalPolicy, Scope } from './contracts.js';

const usage = `Usage: jev-skills-router <command>
  setup [--bin-dir PATH]        Register the manual command
  auth                         Privately prompt for and validate your Jev API key
  path                         Print this installed skill directory
  discover                     Reconcile files and report setup or import decisions
  configure --policy VALUE     Save disable, delete, or keep for existing/future originals
  accept --candidate ID        Approve a pending uncommon skill
  ignore --candidate ID        Remember a declined uncommon skill
  add SOURCE [--skill NAME]...  Add through the user's existing skills CLI
  update                       Update managed sources and reconcile the catalogs
  route [--loaded PATH]...      Read literal task text from stdin; disclose matches

--global / --project select an existing installation. When both exist, add asks.
--reset clears applicable ignored lists, then rediscovers candidates.
--json suppresses terminal questions and returns structured decisions for the model.
User data lives in .agents/jev-skills-router/ beside .agents/skills/.
TYPESAFE_API_KEY overrides the saved user key. Secrets are never accepted as arguments.
Routing overrides for explicit catalogs: --skills-root PATH or JEV_SKILLS_ROUTER_ROOTS.`;

async function choose(question: string, choices: string[]): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(question + '\n' + choices.map((choice, index) => `${index + 1}. ${choice}`).join('\n') + '\n');
    while (true) {
      const answer = (await terminal.question('Choose: ')).trim();
      const value = choices[Number(answer) - 1] ?? choices.find((choice) => choice === answer);
      if (value) return value;
    }
  } finally { terminal.close(); }
}

try {
  const args = process.argv.slice(2);
  const commands = ['setup', 'auth', 'path', 'discover', 'configure', 'accept', 'ignore', 'add', 'update', 'route'];
  let command = args[0] && commands.includes(args[0]) ? args.shift()! : 'route';
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    'skills-root': { type: 'string', multiple: true }, loaded: { type: 'string', multiple: true },
    help: { type: 'boolean' }, 'bin-dir': { type: 'string' }, skill: { type: 'string', multiple: true },
    global: { type: 'boolean' }, project: { type: 'boolean' }, reset: { type: 'boolean' },
    policy: { type: 'string' }, candidate: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (values.global && values.project) throw new Error('Choose --global or --project, not both.');
  const scope: Scope | undefined = values.global ? 'global' : values.project ? 'project' : undefined;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !values.json);
  const skillDirectory = fileURLToPath(new URL('../', import.meta.url));
  const output = (value: unknown) => console.log(JSON.stringify(value));
  async function synchronize(installations: Installation[]) {
    while (true) {
      const key = await getApiKey();
      const result = await prepareCatalog(installations, { apiKey: key });
      if (interactive && result.status === 'needs_decision') {
        for (const request of result.requests) {
          const installation = installations.find((item) => item.scope === request.scope)!;
          const selected = await choose(request.question, request.options);
          if (request.kind === 'original_policy') await configurePolicy(installation, selected as OriginalPolicy);
          else await decideCandidate(installation, request.candidate!.id, selected === 'import');
        }
        continue;
      }
      if (interactive && result.status === 'needs_setup' && result.reason === 'api_key') {
        await saveApiKey(await promptKey());
        continue;
      }
      if (result.status !== 'prepared') return result;
      await refreshInstallations(installations, result.catalog, key!);
      return { status: 'ready', skillCount: result.catalog.length };
    }
  }
  if (values.help) console.log(usage);
  else if (command === 'path') console.log(resolve(skillDirectory));
  else if (command === 'setup') {
    const executable = await setupCommand(join(skillDirectory, 'scripts/jev-skills-router.mjs'), values['bin-dir']);
    output({ status: 'command_registered', executable,
      ...(!(process.env.PATH ?? '').split(delimiter).map((path) => resolve(path)).includes(dirname(executable)) ? { addToPath: dirname(executable) } : {}) });
  } else if (command === 'auth') {
    if (positionals.length) throw new Error('Never pass the API key as a command argument.');
    await saveApiKey(await promptKey());
    output({ status: 'authenticated' });
  } else {
    if (command !== 'add' && positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    if (values.reset && command === 'route') command = 'discover';
    const explicitRoots: unknown = values['skills-root'] ?? (process.env.JEV_SKILLS_ROUTER_ROOTS ? JSON.parse(process.env.JEV_SKILLS_ROUTER_ROOTS) : undefined);
    if (explicitRoots !== undefined && (!Array.isArray(explicitRoots) || !explicitRoots.length || explicitRoots.some((root) => typeof root !== 'string' || !root.trim()))) {
      throw new Error('Set --skills-root or JEV_SKILLS_ROUTER_ROOTS to at least one skill directory.');
    }
    let task = '';
    if (command === 'route') {
      if (process.stdin.isTTY) throw new Error('Provide the task on stdin. Use --help for usage.');
      process.stdin.setEncoding('utf8');
      for await (const chunk of process.stdin) task += chunk;
      if (!task.trim()) throw new Error('Task must not be blank.');
    }
    if (command === 'route' && Array.isArray(explicitRoots)) {
      const key = await getApiKey();
      output(await routeTask({ task, roots: explicitRoots, loaded: values.loaded,
        routerPath: join(skillDirectory, 'SKILL.md') }, key ? new TypeSafeClient({ apiKey: key }) : undefined));
    } else {
      const all = await resolveInstallations();
      const installations = scope ? all.filter((item) => item.scope === scope) : all;
      if (!installations.length) throw new Error(`No ${scope ?? 'applicable'} jev-skills-router installation found. Install it through npx skills first.`);
      if (values.reset) for (const installation of installations) await resetIgnored(installation);
      if (['add', 'configure', 'accept', 'ignore'].includes(command)) {
        let destination = selectDestination(installations, scope);
        if (destination.status === 'scope_required' && interactive) {
          const selected = await choose(destination.question + '\n' + destination.destinations.map((item) => `${item.scope}: ${item.path}`).join('\n'), destination.destinations.map((item) => item.scope));
          destination = selectDestination(installations, selected as Scope);
        }
        if (destination.status === 'scope_required') output(destination);
        else {
          const installation = destination.installation;
          let added: string[] = [];
          if (command === 'add') {
            if (positionals.length !== 1) throw new Error('Provide one skill path or source.');
            added = await addRequested(installation, positionals[0]!, values.skill ?? []);
          } else if (command === 'configure') {
            if (!values.policy || !['disable', 'delete', 'keep'].includes(values.policy)) throw new Error('Choose --policy disable, delete, or keep.');
            await configurePolicy(installation, values.policy as OriginalPolicy);
          } else {
            if (!values.candidate) throw new Error('Provide --candidate ID from the pending decision.');
            await decideCandidate(installation, values.candidate, command === 'accept');
          }
          const applicable = command === 'add' ? all : installations;
          const result = await synchronize(applicable);
          const global = applicable.find((item) => item.scope === 'global');
          const shadowed = result.status === 'ready' && installation.scope === 'project' && global ?
            (await discoverSkills([join(global.stateDirectory, 'skills')])).filter((skill) => added.includes(skill.name)).map((skill) => skill.name) : [];
          output(shadowed.length ? { status: 'scope_conflict', skills: shadowed,
            message: 'The project copy was added, but the global version takes precedence. Rerun add with --global to manage that version.' } : result);
        }
      } else if (command === 'update') {
        for (const installation of installations) {
          const root = join(installation.stateDirectory, 'skills');
          await mkdir(root, { recursive: true });
          await execSkills(['update', '--project', '--yes'], root);
        }
        output(await synchronize(installations));
      } else if (command === 'discover') output(await synchronize(installations));
      else output(await routeManaged(installations, task, values.loaded ?? []));
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
