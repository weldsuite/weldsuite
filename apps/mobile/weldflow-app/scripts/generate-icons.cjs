const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const SRC = 'C:/Users/gertv/Downloads/logos/flow/PNG';
const OUT = path.resolve(__dirname, '..', 'assets', 'images');

async function trim(input, alphaThresh = 200) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let minX = width, maxX = -1, minY = height, maxY = -1;
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
  if (maxX < 0) throw new Error('Empty image: ' + input);
  return sharp(input).extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 });
}

async function fitSquare(srcSharp, canvas, targetFraction, bg) {
  const buf = await srcSharp.png().toBuffer();
  const m = await sharp(buf).metadata();
  const maxDim = Math.round(canvas * targetFraction);
  const scale = Math.min(maxDim / m.width, maxDim / m.height);
  const w = Math.round(m.width * scale);
  const h = Math.round(m.height * scale);
  const resized = await sharp(buf).resize(w, h, { fit: 'contain' }).png().toBuffer();
  return sharp({
    create: { width: canvas, height: canvas, channels: 4, background: bg },
  })
    .composite([{ input: resized, gravity: 'center' }])
    .png();
}

async function fitRect(srcSharp, width, height, targetFraction, bg) {
  const buf = await srcSharp.png().toBuffer();
  const m = await sharp(buf).metadata();
  const maxW = Math.round(width * targetFraction);
  const maxH = Math.round(height * targetFraction);
  const scale = Math.min(maxW / m.width, maxH / m.height);
  const w = Math.round(m.width * scale);
  const h = Math.round(m.height * scale);
  const resized = await sharp(buf).resize(w, h, { fit: 'contain' }).png().toBuffer();
  return sharp({
    create: { width, height, channels: 4, background: bg },
  })
    .composite([{ input: resized, gravity: 'center' }])
    .png();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const iconRed = await trim(path.join(SRC, 'Asset 4@4x.png'));
  const iconWhite = await trim(path.join(SRC, 'Asset 1@4x.png'));
  const lockupH = await trim(path.join(SRC, 'Asset 5@4x.png'));

  const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };
  const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

  // icon.png — 1024x1024, red icon on white, ~72% fill
  await (await fitSquare(iconRed, 1024, 0.72, WHITE)).toFile(path.join(OUT, 'icon.png'));

  // adaptive-icon.png — 1024x1024, transparent bg (Android composites with backgroundColor),
  // icon sized at ~55% so it survives the circular/squircle mask (safe zone is ~66%)
  await (await fitSquare(iconRed, 1024, 0.55, TRANSPARENT)).toFile(path.join(OUT, 'adaptive-icon.png'));

  // splash-icon.png — 1024x1024 red icon, transparent bg (Expo uses backgroundColor from config)
  await (await fitSquare(iconRed, 1024, 0.6, TRANSPARENT)).toFile(path.join(OUT, 'splash-icon.png'));

  // notification-icon.png — Android uses the alpha channel only (silhouettes the shape and tints with
  // the `color` prop), so red vs white gives an identical on-device result. Use the red version so the
  // file is visible when browsing the filesystem.
  await (await fitSquare(iconRed, 256, 0.7, TRANSPARENT)).toFile(path.join(OUT, 'notification-icon.png'));

  // logo.png — horizontal wordmark lockup, used in-app. Keep aspect ratio close to source (5466x952 ≈ 5.74:1).
  // Render at 1536x268 (same ratio) transparent bg.
  await (await fitRect(lockupH, 1536, 268, 0.96, TRANSPARENT)).toFile(path.join(OUT, 'logo.png'));

  console.log('Generated:');
  for (const f of ['icon.png', 'adaptive-icon.png', 'splash-icon.png', 'notification-icon.png', 'logo.png']) {
    const m = await sharp(path.join(OUT, f)).metadata();
    console.log(' ', f, m.width + 'x' + m.height);
  }
})();
