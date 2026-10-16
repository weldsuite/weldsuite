#!/usr/bin/env node
/**
 * Builds the invoice-template fonts and the metrics table the layout measures with.
 *
 *   src/invoice-template/fonts/*.ttf   Noto Sans / Serif / Sans Mono, subset to
 *                                      Latin, Greek, Cyrillic and common symbols
 *   src/invoice-template/font-metrics.ts   advance widths per code point (generated)
 *
 * The subset has no GSUB/GPOS/GDEF and no hinting: without layout tables a
 * browser cannot kern or ligate, and pdf-lib draws each glyph at its advance,
 * so a line is exactly the sum of the widths in font-metrics.ts everywhere.
 *
 * Source fonts: the static Google Fonts builds published on npm.
 *   npm pack @expo-google-fonts/noto-sans@0.4.2 @expo-google-fonts/noto-serif@0.4.2 @expo-google-fonts/noto-sans-mono@0.4.2
 * and unpack them under one folder. The script needs `subset-font` (harfbuzz)
 * and `@pdf-lib/fontkit`, resolved from the current directory:
 *   mkdir fonttools && cd fonttools && npm i subset-font@2.9.0 @pdf-lib/fontkit@1.1.1
 *   node <repo>/packages/domains/books/scripts/build-invoice-fonts.mjs --src <folder with the unpacked packages>
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(join(process.cwd(), 'noop.js'));
const subsetFont = require('subset-font');
const fontkit = require('@pdf-lib/fontkit');

const here = dirname(fileURLToPath(import.meta.url));
const templateDir = resolve(here, '../src/invoice-template');
const outDir = join(templateDir, 'fonts');

const srcArg = process.argv.indexOf('--src');
if (srcArg < 0 || !process.argv[srcArg + 1]) {
  console.error('usage: build-invoice-fonts.mjs --src <folder with @expo-google-fonts/noto-* unpacked>');
  process.exit(1);
}
const srcRoot = resolve(process.argv[srcArg + 1]);

/** Template font → [key, source file name] per face; Noto Sans Mono has no italic (the painters slant it). */
const FACES = [
  ['sans-regular', 'NotoSans_400Regular.ttf'],
  ['sans-bold', 'NotoSans_700Bold.ttf'],
  ['sans-italic', 'NotoSans_400Regular_Italic.ttf'],
  ['sans-bold-italic', 'NotoSans_700Bold_Italic.ttf'],
  ['serif-regular', 'NotoSerif_400Regular.ttf'],
  ['serif-bold', 'NotoSerif_700Bold.ttf'],
  ['serif-italic', 'NotoSerif_400Regular_Italic.ttf'],
  ['serif-bold-italic', 'NotoSerif_700Bold_Italic.ttf'],
  ['mono-regular', 'NotoSansMono_400Regular.ttf'],
  ['mono-bold', 'NotoSansMono_700Bold.ttf'],
];

/** What an invoice needs: European, Vietnamese, Greek and Cyrillic text, currencies, typographic punctuation. */
const RANGES = [
  [0x0020, 0x007e], // Basic Latin
  [0x00a0, 0x00ff], // Latin-1
  [0x0100, 0x024f], // Latin Extended-A/B (ł ő č ś ș ț …)
  [0x0259, 0x0259], // ə (Azerbaijani)
  [0x02bb, 0x02bc], // ʻ ʼ
  [0x02c6, 0x02dd], // spacing accents
  [0x0300, 0x036f], // combining marks (text is NFC-normalised, these catch the rest)
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x052f], // Cyrillic + supplement
  [0x1e00, 0x1eff], // Latin Extended Additional (Vietnamese)
  [0x2000, 0x206f], // general punctuation (– — ‘ ’ “ ” „ • … ‰ and the odd spaces)
  [0x20a0, 0x20c0], // currency symbols (₹ ₺ ₴ ₽ ₿ € ₫ ₱ ₩ ₪ …)
  [0x2100, 0x2150], // letterlike (№ ™ ℓ ℮)
  [0x2150, 0x218b], // number forms (⅓ ⅔ …)
  [0x2190, 0x2199], // arrows
  [0x2212, 0x2212], // minus
  [0x2215, 0x2215],
  [0x2219, 0x221a],
  [0x221e, 0x221e],
  [0x2248, 0x2248],
  [0x2260, 0x2265],
  [0x25a0, 0x25cf], // squares and circles
  [0xfffd, 0xfffd],
];

/**
 * Pads every glyph in `glyf` to a 4-byte boundary (long `loca`).
 *
 * pdf-lib embeds through fontkit's subsetter, which copies each glyph's bytes
 * and writes a short `loca` (offsets / 2) whenever the subset is small. A
 * source with a long `loca` and odd-length glyphs (Noto Serif: harfbuzz only
 * pads when it can use a short `loca` itself) then yields broken outlines.
 */
