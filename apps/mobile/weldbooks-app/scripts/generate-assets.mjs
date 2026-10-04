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
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The output directory comes from the command line (and so, potentially, from an
// automated caller): resolve it and refuse anything outside this app's folder so
// a stray `../..` can never make the script write elsewhere on disk.
const APP_ROOT = path.resolve(here, '..');
const outArg = process.argv[2];
if (!outArg) throw new Error('usage: node generate-assets.mjs <outDir>');
const OUT = path.resolve(process.cwd(), outArg);
const outRelative = path.relative(APP_ROOT, OUT);
if (outRelative.startsWith('..') || path.isAbsolute(outRelative)) {
  throw new Error(`Output directory must be inside ${APP_ROOT}, got ${OUT}`);
}

const EMERALD = '#10B981';
// Crop of Lucide's 24x24 grid to the mark's stroke bounds, as in the platform icon.svg.
const VB_X = 3;
const VB_Y = 1;
const VB_W = 18;
const VB_H = 22;

/** The calculator shapes (Lucide "calculator"), lifted verbatim from the platform icon.svg. */
const MARK = [
  '<rect width="16" height="20" x="4" y="2" rx="2"/>',
  '<line x1="8" x2="16" y1="6" y2="6"/>',
  '<line x1="16" x2="16" y1="14" y2="18"/>',
  '<path d="M16 10h.01"/>',
  '<path d="M12 10h.01"/>',
  '<path d="M8 10h.01"/>',
  '<path d="M12 14h.01"/>',
  '<path d="M8 14h.01"/>',
  '<path d="M12 18h.01"/>',
  '<path d="M8 18h.01"/>',
].join('\n    ');

/** Mark on a transparent square canvas, scaled to `markRatio` of the canvas height. */
function markSvg(size, stroke, markRatio) {
  const h = size * markRatio;
  const w = h * (VB_W / VB_H);
  const x = (size - w) / 2;
  const y = (size - h) / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${VB_X} ${VB_Y} ${VB_W} ${VB_H}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${MARK}
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

// Play Console high-res icon.
await render(markSvg(512, EMERALD, 0.62), 512, 'icon-512.png', '#FFFFFF');

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
| \`icon-512.png\` | 512x512, opaque, no alpha | Play Console high-res icon |
| \`adaptive-icon.png\` | 1024x1024 foreground on transparent, mark within the 66% safe zone | Android adaptive icon foreground |
| \`splash-icon.png\` | 1024x1024 transparent, rendered at \`imageWidth: 200\` | Splash screen |
| \`notification-icon.png\` | 96x96 monochrome white on transparent | Android notification tray icon |
| \`logo.png\` | 512x512 transparent | Login screen logo |

Brand color (Android adaptive background + notification tint): \`#10B981\` (emerald).
`,
);
console.log('  README.md');
