#!/usr/bin/env node
/**
 * Builds a mobile app's icons from its module's logo in the platform
 * (apps/web/platform/public/assets/images/<module>/icon.svg), so the phone
 * apps carry the same marks as the app rail and the App Store.
 *
 *   pnpm mobile:icons weldpass-app weldbooks-app
 *
 * Writes into apps/mobile/<app>/assets/images:
 *
 * | File                    | What                                                        |
 * | ----------------------- | ----------------------------------------------------------- |
 * | icon.png                | 1024x1024, opaque white, the store icon (stores round it)   |
 * | icon-512.png            | 512x512, opaque white; only where the app already has one   |
 * | adaptive-icon.png       | 1024x1024 transparent, the mark inside Android's safe zone  |
 * | splash-icon.png         | 1024x1024 transparent, drawn at app.json's imageWidth       |
 * | logo.png                | 512x512 transparent, the sign-in screen's logo              |
 * | notification-icon.png   | 96x96 white on transparent; only where the app has one      |
 *
 * app.json is not changed: point `android.adaptiveIcon.foregroundImage` at
 * adaptive-icon.png with a white `backgroundColor`. New icons reach phones
 * with the next native build, not an OTA update.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Apps whose module folder in the platform isn't the app name minus `-app`. */
const MODULE_FOLDER = { 'weldsocial-app': 'social' };

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** The logo, scaled so its longer side is `size` pixels, on a transparent background. */
async function mark(svg, size) {
  return sharp(svg, { density: 1200 })
    .resize(size, size, { fit: 'inside' })
    .png()
    .toBuffer();
}

/** The logo centred on a square canvas, its longer side `ratio` of the canvas. */
async function tile(svg, canvas, ratio, background) {
  const glyph = await mark(svg, Math.round(canvas * ratio));
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background } })
    .composite([{ input: glyph, gravity: 'center' }])
    .png();
}

/** A store icon has no alpha channel (App Store Connect refuses one). */
async function opaque(pipeline) {
  const flat = await (await pipeline).toBuffer();
  return sharp(flat).flatten({ background: WHITE }).removeAlpha().png();
}

/**
 * Android's notification icon: white where the logo paints, transparent
 * elsewhere. Near-white parts of the logo (a glyph on a tile) become holes, so
 * a tiled logo keeps its glyph.
 */
async function silhouette(svg, canvas, ratio) {
  const scale = 4;
  const { data, info } = await (await tile(svg, canvas * scale, ratio, CLEAR))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const nearWhite = Math.min(data[i], data[i + 1], data[i + 2]) > 200;
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = nearWhite ? 0 : data[i + 3];
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .resize(canvas, canvas)
    .png();
}

async function build(app) {
  const appDir = path.join(root, 'apps/mobile', app);
  if (!existsSync(path.join(appDir, 'app.json'))) throw new Error(`Not a mobile app: apps/mobile/${app}`);
  const folder = MODULE_FOLDER[app] ?? app.replace(/-app$/, '');
  const source = path.join(root, 'apps/web/platform/public/assets/images', folder, 'icon.svg');
  if (!existsSync(source)) throw new Error(`No platform logo for ${app}: ${path.relative(root, source)}`);

  const svg = await readFile(source);
  const out = path.join(appDir, 'assets/images');
  await mkdir(out, { recursive: true });
  const has = (file) => existsSync(path.join(out, file));

  const files = [
    ['icon.png', () => opaque(tile(svg, 1024, 0.62, WHITE))],
    has('icon-512.png') && ['icon-512.png', () => opaque(tile(svg, 512, 0.62, WHITE))],
    // The safe zone is a circle of 66% of the canvas; a square mark fits it at ~46%.
    ['adaptive-icon.png', () => tile(svg, 1024, 0.46, CLEAR)],
    ['splash-icon.png', () => tile(svg, 1024, 0.68, CLEAR)],
    ['logo.png', () => tile(svg, 512, 0.86, CLEAR)],
    has('notification-icon.png') && ['notification-icon.png', () => silhouette(svg, 96, 0.78)],
  ].filter(Boolean);

  for (const [file, render] of files) {
    await (await render()).toFile(path.join(out, file));
  }
  console.log(`${app}: ${files.map(([file]) => file).join(', ')} from ${path.relative(root, source)}`);
}

const apps = process.argv.slice(2);
if (apps.length === 0) {
  console.error('usage: pnpm mobile:icons <app> [<app> ...]   e.g. weldpass-app');
  process.exit(1);
}
for (const app of apps) await build(app);
