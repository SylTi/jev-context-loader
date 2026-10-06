import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TypeSafeClient, type NoulQuestion, type NoulResponse, type SystemOneRequest } from '@typesafe-ai/sdk';
import { discoverSkills, routeTask } from '../src/router.js';
import { parse } from 'yaml';
import { CATEGORIES } from '../src/categories.js';

async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-skills-router-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function skill(folder: string, name: string, description: string, body: string) {
    const directory = join(root, folder);
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'SKILL.md');
    await writeFile(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
    return realpath(path);
  }
  return { root, skill };
}

function jev(judge: (request: SystemOneRequest<Record<string, NoulQuestion>>) => Record<string, NoulResponse>) {
  const requests: SystemOneRequest<Record<string, NoulQuestion>>[] = [];
  const client = new TypeSafeClient({
    apiKey: 'test-key',
    retry: { maxRetries: 0 },
    fetch: async (url, init) => {
      assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const answers = judge(request);
      return Response.json({
        model: 'jev-latest',
        answers,
        usage: { input_tokens: 100, output_tokens: 0 },
      });
    },
  });
  return { client, requests };
}

function judgments(request: SystemOneRequest<Record<string, NoulQuestion>>, probability: (name: string) => number) {
  return Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    assert.equal(question.type, 'noul');
    const instructions = question.instructions;
    assert.ok(typeof instructions === 'object' && instructions !== null && !Array.isArray(instructions));
    const skill = instructions.skill;
    assert.ok(typeof skill === 'object' && skill !== null && !Array.isArray(skill));
    assert.equal(typeof skill.name, 'string');
    return [id, { type: 'noul' as const, noul: probability(skill.name as string) }];
  }));
}

test('discovery indexes valid skills, skips placeholders and broken links, and deduplicates aliases', async (t) => {
  const f = await fixture(t);
  const path = await f.skill('.system/docs', 'docs', '>\n  Create documents.\n  Preserve layout.', 'PRIVATE BODY');
  await f.skill('jev-skills-router', 'jev-skills-router', 'Route tasks.', 'ROUTER BODY');
  await symlink(join(f.root, '.system/docs'), join(f.root, 'alias'), 'junction');
  await symlink(join(f.root, 'missing-skill'), join(f.root, 'broken-alias'), 'junction');
  await mkdir(join(f.root, 'placeholder'));
  await writeFile(join(f.root, 'placeholder/SKILL.md'), '# Placeholder\n');
  const catalog = await discoverSkills([f.root, f.root]);
  assert.deepEqual(catalog, [{ name: 'docs', description: 'Create documents. Preserve layout.\n', path }]);
  assert.equal(JSON.stringify(catalog).includes('PRIVATE BODY'), false);
});

test('one request discloses every matching skill while keeping unrelated instructions private', async (t) => {
  const f = await fixture(t);
  const selectedPath = await f.skill('pdf', 'pdf', 'Read PDF documents.', 'Read the PDF reference.');
  const secondPath = await f.skill('docs', 'docs', 'Create Word documents.', 'Write a Word document.');
  await f.skill('deploy', 'deploy', 'Deploy a website.', 'UNRELATED DEPLOY INSTRUCTIONS');
  const mock = jev((request) => {
    assert.deepEqual(request.state, { task: 'Read this PDF and create a Word document' });
    const wire = JSON.stringify(request);
    assert.equal(wire.includes('UNRELATED DEPLOY INSTRUCTIONS'), false);
    assert.equal(wire.includes('Read the PDF reference.'), false);
    assert.equal(wire.includes('Write a Word document.'), false);
    assert.equal(wire.includes(f.root), false);
    assert.equal(Object.keys(request.questions).length, 3);
    return judgments(request, (name) => name === 'deploy' ? 0.1 : 0.9);
  });
  const result = await routeTask({ task: 'Read this PDF and create a Word document', roots: [f.root] }, mock.client);
  assert.deepEqual(result.skills.map((skill) => skill.path), [secondPath, selectedPath]);
  assert.match(result.skills[0]!.instructions, /Write a Word document\./);
  assert.match(result.skills[1]!.instructions, /Read the PDF reference\./);
  assert.equal(result.skills[1]!.matchProbability, 0.9);
  assert.equal(JSON.stringify(result).includes('UNRELATED DEPLOY INSTRUCTIONS'), false);
  assert.equal(JSON.stringify(result).includes('deploy'), false);
  assert.equal(mock.requests.length, 1);
});

test('Jev can decide that an ordinary task needs no skill', async (t) => {
  const f = await fixture(t);
  await f.skill('pdf', 'pdf', 'Read PDFs.', 'HIDDEN INSTRUCTIONS');
  const mock = jev((request) => judgments(request, () => 0.1));
  assert.deepEqual(await routeTask({ task: 'What is 2 + 2?', roots: [f.root] }, mock.client), {
    skills: [],
  });
});

