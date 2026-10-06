import { noul, TypeSafeClient } from '@typesafe-ai/sdk';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { exists } from './context.js';
import { readProbability } from './judgments.js';

export function credentialsPath(): string {
  const home = homedir();
  const root = process.platform === 'win32' ? process.env.APPDATA ?? join(home, 'AppData/Roaming') :
    process.platform === 'darwin' ? join(home, 'Library/Application Support') : process.env.XDG_CONFIG_HOME ?? join(home, '.config');
  return join(root, 'jev-skills-router', 'credentials.json');
}

export async function getApiKey(path = credentialsPath()): Promise<string | undefined> {
  if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
  if (!await exists(path)) return undefined;
  const key: unknown = JSON.parse(await readFile(path, 'utf8')).apiKey;
  if (typeof key !== 'string' || !key.trim()) throw new Error(`Invalid credentials file: ${path}`);
  return key;
}

export async function saveApiKey(key: string, path = credentialsPath(), client = new TypeSafeClient({ apiKey: key })): Promise<void> {
  if (!key.trim()) throw new Error('API key must not be blank.');
  const { answers } = await client.systemOne({ state: { purpose: 'authentication' },
    questions: { auth: noul('Is one plus one equal to two?') } });
  readProbability(answers, 'auth');
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(path + '.tmp', JSON.stringify({ apiKey: key.trim() }) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}

export async function promptKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('Run auth in your own interactive terminal. Never send the API key through chat or command arguments.');
  process.stderr.write('Jev API key (input hidden): ');
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const data = (chunk: Buffer) => {
        for (const character of chunk.toString('utf8')) {
          if (character === '\u0003') { cleanup(); reject(new Error('Authentication cancelled.')); return; }
          if (character === '\r' || character === '\n') { cleanup(); resolve(value); return; }
          if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
          else value += character;
        }
      };
      const cleanup = () => input.off('data', data);
      input.on('data', data);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    process.stderr.write('\n');
  }
}
