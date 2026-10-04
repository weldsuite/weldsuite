/**
 * Rasterizes the WeldPass icon into the PNGs a Chrome manifest needs
 * (manifest icons cannot be SVG). The output is committed; re-run with
 * `pnpm --filter weldpass-extension icons` only when the source icon changes.
 *
 * Source: apps/web/platform/public/assets/images/weldpass/icon.svg — the key
 * is drawn in white on an indigo tile so it stays legible at 16px on both
 * light and dark toolbars.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '../../platform/public/assets/images/weldpass/icon.svg');
const outDir = path.resolve(here, '../public/icons');

const SIZES = [16, 32, 48, 128];
const TILE = '#4f46e5';

const svg = await readFile(source, 'utf8');
const pathData = /<path[^>]*\sd="([^"]+)"/s.exec(svg)?.[1];
const viewBox = /viewBox="([\d.\s-]+)"/.exec(svg)?.[1].trim().split(/\s+/).map(Number);
if (!pathData || !viewBox || viewBox.length !== 4) {
  throw new Error(`Could not read the icon path from ${source}`);
}
const [, , width, height] = viewBox;

// A square tile with the key centred at ~72% of its width.
const tile = 1000;
const scale = (tile * 0.72) / Math.max(width, height);
const dx = (tile - width * scale) / 2;
const dy = (tile - height * scale) / 2;
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tile} ${tile}">
  <rect width="${tile}" height="${tile}" rx="${tile * 0.22}" fill="${TILE}"/>
  <path transform="translate(${dx} ${dy}) scale(${scale})" fill="#fff" fill-rule="evenodd" d="${pathData}"/>
</svg>`;

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon-${size}.png`);
  await sharp(Buffer.from(icon), { density: 300 }).resize(size, size).png().toFile(file);
  process.stdout.write(`wrote ${path.relative(process.cwd(), file)}\n`);
}
