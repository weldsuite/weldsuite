#!/usr/bin/env node
// The Microsoft Store package's tile and logo images (ADR FE-023), made from
// the app icon (assets/icon.png, 1024×1024, written by generate-icons.mjs).
// electron-builder's appx target maps assets/appx/* into the package; the
// scale- and targetsize- variants make it build a resources.pri, so Windows
// picks the sharp one for each display.
//
//   pnpm --filter desktop icons:store
import sharp from 'sharp';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'assets', 'icon.png');
const OUT = path.join(ROOT, 'assets', 'appx');

const transparent = { r: 0, g: 0, b: 0, alpha: 0 };

/** The icon, `size` pixels square, centred on a transparent `width`×`height` canvas. */
async function tile(file, width, height, size = Math.min(width, height)) {
  const icon = await sharp(SOURCE).resize(size, size).png().toBuffer();
  await sharp({ create: { width, height, channels: 4, background: transparent } })
    .composite([{ input: icon, gravity: 'centre' }])
    .png()
    .toFile(path.join(OUT, file));
}

await mkdir(OUT, { recursive: true });
await Promise.all((await readdir(OUT)).map((file) => rm(path.join(OUT, file))));

const scaled = [100, 200].flatMap((scale) => {
  const s = scale / 100;
  return [
    // The Store's own listing and the package's logo.
    tile(`StoreLogo.scale-${scale}.png`, 50 * s, 50 * s),
    // Start menu, taskbar and the app list.
    tile(`Square44x44Logo.scale-${scale}.png`, 44 * s, 44 * s),
    // Start tiles: medium, wide (the icon in the middle), small and large.
    tile(`Square150x150Logo.scale-${scale}.png`, 150 * s, 150 * s, 100 * s),
    tile(`Wide310x150Logo.scale-${scale}.png`, 310 * s, 150 * s, 100 * s),
    tile(`SmallTile.scale-${scale}.png`, 71 * s, 71 * s, 56 * s),
    tile(`LargeTile.scale-${scale}.png`, 310 * s, 310 * s, 200 * s),
  ];
});

// The taskbar and Explorer ask for exact pixel sizes; "unplated" draws the
// icon without the tile behind it.
const exact = [16, 24, 32, 48, 256].flatMap((size) => [
  tile(`Square44x44Logo.targetsize-${size}.png`, size, size),
  tile(`Square44x44Logo.targetsize-${size}_altform-unplated.png`, size, size),
]);

await Promise.all([...scaled, ...exact]);

console.log(`wrote ${(await readdir(OUT)).length} images to assets/appx`);
