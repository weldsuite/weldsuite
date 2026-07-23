#!/usr/bin/env node
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import png2icons from 'png2icons';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DESKTOP_ROOT ?? path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'assets');
const RESOURCES = path.join(ROOT, 'resources');

const SOURCE = process.env.ICON_SOURCE
  ?? 'C:/Users/gertv/Downloads/logos/suite/PNG/Asset 5@4x.png';

// White tile gives highest contrast for the blue WeldSuite mark.
// Switch to '#3f72ff' (brand blue) with a white-recolored mark if a colored
// tile is preferred later.
const TILE_BG = '#ffffff';

await mkdir(BUILD, { recursive: true });
await mkdir(RESOURCES, { recursive: true });

console.log(`Source: ${SOURCE}`);

// --- Padded master: 1024x1024 on brand-blue rounded background (for mac/windows tile look)
// We keep the logo itself transparent on the colored disk, because the Asset 5 mark
// already has white negative space; adding our brand bg gives a finished app-icon look.
const master = await sharp(SOURCE)
  .resize(680, 680, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .extend({
    top: 172, bottom: 172, left: 172, right: 172,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

const bgSvg = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024">
    <rect width="1024" height="1024" rx="224" ry="224" fill="${TILE_BG}"/>
  </svg>`,
);

const composed1024 = await sharp(bgSvg)
  .composite([{ input: master }])
  .png()
  .toBuffer();

await writeFile(path.join(BUILD, 'icon.png'), composed1024);
console.log('wrote build/icon.png (1024x1024)');

// --- Linux: 512 + 256 variants, electron-builder picks best
const linux512 = await sharp(composed1024).resize(512, 512).png().toBuffer();
await writeFile(path.join(BUILD, 'icon-512.png'), linux512);

// --- Windows .ico: pack 16, 24, 32, 48, 64, 128, 256
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoBuffers = await Promise.all(
  icoSizes.map((size) => sharp(composed1024).resize(size, size).png().toBuffer()),
);
const icoBuffer = await pngToIco(icoBuffers);
await writeFile(path.join(BUILD, 'icon.ico'), icoBuffer);
console.log(`wrote build/icon.ico (sizes: ${icoSizes.join(', ')})`);

// --- macOS .icns
const icnsBuffer = png2icons.createICNS(composed1024, png2icons.BICUBIC, 0);
if (!icnsBuffer) throw new Error('png2icons.createICNS returned null');
await writeFile(path.join(BUILD, 'icon.icns'), icnsBuffer);
console.log('wrote build/icon.icns');

// --- Tray template (macOS expects black + alpha, named *Template.png)
// Flatten brand-colored mark to pure black, keep alpha from the source.
// Pre-trim the source so the mark fills the tray icon tightly.
const trimmed = await sharp(SOURCE).trim().toBuffer();

async function makeTrayTemplate(size) {
  const pad = Math.max(1, Math.round(size * 0.08));
  const inner = size - pad * 2;
  const alpha = await sharp(trimmed)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({
      top: pad, bottom: pad, left: pad, right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .extractChannel(3)
    .toBuffer();

  // 3-channel black canvas + joinChannel(alpha) → black-with-alpha template
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .joinChannel(alpha)
    .png()
    .toBuffer();
}

const tray1x = await makeTrayTemplate(16);
const tray2x = await makeTrayTemplate(32);
const tray3x = await makeTrayTemplate(48);
await writeFile(path.join(RESOURCES, 'trayTemplate.png'), tray1x);
await writeFile(path.join(RESOURCES, 'trayTemplate@2x.png'), tray2x);
await writeFile(path.join(RESOURCES, 'trayTemplate@3x.png'), tray3x);
console.log('wrote resources/trayTemplate.png (+ @2x, @3x)');

console.log('done.');
