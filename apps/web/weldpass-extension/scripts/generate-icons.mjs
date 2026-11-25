/**
 * Rasterizes the WeldPass logo into the PNGs a Chrome manifest needs
 * (manifest icons cannot be SVG). The output is committed; re-run with
 * `pnpm --filter weldpass-extension icons` only when the source logo changes.
 *
 * Source: apps/web/platform/public/assets/images/weldpass/icon.svg, the
 * asterisk. It is drawn in white on an indigo tile so it stays legible at 16px
 * on both light and dark toolbars. The SVG is used as it is (strokes and all),
 * with its colours turned white.
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
const root = /<svg\b[^>]*>/.exec(svg)?.[0];
const viewBox = /viewBox="([\d.\s-]+)"/.exec(root ?? '')?.[1].trim().split(/\s+/).map(Number);
if (!root || !viewBox || viewBox.length !== 4) {
  throw new Error(`Could not read the logo's viewBox from ${source}`);
}

// The logo in white: every colour it paints with, stroke or fill, becomes #fff.
const white = svg
  .replace(/<\?xml[^>]*\?>/, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/(stroke|fill)="#[0-9a-fA-F]{3,8}"/g, '$1="#fff"')
  .trim();

// A square tile with the logo centred at 66% of its width.
const tile = 1000;
const box = tile * 0.66;
const offset = (tile - box) / 2;
const placed = white.replace(/<svg\b/, `<svg x="${offset}" y="${offset}" width="${box}" height="${box}"`);
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${tile} ${tile}">
  <rect width="${tile}" height="${tile}" rx="${tile * 0.22}" fill="${TILE}"/>
  ${placed}
</svg>`;

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon-${size}.png`);
  await sharp(Buffer.from(icon), { density: 300 }).resize(size, size).png().toFile(file);
  process.stdout.write(`wrote ${path.relative(process.cwd(), file)}\n`);
}
