import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import { CATEGORIES, CATEGORY_GROUPS } from '../src/categories.js';
import { refreshDescription } from '../src/description.js';
import type { SkillMetadata } from '../src/router.js';

test('category classification is cached by metadata and handles additions, edits, removals, and unknown domains', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-description-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  const body = '# Jev\nPreserve this body.\n';
  await writeFile(path, `---\nname: jev-skills-router\ndescription: Bootstrap.\nmetadata:\n  custom: preserved\n---\n${body}`);
  const calls: string[] = [];
  const client = new TypeSafeClient({ apiKey: 'test', retry: { maxRetries: 0 }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.state.stage === 'groups') calls.push(request.state.skill.description);
    assert.equal(request.state.skill.path, undefined);
    assert.equal(String(init?.body).includes('PRIVATE BODY'), false);
    assert.ok(Object.keys(request.questions).length <= 128);
    const matches = request.state.skill.description.includes('Blender') ? ['3D modeling', 'Animation'] :
      request.state.skill.description.includes('PowerPoint') ? ['Presentations', 'Public speaking'] : [];
    const parents = new Set(CATEGORIES.filter((category) => matches.includes(category.label)).flatMap((category) => category.groups));
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
      const instructions = (value as { instructions: { group?: { label: string }; category?: { label: string } } }).instructions;
      const matched = request.state.stage === 'groups' ? parents.has(instructions.group!.label) : matches.includes(instructions.category!.label);
      return [id, { type: 'noul', noul: matched ? 0.75 : 0.7499 }];
    }));
    return Response.json({ model: 'jev-latest', answers, usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  const skill = (name: string, description: string): SkillMetadata => ({ name, description, path: join(root, `${name}.md`) });
  const blender = skill('blender', 'Create models in Blender.');
  const ppt = skill('ppt', 'Create PowerPoint decks.');
  async function description() {
    const source = await readFile(path, 'utf8');
    assert.equal(source.split('---\n').slice(2).join('---\n'), body);
    const header = parse(source.split('---\n')[1]!);
    assert.deepEqual(header.metadata, { custom: 'preserved' });
    assert.ok(header.description.length <= 1024);
    return header.description as string;
  }
  await refreshDescription(path, [blender, ppt], client);
  assert.match(await description(), /3D modeling/);
  assert.match(await description(), /Presentations/);
  assert.match(await description(), /Animation/);
  assert.equal(calls.length, 2);
  await refreshDescription(path, [ppt, { ...blender, path: join(root, 'moved.md') }], client);
  assert.equal(calls.length, 2);
  const cached = JSON.parse(await readFile(join(root, '.jev-skills-router-cache.json'), 'utf8'));
  const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
  assert.ok(cached.skills[sha256(sha256(blender.name) + sha256(blender.description))]);
  await refreshDescription(path, [ppt], client);
  const pptSummary = await description();
  await refreshDescription(path, [ppt, skill('custom', 'Study an undocumented alien sport.')], client);
  assert.equal(calls.length, 3);
  assert.equal((await description()).includes('3D modeling'), false);
  assert.equal(await description(), pptSummary, 'An unclassified skill must not change the advertised capabilities');
  await refreshDescription(path, [skill('ppt', 'Create models in Blender.')], client);
  assert.equal(calls.length, 4);
  assert.equal((await description()).includes('Presentations'), false);
  await refreshDescription(path, [], client);
  assert.equal(calls.length, 4);
  assert.equal((await description()).includes('3D modeling'), false);
  const cache = JSON.parse(await readFile(join(root, '.jev-skills-router-cache.json'), 'utf8'));
  assert.deepEqual(cache.skills, {});
});