test('already loaded skills are excluded, allowing another phase to disclose another skill', async (t) => {
  const f = await fixture(t);
  const loaded = await f.skill('tdd', 'tdd', 'Implement code with tests.', 'TDD BODY');
  const next = await f.skill('verify', 'verify', 'Run verification.', 'VERIFY BODY');
  const mock = jev((request) => {
    assert.equal(JSON.stringify(request).includes('Implement code with tests.'), false);
    return judgments(request, () => 0.9);
  });
  const result = await routeTask({ task: 'Run the tests now', roots: [f.root], loaded: [loaded] }, mock.client);
  assert.deepEqual(result.skills.map((skill) => skill.path), [next]);
});

test('empty or exhausted catalogs need neither an API key nor a request', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await routeTask({ task: 'Hello', roots: [f.root] }), {
    skills: [],
  });
  const path = await f.skill('pdf', 'pdf', 'Read PDFs.', 'BODY');
  const mock = jev(() => { throw new Error('Unexpected API request'); });
  assert.deepEqual(await routeTask({ task: 'Hello', roots: [f.root], loaded: [path] }, mock.client), {
    skills: [],
  });
});

test('missing Jev judgments and provider failures are errors, never partial matches', async (t) => {
  const f = await fixture(t);
  await f.skill('pdf', 'pdf', 'Read PDFs.', 'BODY');
  await assert.rejects(routeTask({ task: 'PDF', roots: [f.root] }, jev(() => ({})).client), /invalid.*answer/i);
  await assert.rejects(routeTask({ task: 'PDF', roots: [f.root] }, jev((request) => judgments(request, () => 2)).client), /invalid.*answer/i);
  const failingClient = new TypeSafeClient({
    apiKey: 'test-key', retry: { maxRetries: 0 }, fetch: async () => Response.json({ error: 'Unavailable' }, { status: 503 }),
  });
  await assert.rejects(routeTask({ task: 'PDF', roots: [f.root] }, failingClient));
});

test('invalid skill frontmatter and blank tasks fail clearly', async (t) => {
  const f = await fixture(t);
  await f.skill('bad', 'bad', '42', 'BODY');
  await assert.rejects(discoverSkills([f.root]), /description/i);
  await assert.rejects(routeTask({ task: '   ', roots: [] }), /task/i);
});

test('catalogs beyond the old Choice limit evaluate all skills in one request', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 255 }, (_, i) => f.skill(`s${i}`, `s${i}`, 'Do a task.', 'BODY')));
  const mock = jev((request) => {
    assert.equal(Object.keys(request.questions).length, 255);
    return judgments(request, (name) => name === 's254' ? 0.9 : 0.1);
  });
  const result = await routeTask({ task: 'Do something', roots: [f.root] }, mock.client);
  assert.deepEqual(result.skills.map((skill) => skill.name), ['s254']);
  assert.equal(mock.requests.length, 1);
});

test('only judgments at or above 0.75 are disclosed', async (t) => {
  const f = await fixture(t);
  await f.skill('yes', 'yes', 'Applies.', 'YES BODY');
  await f.skill('boundary', 'boundary', 'At the cutoff.', 'BOUNDARY BODY');
  await f.skill('no', 'no', 'Does not apply.', 'NO BODY');
  const mock = jev((request) => judgments(request, (name) => ({ yes: 0.7501, boundary: 0.75, no: 0.7499 })[name]!));
  const result = await routeTask({ task: 'Do a task', roots: [f.root] }, mock.client);
  assert.deepEqual(result.skills.map((skill) => skill.name), ['boundary', 'yes']);
  assert.equal(JSON.stringify(result).includes('NO BODY'), false);
});

test('copied Markdown skills work without installation records and retain their resource paths', async (t) => {
  const f = await fixture(t);
  const loose = join(f.root, 'custom.md');
  await writeFile(loose, '---\nname: custom\ndescription: Analyze satellite weather.\n---\nLOOSE BODY');
  const folder = await f.skill('documents', 'documents', 'Create documents.', 'FOLDER BODY');
  await mkdir(join(f.root, 'documents/references'));
  await writeFile(join(f.root, 'documents/references/manual.md'), '---\nname: reference\ndescription: Supporting resource.\n---\nREFERENCE BODY');
  const catalog = await discoverSkills([f.root]);
  assert.deepEqual(catalog.map((skill) => skill.path), [loose, folder].sort((a, b) => a.localeCompare(b)));
  const mock = jev((request) => judgments(request, () => 0.9));
  const result = await routeTask({ task: 'Analyze weather and write a document', roots: [f.root] }, mock.client);
  assert.equal(result.skills.length, 2);
  assert.equal(JSON.stringify(result).includes('REFERENCE BODY'), false);
});

