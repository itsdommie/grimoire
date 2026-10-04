// Bundles the Electron main process (including the Fastify server and shared code) into one CJS file,
// so the packaged app needs no node_modules. node:sqlite is a Node built-in and stays external.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';

execSync('npm run build -w @grimoire/web', { stdio: 'inherit', cwd: new URL('../..', import.meta.url) });

execSync('node scripts/third-party-notices.mjs', { stdio: 'inherit', cwd: new URL('../..', import.meta.url) });

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  // Google OAuth client for sync sign-in: put in by the release build from its secrets; empty in a local build (the app then says it is not set up).
  define: { __GOOGLE_CLIENT_ID__: JSON.stringify(process.env.GOOGLE_CLIENT_ID ?? ''), __GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.GOOGLE_CLIENT_SECRET ?? '') },
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});

// Semantic search runtime. onnxruntime-web's Node build imports `onnxruntime-common` by name, which only resolves when a
// node_modules folder sits above the file, as in a repo checkout but never in an installed app. Bundle it into one file and
// ship that next to the .wasm files, so the installed app is self-contained.
const ortSrc = new URL('../../node_modules/onnxruntime-web/dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync('build/ort', { recursive: true });
await build({
  entryPoints: [`${ortSrc}ort.node.min.mjs`],
  outfile: 'build/ort/ort.node.min.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'warning',
});
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) copyFileSync(`${ortSrc}${f}`, `build/ort/${f}`);
