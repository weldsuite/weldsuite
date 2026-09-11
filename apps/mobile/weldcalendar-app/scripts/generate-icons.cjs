/**
 * Generate WeldCalendar app icons from the platform's brand SVG.
 *
 * Unlike WeldFlow's script (which trims PNG exports out of a local Downloads
 * folder), this one renders straight from the vector the platform sidebar
 * already ships, so the mobile icon can never drift from the web mark:
 *
 *   apps/web/platform/public/assets/images/weldcalendar/icon.svg
 *
 * Run from the repo root (sharp is hoisted there):
 *   node apps/mobile/weldcalendar-app/scripts/generate-icons.cjs
 */

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..', '..');
const OUT = path.join(APP_ROOT, 'assets', 'images');

const BRAND_SVG = path.join(
  REPO_ROOT,
  'apps/web/platform/public/assets/images/weldcalendar/icon.svg',
);
/** Horizontal wordmark lockup for the login screen. */
const WORDMARK_PNG = path.join(
  REPO_ROOT,
  'apps/web/platform/public/assets/images/weldcalendar/logo-text-light.png',
);

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** Crop a buffer down to its non-transparent bounding box. */
async function trim(input, alphaThresh = 12) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = data[(y * width + x) * channels + 3];
      if (a > alphaThresh) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('Empty image');
  return sharp(input)
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .png()
    .toBuffer();
}

/** Render the brand SVG at a generous raster size, then trim the margins. */
async function renderMark() {
  const raw = await sharp(fs.readFileSync(BRAND_SVG), { density: 600 })
    .resize({ width: 2048, fit: 'inside' })
    .png()
    .toBuffer();
  return trim(raw);
}

async function fitSquare(buf, canvas, targetFraction, bg) {
  const m = await sharp(buf).metadata();
  const max = Math.round(canvas * targetFraction);
  const scale = Math.min(max / m.width, max / m.height);
  const resized = await sharp(buf)
    .resize(Math.round(m.width * scale), Math.round(m.height * scale), { fit: 'contain' })
    .png()
    .toBuffer();
  return sharp({ create: { width: canvas, height: canvas, channels: 4, background: bg } })
    .composite([{ input: resized, gravity: 'center' }])
    .png();
}

async function fitRect(buf, width, height, targetFraction, bg) {
  const m = await sharp(buf).metadata();
  const scale = Math.min(
    (width * targetFraction) / m.width,
    (height * targetFraction) / m.height,
  );
  const resized = await sharp(buf)
    .resize(Math.round(m.width * scale), Math.round(m.height * scale), { fit: 'contain' })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 4, background: bg } })
    .composite([{ input: resized, gravity: 'center' }])
    .png();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mark = await renderMark();

  // icon.png — 1024x1024 opaque. Stores reject alpha and apply their own mask.
  await (await fitSquare(mark, 1024, 0.7, WHITE)).toFile(path.join(OUT, 'icon.png'));

  // adaptive-icon.png — foreground layer only; Android composites it over
  // `android.adaptiveIcon.backgroundColor` and masks to a circle/squircle, so
  // keep the mark inside the ~66% safe zone.
  await (await fitSquare(mark, 1024, 0.55, TRANSPARENT)).toFile(
    path.join(OUT, 'adaptive-icon.png'),
  );

  // splash-icon.png — transparent; expo-splash-screen paints the background.
  await (await fitSquare(mark, 1024, 0.6, TRANSPARENT)).toFile(
    path.join(OUT, 'splash-icon.png'),
  );

  // notification-icon.png — Android uses the ALPHA CHANNEL ONLY and tints the
  // silhouette with the plugin's `color`, so the source colour is irrelevant.
  await (await fitSquare(mark, 256, 0.7, TRANSPARENT)).toFile(
    path.join(OUT, 'notification-icon.png'),
  );

  // logo.png — horizontal wordmark for the login screen.
  const wordmark = await trim(fs.readFileSync(WORDMARK_PNG));
  const wm = await sharp(wordmark).metadata();
  const ratio = wm.width / wm.height;
  await (await fitRect(wordmark, 1536, Math.round(1536 / ratio), 0.96, TRANSPARENT)).toFile(
    path.join(OUT, 'logo.png'),
  );

  console.log('Generated:');
  for (const f of [
    'icon.png',
    'adaptive-icon.png',
    'splash-icon.png',
    'notification-icon.png',
    'logo.png',
  ]) {
    const m = await sharp(path.join(OUT, f)).metadata();
    console.log(' ', f, `${m.width}x${m.height}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
