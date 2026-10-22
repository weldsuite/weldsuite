/**
 * Rebuild the WeldCRM app icons and splash from the platform brand mark.
 *
 * Source: apps/web/platform/public/assets/images/weldcrm/icon.svg
 *         (resolved via ../../web/platform/... from this app)
 *
 * Regenerates:
 *   • assets/images/splash-icon.png        1024² transparent, ~50% fill
 *   • assets/images/adaptive-icon.png      1024² transparent, ~55% (Android safe zone)
 *   • assets/images/icon.png               1024² white tile (iOS / store)
 *   • assets/images/notification-icon.png  96² transparent silhouette
 *   • assets/images/logo.png               512² transparent mark (sign-in screen)
 *
 * Needs `sharp`, which is not a dependency of the app. Run from
 * apps/mobile/weldcrm-app with sharp on NODE_PATH, e.g.:
 *   npm install --prefix /tmp/sharp sharp
 *   NODE_PATH=/tmp/sharp/node_modules node scripts/generate-icons.cjs
 */
const sharp = require('sharp');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'images');
const SVG = path.resolve(ROOT, '../../web/platform/public/assets/images/weldcrm/icon.svg');

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** The mark, fitted inside a `maxDim` square without cropping (the viewBox is near square). */
function mark(maxDim) {
  return sharp(SVG, { density: 1200 })
    .resize(maxDim, maxDim, { fit: 'contain', background: TRANSPARENT })
    .png()
    .toBuffer();
}

async function fitSquare(canvas, targetFraction, bg) {
  const glyph = await mark(Math.round(canvas * targetFraction));
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: bg } })
    .composite([{ input: glyph, gravity: 'center' }])
    .png();
}

(async () => {
  if (!fs.existsSync(SVG)) throw new Error('Missing brand SVG at ' + SVG);
  fs.mkdirSync(OUT, { recursive: true });

  // Splash: transparent so the splash backgroundColor (white / black) shows through.
  await (await fitSquare(1024, 0.5, TRANSPARENT)).toFile(path.join(OUT, 'splash-icon.png'));
  // Adaptive foreground: inside the ~66% safe zone so launcher masks don't clip it.
  await (await fitSquare(1024, 0.55, TRANSPARENT)).toFile(path.join(OUT, 'adaptive-icon.png'));
  // Store / iOS icon: solid white tile (iOS icons can't be transparent).
  await (await fitSquare(1024, 0.68, WHITE)).toFile(path.join(OUT, 'icon.png'));
  // Notification: Android only uses the alpha channel, tinted by the plugin `color`.
  await (await fitSquare(96, 0.75, TRANSPARENT)).toFile(path.join(OUT, 'notification-icon.png'));
  // Sign-in screen mark.
  await (await fitSquare(512, 1, TRANSPARENT)).toFile(path.join(OUT, 'logo.png'));

  console.log('Generated from', path.relative(ROOT, SVG));
  for (const file of ['splash-icon.png', 'adaptive-icon.png', 'icon.png', 'notification-icon.png', 'logo.png']) {
    const meta = await sharp(path.join(OUT, file)).metadata();
    console.log(' ', file, `${meta.width}x${meta.height}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
