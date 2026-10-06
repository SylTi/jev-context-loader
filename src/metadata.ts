import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import type { SkillMetadata } from './router.js';

function frontmatter(source: string, path: string) {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!header) return undefined;
  const document = parseDocument(header[1]!);
  if (document.errors.length) throw new Error(`Invalid YAML frontmatter: ${path}: ${document.errors[0]!.message}`);
  return { document, body: source.slice(header[0].length) };
}

export async function readSkillMetadata(path: string): Promise<SkillMetadata | undefined> {
  const header = frontmatter(await readFile(path, 'utf8'), path);
  if (!header) return undefined;
  const metadata: unknown = header.document.toJS();
  if (typeof metadata !== 'object' || metadata === null || !('name' in metadata)) return undefined;
  if (typeof metadata.name !== 'string' || !metadata.name.trim() ||
      !('description' in metadata) || typeof metadata.description !== 'string' || !metadata.description.trim()) {
    throw new Error(`Skill requires a string name and description: ${path}`);
  }
  if (metadata.name === 'jev-skills-router') return undefined;
  return { name: metadata.name, description: metadata.description, path };
}

export async function writeRouterDescription(path: string, description: string): Promise<void> {
  const source = await readFile(path, 'utf8');
  const header = frontmatter(source, path);
  if (!header || header.document.get('name') !== 'jev-skills-router') throw new Error(`Expected a jev-skills-router SKILL.md: ${path}`);
  if (header.document.get('description') === description) return;
  header.document.set('description', description);
  await writeFile(path, `---\n${header.document.toString()}---\n${header.body}`);
}
