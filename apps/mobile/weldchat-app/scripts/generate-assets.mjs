/**
 * Rasterize the WeldChat mark into the Expo asset set.
 *
 * Source of truth is the platform SVG
 * (apps/web/platform/public/assets/images/weldchat/icon.svg) so the mobile
 * icon stays in lockstep with the sidebar / app-store mark.
 */
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = process.argv[2];
if (!OUT) throw new Error('usage: node generate-assets.mjs <outDir>');

const GREEN = '#00bb67';
const VB_W = 670;
const VB_H = 733;

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(
  here,
  '../../../../apps/web/platform/public/assets/images/weldchat/icon.svg',
);

function extractPaths(svg) {
  return [...svg.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]);
}

function markSvg(size, fill, markRatio, paths) {
  const h = size * markRatio;
  const w = h * (VB_W / VB_H);
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  const inner = paths.map((d) => `<path fill="${fill}" d="${d}"/>`).join('');
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="0 0 ${VB_W} ${VB_H}">
    ${inner}
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

const source = await readFile(SRC, 'utf8');
const paths = extractPaths(source);
if (paths.length === 0) throw new Error(`No paths found in ${SRC}`);

await mkdir(OUT, { recursive: true });

await render(markSvg(1024, GREEN, 0.62, paths), 1024, 'icon.png', '#FFFFFF');
await render(markSvg(512, GREEN, 0.62, paths), 512, 'icon-512.png', '#FFFFFF');
await render(markSvg(1024, GREEN, 0.44, paths), 1024, 'adaptive-icon.png', null);
await render(markSvg(1024, GREEN, 0.68, paths), 1024, 'splash-icon.png', null);
await render(markSvg(96, '#FFFFFF', 0.78, paths), 96, 'notification-icon.png', null);
await render(markSvg(512, GREEN, 0.82, paths), 512, 'logo.png', null);

await writeFile(
  path.join(OUT, 'README.md'),
  `# WeldChat App Assets

Generated from the platform's WeldChat mark
(\`apps/web/platform/public/assets/images/weldchat/icon.svg\`) so the mobile icon
stays in lockstep with the sidebar / app-store mark. Regenerate with
\`scripts/generate-assets.mjs\` if that SVG changes.

| File | Spec | Purpose |
|---|---|---|
| \`icon.png\` | 1024x1024, opaque, no alpha, no rounded corners | iOS/Android app icon (stores mask it) |
| \`icon-512.png\` | 512x512, opaque, no alpha | Play Console high-res icon |
| \`adaptive-icon.png\` | 1024x1024 foreground on transparent, mark within the 66% safe zone | Android adaptive icon foreground |
| \`splash-icon.png\` | 1024x1024 transparent, rendered at \`imageWidth: 200\` | Splash screen |
| \`notification-icon.png\` | 96x96 monochrome white on transparent | Android notification tray icon |
| \`logo.png\` | 512x512 transparent | Login screen logo |

Brand color (Android adaptive background + notification tint): \`#00bb67\`.
`,
);
console.log('  README.md');
