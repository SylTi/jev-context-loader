import { build } from 'esbuild';

const options = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: '#!/usr/bin/env node\nimport { createRequire as bundleCreateRequire } from "node:module"; const require = bundleCreateRequire(import.meta.url);' },
};
await build({ ...options, entryPoints: ['src/cli.ts'], outfile: 'scripts/jev-skills-router.mjs' });
await build({ ...options, entryPoints: ['src/cli.ts'], outfile: 'scripts/route.mjs' });