function padGlyphs(input) {
  const src = Buffer.from(input);
  const numTables = src.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const tag = src.toString('latin1', rec, rec + 4);
    const offset = src.readUInt32BE(rec + 8);
    tables.set(tag, src.subarray(offset, offset + src.readUInt32BE(rec + 12)));
  }
  const head = Buffer.from(tables.get('head'));
  const longLoca = head.readInt16BE(50) === 1;
  const oldLoca = tables.get('loca');
  const glyf = tables.get('glyf');
  const count = oldLoca.length / (longLoca ? 4 : 2);
  const at = (i) => (longLoca ? oldLoca.readUInt32BE(i * 4) : oldLoca.readUInt16BE(i * 2) * 2);

  const glyphs = [];
  const loca = Buffer.alloc(count * 4);
  let offset = 0;
  for (let i = 0; i < count; i++) {
    loca.writeUInt32BE(offset, i * 4);
    if (i === count - 1) break;
    const data = glyf.subarray(at(i), at(i + 1));
    const padded = Buffer.alloc((data.length + 3) & ~3);
    data.copy(padded);
    glyphs.push(padded);
    offset += padded.length;
  }
  head.writeInt16BE(1, 50);
  head.writeUInt32BE(0, 8); // checkSumAdjustment, set below
  tables.set('head', head);
  tables.set('loca', loca);
  tables.set('glyf', Buffer.concat(glyphs));

  const checksum = (buf) => {
    const padded = Buffer.alloc((buf.length + 3) & ~3);
    buf.copy(padded);
    let sum = 0;
    for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
    return sum;
  };
  const tags = [...tables.keys()].sort();
  const header = Buffer.alloc(12 + tags.length * 16);
  src.copy(header, 0, 0, 12);
  const bodies = [];
  let pos = header.length;
  tags.forEach((tag, i) => {
    const data = tables.get(tag);
    const rec = 12 + i * 16;
    header.write(tag, rec, 'latin1');
    header.writeUInt32BE(checksum(data), rec + 4);
    header.writeUInt32BE(pos, rec + 8);
    header.writeUInt32BE(data.length, rec + 12);
    const padded = Buffer.alloc((data.length + 3) & ~3);
    data.copy(padded);
    bodies.push(padded);
    pos += padded.length;
  });
  const out = Buffer.concat([header, ...bodies]);
  const headOffset = header.readUInt32BE(12 + tags.indexOf('head') * 16 + 8);
  out.writeUInt32BE((0xb1b0afba - checksum(out)) >>> 0, headOffset + 8);
  return out;
}

function findFile(root, name) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      const found = findFile(path, name);
      if (found) return found;
    } else if (entry === name) return path;
  }
  return null;
}

const wanted = [];
for (const [from, to] of RANGES) for (let cp = from; cp <= to; cp++) wanted.push(cp);

mkdirSync(outDir, { recursive: true });
const faces = {};
let license = null;

for (const [key, fileName] of FACES) {
  const srcPath = findFile(srcRoot, fileName);
  if (!srcPath) throw new Error(`${fileName} not found under ${srcRoot}`);
  license ??= findFile(dirname(dirname(srcPath)), 'LICENSE_FONT');

  const source = readFileSync(srcPath);
  const full = fontkit.create(source);
  const covered = wanted.filter((cp) => full.hasGlyphForCodePoint(cp));

  const subset = padGlyphs(
    await subsetFont(source, String.fromCodePoint(...covered), {
      targetFormat: 'truetype',
      noHinting: true,
      noLayoutClosure: true,
      dropTables: ['GSUB', 'GPOS', 'GDEF', 'kern', 'DSIG', 'STAT', 'MVAR', 'HVAR'],
    }),
  );
  const file = `noto-${key}.ttf`;
  writeFileSync(join(outDir, file), subset);

  // Measure the subset itself, so the table describes exactly the file that ships.
  const font = fontkit.create(subset);
  const scale = 1000 / font.unitsPerEm;
  const width = (cp) => Math.round(font.glyphForCodePoint(cp).advanceWidth * scale);
  const runs = [];
  let prev = -2;
  for (const cp of covered) {
    if (!font.hasGlyphForCodePoint(cp)) throw new Error(`${file} lost U+${cp.toString(16)}`);
    if (cp !== prev + 1) runs.push([cp]);
    runs[runs.length - 1].push(width(cp));
    prev = cp;
  }
  // Glyph tops of "H" and "d": where the layout centres a line, like the AFM Ascender did.
  const top = Math.max(font.glyphForCodePoint(0x48).bbox.maxY, font.glyphForCodePoint(0x64).bbox.maxY);
  faces[key] = {
    file,
    hash: createHash('sha256').update(subset).digest('hex').slice(0, 12),
    ascent: Math.round(top * scale) / 1000,
    runs,
  };
  console.log(`${file}: ${covered.length} code points, ${(subset.length / 1024).toFixed(0)} KB (source ${(source.length / 1024).toFixed(0)} KB)`);
}

if (license) writeFileSync(join(outDir, 'OFL.txt'), readFileSync(license));

const body = Object.entries(faces)
  .map(
    ([key, f]) =>
      `  '${key}': {\n    file: '${f.file}',\n    hash: '${f.hash}',\n    ascent: ${f.ascent},\n    runs: ${JSON.stringify(f.runs)},\n  },`,
  )
  .join('\n');

writeFileSync(
  join(templateDir, 'font-metrics.ts'),
  `/**
 * GENERATED by packages/domains/books/scripts/build-invoice-fonts.mjs — do not edit.
 *
 * Advance widths (1/1000 em) of the bundled invoice fonts in ./fonts, as runs
 * of consecutive code points: [first code point, width, width, …]. The layout
 * engine measures with these and both painters draw with the same files.
 */

export const FONT_FACE_KEYS = [${Object.keys(faces)
    .map((k) => `'${k}'`)
    .join(', ')}] as const;
export type FontFaceKey = (typeof FONT_FACE_KEYS)[number];

export interface FaceMetricsSource {
  /** File name under ./fonts. */
  file: string;
  /** First 12 hex characters of the file's SHA-256, for cache busting. */
  hash: string;
  /** Glyph top of "H"/"d" as a fraction of the font size. */
  ascent: number;
  runs: number[][];
}

export const FONT_METRICS: Record<FontFaceKey, FaceMetricsSource> = {
${body}
};
`,
);
console.log('wrote font-metrics.ts');