test('a changed taxonomy invalidates metadata matches even when the catalog is unchanged', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-taxonomy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  await writeFile(path, '---\nname: jev-skills-router\ndescription: Bootstrap.\n---\nBODY');
  let calls = 0;
  const client = new TypeSafeClient({ apiKey: 'test', fetch: async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    return Response.json({ model: 'jev-latest', answers: Object.fromEntries(Object.keys(request.questions).map((id) =>
      [id, { type: 'noul', noul: 0.1 }])), usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  const catalog = [{ name: 'custom', description: 'A task.', path: 'local' }];
  await refreshDescription(path, catalog, client);
  await refreshDescription(path, catalog, client);
  assert.equal(calls, 1);
  const cachePath = join(root, '.jev-skills-router-cache.json');
  const cache = JSON.parse(await readFile(cachePath, 'utf8'));
  await writeFile(cachePath, JSON.stringify({ ...cache, taxonomyHash: 'old' }));
  await refreshDescription(path, catalog, client);
  assert.equal(calls, 2);
});

test('incomplete category answers preserve the last description and cache', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-description-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  const initial = '---\nname: jev-skills-router\ndescription: Last good description.\n---\nBODY';
  await writeFile(path, initial);
  const client = new TypeSafeClient({ apiKey: 'test', retry: { maxRetries: 0 }, fetch: async () =>
    Response.json({ model: 'jev-latest', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } }) });
  await assert.rejects(refreshDescription(path, [{ name: 'ppt', description: 'PowerPoint.', path: 'PRIVATE BODY' }], client), /invalid.*answer/i);
  assert.equal(await readFile(path, 'utf8'), initial);
  await assert.rejects(readFile(join(root, '.jev-skills-router-cache.json')), { code: 'ENOENT' });
});

test('hundreds of distinct categories cover unrelated task families without dropping domains when compacted', async (t) => {
  assert.ok(CATEGORIES.length >= 200);
  assert.equal(new Set(CATEGORIES.map((category) => category.id)).size, CATEGORIES.length);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-description-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  await writeFile(path, '---\nname: jev-skills-router\ndescription: Bootstrap.\n---\nBODY');
  const client = new TypeSafeClient({ apiKey: 'test', fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({ model: 'jev-latest', answers: Object.fromEntries(Object.keys(request.questions).map((id) =>
      [id, { type: 'noul', noul: request.state.skill.name === 'unknown' ? 0.1 : 0.9 }])), usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  const many = { name: 'many', description: 'Many domains.', path: 'local' };
  await refreshDescription(path, [many], client);
  const classifiedSummary = parse((await readFile(path, 'utf8')).split('---\n')[1]!).description;
  await refreshDescription(path, [
    many,
    { name: 'unknown', description: 'An uncategorized task.', path: 'local' },
  ], client);
  const description = parse((await readFile(path, 'utf8')).split('---\n')[1]!).description;
  assert.ok(description.length <= 1024);
  assert.ok(Buffer.byteLength(description) <= 1024);
  for (const group of new Set(CATEGORY_GROUPS.map((group) => group.label))) assert.ok(description.includes(group), group);
  assert.equal(description, classifiedSummary, 'Unclassified skills must not consume capability-summary space');
  assert.ok(CATEGORIES.some((category) => description.includes(category.label)), 'Compaction must retain detailed categories');
});

test('description compaction represents smaller domains alongside a large software catalog', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-description-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  await writeFile(path, '---\nname: jev-skills-router\ndescription: Bootstrap.\n---\nBODY');
  const domains = ['software development', 'documents and office work', 'UX research and design'];
  const selected = CATEGORIES.filter((category) => category.groups.includes('software development') ||
    ['Presentations', 'Usability testing'].includes(category.label)).map((category) => category.label);
  const client = new TypeSafeClient({ apiKey: 'test', fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
      const instructions = (value as { instructions: { group?: { label: string }; category?: { label: string } } }).instructions;
      const matched = request.state.stage === 'groups' ? domains.includes(instructions.group!.label) : selected.includes(instructions.category!.label);
      return [id, { type: 'noul', noul: matched ? 0.9 : 0.1 }];
    }));
    return Response.json({ model: 'jev-latest', answers, usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  await refreshDescription(path, [{ name: 'catalog', description: 'Software, decks and usability research.', path: 'local' }], client);
  const description = parse((await readFile(path, 'utf8')).split('---\n')[1]!).description;
  assert.ok(description.length <= 1024);
  for (const domain of domains) assert.ok(description.includes(domain));
  assert.ok(description.includes('Presentations'));
  assert.ok(description.includes('Usability testing'));
  assert.ok(CATEGORIES.some((category) => category.groups.includes('software development') && description.includes(category.label)));
});


test('taxonomy covers distinct UI, UX, design-system and physical-design workflows', () => {
  const labels = new Set(CATEGORIES.map((category) => category.label));
  for (const task of ['Responsive interface design', 'UI component design', 'Interaction design',
    'User research', 'Usability testing', 'Journey mapping', 'UX writing', 'Design tokens',
    'Design system governance', 'Accessible interaction design', 'Service design', 'Industrial design',
    'Interior design', 'Packaging design', 'Frontend architecture', 'Scientific visualization',
    'Music arrangement', 'Supply chain planning', 'Building information modeling', 'Learning analytics']) {
    assert.ok(labels.has(task), `Missing task family: ${task}`);
  }
  assert.ok(CATEGORIES.length >= 600, 'Taxonomy needs depth beyond ten labels per domain');
  assert.equal(labels.size, CATEGORIES.length, 'Task labels must not be duplicated across groups');
});

test('classification evaluates every category in bounded batches and caches only a complete classification', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-batches-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  const initial = '---\nname: jev-skills-router\ndescription: Previous summary.\n---\nBODY';
  await writeFile(path, initial);
  const labels: string[] = [];
  let requests = 0;
  let failSecond = true;
  const client = new TypeSafeClient({ apiKey: 'test', retry: { maxRetries: 0 }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests++;
    assert.ok(Object.keys(request.questions).length <= 128);
    assert.equal(request.state.skill.description, 'Concevoir des interfaces accessibles.');
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
      if (request.state.stage === 'groups') return [id, { type: 'noul', noul: 0.9 }];
      const label = (question as { instructions: { category: { label: string } } }).instructions.category.label;
      labels.push(label);
      return [id, { type: 'noul', noul: label === 'Accessible interaction design' ? 0.9 : 0.1 }];
    }));
    if (failSecond && requests === 2) return Response.json({ model: 'jev-latest', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
    return Response.json({ model: 'jev-latest', answers, usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  const catalog = [{ name: 'accessible-ui', description: 'Concevoir des interfaces accessibles.', path: 'LOCAL PATH' }];
  await assert.rejects(refreshDescription(path, catalog, client), /invalid.*answer/i);
  assert.equal(await readFile(path, 'utf8'), initial);
  await assert.rejects(readFile(join(root, '.jev-skills-router-cache.json')), { code: 'ENOENT' });
  labels.length = 0;
  requests = 0;
  failSecond = false;
  await refreshDescription(path, catalog, client);
  assert.deepEqual(labels, CATEGORIES.map((category) => category.label));
  assert.equal(new Set(labels).size, labels.length);
  assert.match(await readFile(path, 'utf8'), /Accessible interaction design/);
  const completedRequests = requests;
  await refreshDescription(path, catalog, client);
  assert.equal(requests, completedRequests);
});


test('physical product testing has its own domain-qualified task families', () => {
  const software = CATEGORIES.filter((category) => category.groups.includes('software testing and quality'));
  const physical = CATEGORIES.filter((category) => category.groups.includes('physical product testing and quality'));
  const manufacturing = CATEGORIES.filter((category) => category.groups.includes('manufacturing quality'));
  assert.ok(software.some((category) => category.label === 'Software unit testing'));
  for (const label of ['Physical prototype validation', 'Physical product durability testing', 'Environmental chamber testing',
    'Electromagnetic compatibility testing', 'Physical product safety testing']) {
    assert.ok(physical.some((category) => category.label === label), `Missing physical task: ${label}`);
  }
  assert.ok(manufacturing.some((category) => category.label === 'Statistical process control'));
  assert.equal(physical.some((category) => category.label === 'Software test mocking'), false);
});

test('broad domains gate detailed questions independently at 0.75, including software and physical testing together', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-hierarchy-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  await writeFile(path, '---\nname: jev-skills-router\ndescription: Previous summary.\n---\nBODY');
  const catalog = [{ name: 'embedded-tests', description: 'Validate device firmware and physical prototypes.', path: 'PRIVATE PATH' }];
  const requests: string[] = [];
  const detailed: string[] = [];
  const accepted = ['software testing and quality', 'physical product testing and quality'];
  const client = new TypeSafeClient({ apiKey: 'test', retry: { maxRetries: 0 }, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    requests.push(request.state.stage);
    assert.deepEqual(request.state.skill, { name: catalog[0]!.name, description: catalog[0]!.description });
    assert.equal(String(init?.body).includes('PRIVATE PATH'), false);
    if (requests.length === 1) assert.equal(request.state.stage, 'groups');
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
      const instructions = (value as { instructions: { group?: { label: string; description: string }; category?: { label: string; groups: string[] } } }).instructions;
      if (request.state.stage === 'groups') {
        const group = instructions.group!;
        assert.ok(group.description.length > 0);
        return [id, { type: 'noul', noul: accepted.includes(group.label) ? 0.75 : 0.7499 }];
      }
      assert.equal(request.state.stage, 'categories');
      assert.ok(Object.keys(request.questions).length <= 128);
      const category = instructions.category!;
      assert.ok(category.groups.some((group) => accepted.includes(group)), `Unexpected rejected branch: ${category.groups.join(', ')}`);
      detailed.push(category.label);
      return [id, { type: 'noul', noul: ['Software unit testing', 'Physical prototype validation'].includes(category.label) ? 0.75 : 0.7499 }];
    }));
    return Response.json({ model: 'jev-latest', answers, usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  await refreshDescription(path, catalog, client);
  assert.equal(requests[0], 'groups');
  assert.ok(requests.slice(1).every((stage) => stage === 'categories'));
  assert.deepEqual(detailed, CATEGORIES.filter((category) => category.groups.some((group) => accepted.includes(group))).map((category) => category.label));
  const summary = parse((await readFile(path, 'utf8')).split('---\n')[1]!).description;
  assert.match(summary, /Software unit testing/);
  assert.match(summary, /Physical prototype validation/);
  const count = requests.length;
  await refreshDescription(path, catalog, client);
  assert.equal(requests.length, count);
});

test('no accepted broad domain makes one request and caches an empty classification', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-no-domain-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  await writeFile(path, '---\nname: jev-skills-router\ndescription: Previous summary.\n---\nBODY');
  let calls = 0;
  const client = new TypeSafeClient({ apiKey: 'test', fetch: async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.state.stage, 'groups');
    return Response.json({ model: 'jev-latest', answers: Object.fromEntries(Object.keys(request.questions).map((id) =>
      [id, { type: 'noul', noul: 0.7499 }])), usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  const catalog = [{ name: 'alien', description: 'An unknown discipline.', path: 'LOCAL' }];
  await refreshDescription(path, catalog, client);
  await refreshDescription(path, catalog, client);
  assert.equal(calls, 1);
  const cache = JSON.parse(await readFile(join(root, '.jev-skills-router-cache.json'), 'utf8'));
  assert.deepEqual(Object.values(cache.skills), [{ groups: [], categories: [] }]);
});


test('shared task families are reachable from every declared parent without duplicate judgments', async (t) => {
  const uxWriting = CATEGORIES.find((category) => category.label === 'UX writing')!;
  assert.ok(uxWriting.groups.includes('writing and languages'));
  assert.ok(uxWriting.groups.includes('UX research and design'));
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-shared-category-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  await writeFile(path, '---\nname: jev-skills-router\ndescription: Previous summary.\n---\nBODY');
  const inspected: string[] = [];
  const client = new TypeSafeClient({ apiKey: 'test', fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const answers = Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
      const instructions = (value as { instructions: { group?: { label: string }; category?: { label: string } } }).instructions;
      if (request.state.stage === 'groups') return [id, { type: 'noul', noul: ['writing and languages', 'UX research and design'].includes(instructions.group!.label) ? 0.9 : 0.1 }];
      inspected.push(instructions.category!.label);
      return [id, { type: 'noul', noul: instructions.category!.label === 'UX writing' ? 0.9 : 0.1 }];
    }));
    return Response.json({ model: 'jev-latest', answers, usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  await refreshDescription(path, [{ name: 'microcopy', description: 'Write interface labels.', path: 'LOCAL' }], client);
  assert.equal(inspected.filter((label) => label === 'UX writing').length, 1);
  const summary = parse((await readFile(path, 'utf8')).split('---\n')[1]!).description;
  assert.match(summary, /UX writing/);
  assert.ok(summary.includes('writing and languages'));
  assert.ok(summary.includes('UX research and design'));
});

test('an accepted domain survives in the summary and cache when no child exceeds the cutoff', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'jev-domain-fallback-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'SKILL.md');
  await writeFile(path, '---\nname: jev-skills-router\ndescription: Previous summary.\n---\nBODY');
  let requests = 0;
  const client = new TypeSafeClient({ apiKey: 'test', fetch: async (_url, init) => {
    requests++;
    const request = JSON.parse(String(init?.body));
    return Response.json({ model: 'jev-latest', answers: Object.fromEntries(Object.entries(request.questions).map(([id, value]) => {
      const group = (value as { instructions: { group?: { label: string } } }).instructions.group;
      return [id, { type: 'noul', noul: request.state.stage === 'groups' && group?.label === 'physical product testing and quality' ? 0.9 : 0 }];
    })), usage: { input_tokens: 0, output_tokens: 0 } });
  } });
  const catalog = [{ name: 'specialized-tests', description: 'An unusual physical product validation method.', path: 'LOCAL' }];
  await refreshDescription(path, catalog, client);
  assert.match(await readFile(path, 'utf8'), /physical product testing and quality/);
  const before = requests;
  await refreshDescription(path, catalog, client);
  assert.equal(requests, before);
  const cache = JSON.parse(await readFile(join(root, '.jev-skills-router-cache.json'), 'utf8'));
  assert.deepEqual(Object.values(cache.skills)[0], { groups: ['physical product testing and quality'], categories: [] });
});

test('every canonical category has defined parents and every domain has category coverage', () => {
  const groups = new Set(CATEGORY_GROUPS.map((group) => group.label));
  assert.equal(groups.size, CATEGORY_GROUPS.length);
  for (const category of CATEGORIES) {
    assert.ok(category.groups.length > 0);
    assert.equal(new Set(category.groups).size, category.groups.length);
    assert.ok(category.groups.every((group) => groups.has(group)), `Invalid parents for ${category.label}`);
  }
  for (const group of CATEGORY_GROUPS) {
    assert.ok(group.description.trim().length > 0);
    assert.ok(CATEGORIES.some((category) => category.groups.includes(group.label)), `Empty domain: ${group.label}`);
  }
  for (const [label, parents] of [
    ['Accessibility testing', ['software testing and quality', 'design systems and accessibility']],
    ['Physical prototype validation', ['physical product testing and quality', 'physical design']],
    ['Reliability engineering', ['engineering and hardware', 'infrastructure and operations', 'physical product testing and quality']],
    ['Statistical process control', ['manufacturing quality', 'data analysis']],
    ['Scientific visualization', ['data analysis', 'science and research']],
    ['Instructional design', ['education and learning', 'UX research and design']],
  ] as const) {
    const category = CATEGORIES.find((category) => category.label === label)!;
    assert.ok(category, `Missing ${label}`);
    assert.ok(parents.every((group) => category.groups.includes(group)), `Missing cross-domain memberships for ${label}`);
  }
});
