// Bundles the Electron main process (including the Fastify server and shared code) into one CJS file,
// so the packaged app needs no node_modules. node:sqlite is a Node built-in and stays external.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';

execSync('npm run build -w @grimoire/web', { stdio: 'inherit', cwd: new URL('../..', import.meta.url) });

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
  minify: false,
  logLevel: 'info',
});
