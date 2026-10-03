// Serves mobile/dist for desktop-browser testing (the Android app serves the same folder from its WebView).
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('./dist/', import.meta.url));
const port = Number(process.env.PORT ?? 8124);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.db': 'application/octet-stream' };
http.createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(dist, rel === '/' || rel === '\\' ? 'index.html' : rel);
  try {
    const s = statSync(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'content-length': s.size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404).end('not found'); }
}).listen(port, '127.0.0.1', () => console.log(`serving ${dist} on http://127.0.0.1:${port}`));
