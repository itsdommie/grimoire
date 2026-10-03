// Regenerates the Android launcher icons from the desktop app's icon artwork (one source of truth).
// Needs sharp, which is not a dependency of the project:  npm i --no-save sharp && node packages/mobile/scripts/make-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const svg = readFileSync(resolve(root, 'packages/desktop/build/icon.svg'), 'utf8');
const res = resolve(root, 'packages/mobile/android/app/src/main/res');

// The artwork without its rounded-square background: the book and the star.
const art = svg.replace(/<rect[^>]*\/>/, '');
// Android masks the foreground layer to a circle-ish shape and only guarantees the middle 61% (66 of 108 dp), so the artwork
// (about 644 x 630 of the 1024 square) is scaled to sit inside that and centred.
const foregroundSvg = (size) => {
  const scale = 0.84 * (0.61 * 1024) / 644;
  const dx = 512 - 512 * scale, dy = 512 - 465 * scale; // artwork centre is about (512, 465)
  return Buffer.from(svg.replace(/<rect[^>]*\/>[\s\S]*?(?=<\/svg>)/, '').replace('</svg>', `<g transform="translate(${dx.toFixed(1)} ${dy.toFixed(1)}) scale(${scale.toFixed(4)})">${art.replace(/^[\s\S]*?<\/defs>/, '').replace('</svg>', '')}</g></svg>`)
    .replace('width="1024" height="1024"', `width="${size}" height="${size}"`));
};

const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [name, k] of Object.entries(densities)) {
  const dir = resolve(res, `mipmap-${name}`);
  const legacy = Math.round(48 * k), layer = Math.round(108 * k);
  // Older Android: the whole icon as a rounded square, and as a circle.
  const square = await sharp(Buffer.from(svg), { density: 300 }).resize(legacy, legacy).png().toBuffer();
  writeFileSync(resolve(dir, 'ic_launcher.png'), square);
  const circle = await sharp(square).composite([{ input: Buffer.from(`<svg width="${legacy}" height="${legacy}"><circle cx="${legacy / 2}" cy="${legacy / 2}" r="${legacy / 2}"/></svg>`), blend: 'dest-in' }]).png().toBuffer();
  writeFileSync(resolve(dir, 'ic_launcher_round.png'), circle);
  // Android 8 and later: the foreground layer (the background is a colour, see values/ic_launcher_background.xml).
  writeFileSync(resolve(dir, 'ic_launcher_foreground.png'), await sharp(foregroundSvg(1024), { density: 300 }).resize(layer, layer).png().toBuffer());
}
writeFileSync(resolve(res, 'values/ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#1E1B3B</color>
</resources>
`);
console.log('Launcher icons written.');
