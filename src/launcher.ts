import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { runNpm } from './npm.js';

const marker = 'jev-skills-router launcher';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export async function setupCommand(entry: string, binDirectory?: string): Promise<string> {
  const script = await realpath(entry);
  const prefix = binDirectory ? undefined : await runNpm(['prefix', '--global'], dirname(script), true);
  const bin = resolve(binDirectory ?? (process.platform === 'win32' ? prefix! : join(prefix!, 'bin')));
  await mkdir(bin, { recursive: true });
  const path = join(bin, process.platform === 'win32' ? 'jev-skills-router.cmd' : 'jev-skills-router');
  try {
    if (!(await readFile(path, 'utf8')).includes(marker)) throw new Error(`Command already exists: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const windowsQuote = (value: string) => `"${value.replaceAll('%', '%%')}"`;
  const source = process.platform === 'win32' ?
    `@echo off\r\nrem ${marker}\r\n${windowsQuote(process.execPath)} ${windowsQuote(script)} %*\r\n` :
    `#!/bin/sh\n# ${marker}\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`;
  await writeFile(path, source);
  if (process.platform !== 'win32') await chmod(path, 0o755);
  return path;
}