test('every invocation refreshes the router description from catalog additions, edits, and removals', async (t) => {
  const f = await fixture(t);
  const routerPath = join(f.root, 'router.md');
  const body = '# Jev\nKeep these instructions exactly.\n';
  await writeFile(routerPath, `---\nname: jev-skills-router\ndescription: Bootstrap router.\nmetadata:\n  custom: preserved\n---\n${body}`);
  const catalogRoot = join(f.root, 'skills');
  await mkdir(catalogRoot);
  const input = { task: 'Do a task', roots: [catalogRoot], routerPath };
  const mock = jev((request) => {
    const state = request.state as { purpose?: string; skill?: { description: string } };
    if (state.purpose !== 'catalog-classification') return judgments(request, () => 0.1);
    const target = state.skill!.description.includes('satellite') ? 'Geospatial analysis' : 'Statistical analysis';
    const parents = CATEGORIES.find((category) => category.label === target)!.groups;
    return Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      const instructions = question.instructions as { group?: { label: string }; category?: { label: string } };
      const matched = (request.state as { stage: string }).stage === 'groups' ? parents.includes(instructions.group!.label) : instructions.category!.label === target;
      return [id, { type: 'noul' as const, noul: matched ? 0.9 : 0.1 }];
    }));
  });
  async function description() {
    const source = await readFile(routerPath, 'utf8');
    assert.equal(source.split('---\n').slice(2).join('---\n'), body);
    const metadata = parse(source.split('---\n')[1]!);
    assert.deepEqual(metadata.metadata, { custom: 'preserved' });
    return metadata.description as string;
  }
  await routeTask(input, mock.client);
  const emptyDescription = await description();
  const path = join(catalogRoot, 'my-skill.md');
  await writeFile(path, '---\nname: analysis\ndescription: Analyze satellite weather.\n---\nPRIVATE BODY WORD');
  await routeTask({ ...input, loaded: [path] }, mock.client);
  assert.match(await description(), /Geospatial analysis/);
  assert.equal((await description()).includes('private'), false);
  const initialRequests = mock.requests.length;
  assert.ok(initialRequests >= 2);
  await writeFile(path, '---\nname: analysis\ndescription: Analyze statistical data.\n---\nPRIVATE BODY WORD');
  await routeTask(input, mock.client);
  assert.match(await description(), /Statistical analysis/);
  assert.equal((await description()).includes('Geospatial analysis'), false);
  assert.ok(mock.requests.length > initialRequests + 1);
  await unlink(path);
  await routeTask(input, mock.client);
  assert.equal(await description(), emptyDescription);
});

test('body and resource edits keep cached categories while routing discloses the current body', async (t) => {
  const f = await fixture(t);
  const path = await f.skill('custom', 'custom', 'A specialized task.', 'FIRST BODY');
  const routerPath = join(f.root, 'router.md');
  await writeFile(routerPath, '---\nname: jev-skills-router\ndescription: Router.\n---\nROUTER BODY');
  let classifications = 0;
  const mock = jev((request) => {
    if ((request.state as { purpose?: string }).purpose === 'catalog-classification') {
      classifications++;
      return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: 'noul' as const, noul: 0.1 }]));
    }
    return judgments(request, () => 0.9);
  });
  const input = { task: 'Do the specialized task', roots: [f.root], routerPath };
  assert.match((await routeTask(input, mock.client)).skills[0]!.instructions, /FIRST BODY/);
  await writeFile(path, '---\nname: custom\ndescription: A specialized task.\n---\nSECOND BODY');
  await mkdir(join(f.root, 'custom/references'));
  await writeFile(join(f.root, 'custom/references/data.txt'), 'NEW RESOURCE');
  assert.match((await routeTask(input, mock.client)).skills[0]!.instructions, /SECOND BODY/);
  assert.equal(classifications, 1);
  assert.equal(mock.requests.length, 3);
});


test('routing preserves French tasks, mixed-language metadata, and original instructions', async (t) => {
  const f = await fixture(t);
  await f.skill('english-ui', 'english-ui', 'Design responsive user interfaces.', 'ENGLISH INSTRUCTIONS');
  await f.skill('french-ux', 'french-ux', 'Améliorer les parcours utilisateur et tester leur ergonomie.', 'INSTRUCTIONS EN FRANÇAIS');
  await f.skill('deploy', 'deploy', 'Deploy production applications.', 'UNRELATED INSTRUCTIONS');
  const task = 'Améliore l’interface mobile et le parcours utilisateur de cette application.';
  const mock = jev((request) => {
    assert.deepEqual(request.state, { task });
    const wire = JSON.stringify(request);
    assert.ok(wire.includes('Design responsive user interfaces.'));
    assert.ok(wire.includes('Améliorer les parcours utilisateur et tester leur ergonomie.'));
    return judgments(request, (name) => name === 'deploy' ? 0.1 : 0.9);
  });
  const result = await routeTask({ task, roots: [f.root] }, mock.client);
  assert.deepEqual(result.skills.map((skill) => skill.name), ['english-ui', 'french-ux']);
  assert.match(result.skills[0]!.instructions, /ENGLISH INSTRUCTIONS/);
  assert.match(result.skills[1]!.instructions, /INSTRUCTIONS EN FRANÇAIS/);
  assert.equal(mock.requests.length, 1);
});
