// Regenerates every raster icon, favicon and splash image from the two master drawings in brand/ (the mark, and the mark on its tile).
// Needs `rsvg-convert` (librsvg) and ImageMagick (`magick`) on the PATH. Run: node scripts/make-icons.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const at = (...p) => resolve(root, ...p);
const MARK = at('brand/brewhall-mark.svg');
const ICON = at('brand/brewhall-icon.svg');
const BG = '#15100c'; // the app's page colour (the same as --bg-0 in the dark theme)
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
const out = (path) => { mkdirSync(dirname(path), { recursive: true }); return path; };
const svgToPng = (svg, size, path, extra = []) => run('rsvg-convert', ['-w', String(size), '-h', String(size), ...extra, svg, '-o', out(path)]);

// Desktop: electron-builder makes the .ico and .icns from this.
svgToPng(ICON, 1024, at('packages/desktop/build/icon.png'));
copyFileSync(ICON, at('packages/desktop/build/icon.svg'));

// The web app's tab icon, and the website's.
copyFileSync(ICON, out(at('packages/web/public/favicon.svg')));
svgToPng(ICON, 180, at('packages/web/public/apple-touch-icon.png'));
copyFileSync(ICON, out(at('site/favicon.svg')));
svgToPng(ICON, 1024, at('site/img/icon.png'));
svgToPng(ICON, 180, at('site/img/apple-touch-icon.png'));

// Android launcher icons: the square one, the round one, and the adaptive foreground (the mark inside the safe zone, no tile).
const res = at('packages/mobile/android/app/src/main/res');
const dpi = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const tmp = resolve(tmpdir(), `brewhall-icons-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const roundSvg = resolve(tmp, 'round.svg');
writeFileSync(roundSvg, readFileSync(ICON, 'utf8').replace(/<rect width="512" height="512" rx="112"/g, '<rect width="512" height="512" rx="256"').replace('<rect x="3" y="3" width="506" height="506" rx="109"', '<rect x="3" y="3" width="506" height="506" rx="253"'));
for (const [name, k] of Object.entries(dpi)) {
  svgToPng(ICON, Math.round(48 * k), `${res}/mipmap-${name}/ic_launcher.png`);
  svgToPng(roundSvg, Math.round(48 * k), `${res}/mipmap-${name}/ic_launcher_round.png`);
  // 108dp canvas; the mark fills the central 66dp circle that no launcher mask cuts into, with the pot filling most of the mark's width.
  const canvas = Math.round(108 * k);
  const markPx = Math.round(76 * k); // (the mark is tall and narrow: its height is what must stay inside the safe zone)
  const markPng = resolve(tmp, `mark-${name}.png`);
  svgToPng(MARK, markPx, markPng);
  run('magick', ['-size', `${canvas}x${canvas}`, 'xc:none', markPng, '-gravity', 'center', '-composite', out(`${res}/mipmap-${name}/ic_launcher_foreground.png`)]);
}

// The launch image older Android versions show (Android 12 and later show the launcher icon on the background colour instead).
const splash = [['drawable', 480, 320], ['drawable-port-mdpi', 320, 480], ['drawable-port-hdpi', 480, 800], ['drawable-port-xhdpi', 720, 1280], ['drawable-port-xxhdpi', 960, 1600], ['drawable-port-xxxhdpi', 1280, 1920],
  ['drawable-land-mdpi', 480, 320], ['drawable-land-hdpi', 800, 480], ['drawable-land-xhdpi', 1280, 720], ['drawable-land-xxhdpi', 1600, 960], ['drawable-land-xxxhdpi', 1920, 1280]];
for (const [dir, w, h] of splash) {
  const markPng = resolve(tmp, `splash-${w}x${h}.png`);
  svgToPng(MARK, Math.round(Math.min(w, h) * 0.34), markPng);
  run('magick', ['-size', `${w}x${h}`, `xc:${BG}`, markPng, '-gravity', 'center', '-composite', out(`${res}/${dir}/splash.png`)]);
}
console.log('icons written');
