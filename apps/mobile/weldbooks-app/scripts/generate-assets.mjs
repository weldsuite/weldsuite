/**
 * Rasterize the WeldBooks calculator mark into the Expo asset set.
 *
 * Source of truth is the platform SVG
 * (apps/web/platform/public/assets/images/weldbooks/icon.svg) so the mobile
 * icon stays in lockstep with the sidebar / app-store mark.
 */
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node gen-weldbooks-assets.mjs <outDir>');

const EMERALD = '#10B981';
const VB_W = 520;
const VB_H = 680;

/** The calculator path, lifted verbatim from the platform icon.svg. */
const PATH_D = [
  'M120,0h280c66.27,0,120,53.73,120,120v440c0,66.27-53.73,120-120,120H120C53.73,680,0,626.27,0,560V120C0,53.73,53.73,0,120,0Z',
  'M80,92h360c22.09,0,40,17.91,40,40v104c0,22.09-17.91,40-40,40H80c-22.09,0-40-17.91-40-40V132c0-22.09,17.91-40,40-40Z',
  'M100,400m-52,0a52,52 0 1,1 104,0a52,52 0 1,1 -104,0Z',
  'M260,400m-52,0a52,52 0 1,1 104,0a52,52 0 1,1 -104,0Z',
  'M420,400m-52,0a52,52 0 1,1 104,0a52,52 0 1,1 -104,0Z',
  'M100,560m-52,0a52,52 0 1,1 104,0a52,52 0 1,1 -104,0Z',
  'M260,560m-52,0a52,52 0 1,1 104,0a52,52 0 1,1 -104,0Z',
  'M420,560m-52,0a52,52 0 1,1 104,0a52,52 0 1,1 -104,0Z',
].join('\n      ');

/** Mark on a transparent square canvas, scaled to `markRatio` of the canvas height. */
function markSvg(size, fill, markRatio) {
  const h = size * markRatio;
  const w = h * (VB_W / VB_H);
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${VB_W} ${VB_H}">
    <path fill="${fill}" fill-rule="evenodd" d="${PATH_D}"/>
  </svg>
</svg>`,
  );
}

async function render(svg, size, file, background) {
  let img = sharp(svg, { density: 384 }).resize(size, size);
  if (background) img = img.flatten({ background });
  await img.png().toFile(path.join(OUT, file));
  console.log(`  ${file}  ${size}x${size}${background ? ' opaque' : ' alpha'}`);
}

await mkdir(OUT, { recursive: true });

// iOS/Android store icon — opaque white field, stores apply their own mask.
await render(markSvg(1024, EMERALD, 0.62), 1024, 'icon.png', '#FFFFFF');

// Android adaptive foreground — mark sits inside the 66% safe zone.
await render(markSvg(1024, EMERALD, 0.44), 1024, 'adaptive-icon.png', null);

// Splash — app.json renders this at imageWidth 200, resizeMode contain.
await render(markSvg(1024, EMERALD, 0.68), 1024, 'splash-icon.png', null);

// Android notification tray — must be monochrome white on transparent.
await render(markSvg(96, '#FFFFFF', 0.78), 96, 'notification-icon.png', null);

// Login-screen logo.
await render(markSvg(512, EMERALD, 0.82), 512, 'logo.png', null);

await writeFile(
  path.join(OUT, 'README.md'),
  `# WeldBooks App Assets

Generated from the platform's WeldBooks mark
(\`apps/web/platform/public/assets/images/weldbooks/icon.svg\`) so the mobile icon
stays in lockstep with the sidebar and app-store mark. Regenerate with
\`scripts/generate-assets.mjs\` if that SVG changes.

| File | Spec | Purpose |
|---|---|---|
| \`icon.png\` | 1024x1024, opaque, no alpha, no rounded corners | iOS/Android app icon (stores mask it) |
| \`adaptive-icon.png\` | 1024x1024 foreground on transparent, mark within the 66% safe zone | Android adaptive icon foreground |
| \`splash-icon.png\` | 1024x1024 transparent, rendered at \`imageWidth: 200\` | Splash screen |
| \`notification-icon.png\` | 96x96 monochrome white on transparent | Android notification tray icon |
| \`logo.png\` | 512x512 transparent | Login screen logo |

Brand color (Android adaptive background + notification tint): \`#10B981\` (emerald).
`,
);
console.log('  README.md');
