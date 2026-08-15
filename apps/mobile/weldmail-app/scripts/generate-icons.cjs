/* eslint-disable */
/**
 * Rebuild WeldMail splash + adaptive icons from the platform brand mark.
 *
 * Source: apps/web/platform/public/assets/images/weldmail/icon.svg
 *         (resolved via ../../web/platform/... from this app)
 * (orange rounded envelope with a transparent V cutout — the V inherits
 * whatever sits behind it, so one asset works in light and dark splash).
 *
 * Regenerates:
 *   • assets/images/splash-icon.png     1024² transparent, ~50% fill
 *   • assets/images/adaptive-icon.png  1024² transparent, ~55% (Android safe zone)
 *   • assets/images/icon.png           1024² white tile (iOS / store)
 *   • assets/images/notification-icon.png  96² transparent silhouette
 *
 * Does NOT overwrite logo.png (in-app lockup; separate asset).
 *
 * Run from apps/mobile/weldmail-app:
 *   node scripts/generate-icons.cjs
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'images');
const SVG = path.resolve(
  ROOT,
  '../../web/platform/public/assets/images/weldmail/icon.svg',
);

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };
const ASPECT = 937.21 / 669.01; // viewBox width / height

async function mark(maxDim) {
  // Fit the landscape mark inside a square of `maxDim` without cropping.
  const width = maxDim;
  const height = Math.round(maxDim / ASPECT);
  if (height > maxDim) {
    const h = maxDim;
    const w = Math.round(maxDim * ASPECT);
    return sharp(SVG, { density: 1200 }).resize(w, h, { fit: 'fill' }).png().toBuffer();
  }
  return sharp(SVG, { density: 1200 }).resize(width, height, { fit: 'fill' }).png().toBuffer();
}

async function fitSquare(canvas, targetFraction, bg) {
  const maxDim = Math.round(canvas * targetFraction);
  const glyph = await mark(maxDim);
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: bg },
  })
    .composite([{ input: glyph, gravity: 'center' }])
    .png();
}

(async () => {
  if (!fs.existsSync(SVG)) {
    throw new Error('Missing brand SVG at ' + SVG);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // Splash: transparent canvas so expo-splash-screen backgroundColor shows
  // through (white in light mode, black in dark). Extra padding (~50%) so the
  // mark does not look zoomed-in at imageWidth 200.
  await (await fitSquare(1024, 0.5, TRANSPARENT)).toFile(path.join(OUT, 'splash-icon.png'));

  // Adaptive foreground: transparent; Android composites backgroundColor.
  // Keep inside the ~66% safe zone so circle/squircle masks do not clip it.
  await (await fitSquare(1024, 0.55, TRANSPARENT)).toFile(path.join(OUT, 'adaptive-icon.png'));

  // Store / iOS icon: solid white tile (no transparency allowed on iOS icons).
  await (await fitSquare(1024, 0.72, WHITE)).toFile(path.join(OUT, 'icon.png'));

  // Notification: alpha-only silhouette tinted by the plugin `color`.
  await (await fitSquare(96, 0.7, TRANSPARENT)).toFile(path.join(OUT, 'notification-icon.png'));

  console.log('Generated from', path.relative(ROOT, SVG));
  for (const f of ['splash-icon.png', 'adaptive-icon.png', 'icon.png', 'notification-icon.png']) {
    const m = await sharp(path.join(OUT, f)).metadata();
    console.log(' ', f, m.width + 'x' + m.height);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
