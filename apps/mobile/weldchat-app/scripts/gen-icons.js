/* eslint-disable */
// One-shot generator: rebuild the WeldChat app launcher icons from the platform
// brand mark (apps/web/platform/public/assets/images/weldchat/icon.svg — the green
// #00bb67 speech bubble). Regenerates:
//   • assets/images/icon.png            (iOS icon + Expo source, 1024²)
//   • android .../mipmap-*/ic_launcher.webp + ic_launcher_round.webp (legacy)
//   • android .../mipmap-*/ic_launcher_foreground.webp (adaptive foreground)
// Android adaptive background stays @color/iconBackground (#E6F4FE).
// Run: node scripts/gen-icons.js  (from apps/mobile/weldchat-app)
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SVG = path.resolve(
  ROOT,
  '../../../apps/web/platform/public/assets/images/weldchat/icon.svg',
);
const ASPECT = 670 / 733; // brand-mark width / height
const BG = '#E6F4FE'; // light-blue icon tile (matches @color/iconBackground)

// Render the green bubble at a given pixel height (transparent background).
async function bubble(height) {
  const width = Math.round(height * ASPECT);
  return sharp(SVG, { density: 1200 }).resize(width, height, { fit: 'fill' }).png().toBuffer();
}

function circleSvg(size, color) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${color}"/></svg>`,
  );
}

// Solid-background square icon, bubble centered at `ratio` of the canvas height.
async function squareIcon(size, ratio) {
  const glyph = await bubble(Math.round(size * ratio));
  return sharp({ create: { width: size, height: size, channels: 4, background: BG } })
    .composite([{ input: glyph, gravity: 'center' }]);
}

// Round icon: filled circle tile + centered bubble, transparent outside.
async function roundIcon(size, ratio) {
  const glyph = await bubble(Math.round(size * ratio));
  return sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([
      { input: circleSvg(size, BG), gravity: 'center' },
      { input: glyph, gravity: 'center' },
    ]);
}

// Adaptive foreground: transparent canvas, bubble kept inside the safe zone.
async function foreground(size, ratio) {
  const glyph = await bubble(Math.round(size * ratio));
  return sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } })
    .composite([{ input: glyph, gravity: 'center' }]);
}

const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
const res = (d) => path.resolve(ROOT, `android/app/src/main/res/mipmap-${d}`);

(async () => {
  // iOS + Expo source icon (solid tile, no transparency allowed on iOS).
  await (await squareIcon(1024, 0.56)).png().toFile(path.resolve(ROOT, 'assets/images/icon.png'));

  for (const [d, size] of Object.entries(LEGACY)) {
    await (await squareIcon(size, 0.6)).webp({ lossless: true }).toFile(path.join(res(d), 'ic_launcher.webp'));
    await (await roundIcon(size, 0.6)).webp({ lossless: true }).toFile(path.join(res(d), 'ic_launcher_round.webp'));
  }
  for (const [d, size] of Object.entries(FOREGROUND)) {
    // Foreground glyph stays well within the inner safe zone so launcher masks
    // (circle/squircle) never clip the bubble. The #E6F4FE background is drawn
    // by the adaptive-icon <background> layer, not baked here.
    await (await foreground(size, 0.42)).webp({ lossless: true }).toFile(path.join(res(d), 'ic_launcher_foreground.webp'));
  }

  console.log('WeldChat icons regenerated from', path.relative(ROOT, SVG));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
