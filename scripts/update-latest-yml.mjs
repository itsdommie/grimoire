// After the Windows installer is code-signed, its bytes (and therefore its checksum and size) change. electron-updater verifies the
// downloaded installer against the sha512 in latest.yml, so the feed must be regenerated from the signed file.
// Usage: node scripts/update-latest-yml.mjs <latest.yml> <installer.exe>
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Rewrite the sha512 and size of every entry that refers to `fileName`, and the top-level sha512 if `path` is that file. */
export function updateLatestYml(yml, fileName, sha512, size) {
  const lines = yml.split('\n');
  let inTarget = false;
  let changed = 0;
  const out = lines.map((line) => {
    const url = /^\s*-\s+url:\s*(.+?)\s*$/.exec(line);
    if (url) inTarget = url[1] === fileName;
    if (inTarget && /^\s+sha512:/.test(line)) { changed++; return line.replace(/sha512:.*/, `sha512: ${sha512}`); }
    if (inTarget && /^\s+size:/.test(line)) { changed++; return line.replace(/size:.*/, `size: ${size}`); }
    const top = /^path:\s*(.+?)\s*$/.exec(line);
    if (top) inTarget = top[1] === fileName;
    if (/^sha512:/.test(line) && inTarget) { changed++; return `sha512: ${sha512}`; }
    return line;
  });
  if (changed < 3) throw new Error(`Expected to update sha512 and size for ${fileName} in the files list and the top-level sha512, but changed ${changed} lines.`);
  return out.join('\n');
}

export function sha512Base64(path) {
  return createHash('sha512').update(readFileSync(path)).digest('base64');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [ymlPath, installer] = process.argv.slice(2);
  if (!ymlPath || !installer) { console.error('Usage: update-latest-yml.mjs <latest.yml> <installer.exe>'); process.exit(2); }
  const updated = updateLatestYml(readFileSync(ymlPath, 'utf8'), basename(installer), sha512Base64(installer), statSync(installer).size);
  writeFileSync(ymlPath, updated);
  console.log(`Updated ${ymlPath} for ${basename(installer)}`);
}
