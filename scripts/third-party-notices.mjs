// Writes THIRD_PARTY_NOTICES.txt: the copyright/licence text of every production dependency that ends up in the app,
// plus credits for the model and data sources. MIT/BSD/ISC licences require their notices to travel with the software.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const out = process.argv[2] ?? 'packages/desktop/build/THIRD_PARTY_NOTICES.txt';
const paths = execSync('npm ls --omit=dev --all --parseable', { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter((p) => p.includes('node_modules'));

const seen = new Map();
for (const dir of paths) {
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) continue;
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
  if (!pkg.name || pkg.name.startsWith('@grimoire/')) continue;
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  const licenseFile = readdirSync(dir).find((f) => /^(licen[sc]e|copying|notice)(\.|$)/i.test(f));
  const text = licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : '';
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses?.map((l) => l.type).join(' OR ') ?? 'UNKNOWN');
  seen.set(key, { name: pkg.name, version: pkg.version, license, repo: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '', text });
}

const header = `Grimoire third-party notices
=============================

Grimoire itself is MIT licensed (see LICENSE). It includes or uses the following.

Data and models
---------------
- Card data, rulings and Oracle Tags: Scryfall (https://scryfall.com), used under its data terms. Card images are loaded directly
  from Scryfall and are never copied or altered. Magic: The Gathering is (c) Wizards of the Coast LLC; Grimoire is unofficial
  fan content and is not approved or endorsed by Wizards of the Coast.
- Semantic search (optional, downloaded on request): BGE-small-en-v1.5 by BAAI (MIT), ONNX conversion by Xenova
  (https://huggingface.co/Xenova/bge-small-en-v1.5), run with ONNX Runtime Web (MIT, Microsoft).
- Electron and Chromium licences are included in the application folder (LICENSE.electron.txt, LICENSES.chromium.html).

npm packages (production dependencies)
--------------------------------------
`;
const body = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)).map((p) => `
${p.name} ${p.version}  (${p.license})${p.repo ? `\n${p.repo}` : ''}
${p.text ? '\n' + p.text : '\n(no licence file shipped in the package; licence declared as ' + p.license + ')'}
${'-'.repeat(72)}`).join('\n');
writeFileSync(out, header + body + '\n');
console.log(`${seen.size} packages -> ${out} (${(readFileSync(out).length / 1024).toFixed(0)} KB, ${basename(out)})`);
const unknown = [...seen.values()].filter((p) => !/MIT|ISC|BSD|Apache|0BSD|BlueOak|CC0|Python|Unlicense/i.test(p.license));
if (unknown.length) console.warn('Review these licences:', unknown.map((p) => `${p.name} (${p.license})`).join(', '));
