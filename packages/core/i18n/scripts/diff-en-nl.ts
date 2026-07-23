import { en } from '../src/locales/en';
import { nl } from '../src/locales/nl';

type Any = Record<string, any>;

function leaves(obj: Any, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj ?? {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [kk, vv] of leaves(v, path)) out.set(kk, vv);
    } else {
      out.set(path, Array.isArray(v) ? JSON.stringify(v) : String(v));
    }
  }
  return out;
}

const MARKERS = ['[TRANSLATE]', '[REVIEW]', 'TODO', 'FIXME', '[NL]', 'XXX'];

const namespaces = Object.keys(en as Any);
let totalMissing = 0;
let totalMarker = 0;
const summary: { ns: string; missing: number; marker: number }[] = [];
const detail: Record<string, { missing: [string, string][]; marker: [string, string][] }> = {};

for (const ns of namespaces) {
  const enLeaves = leaves((en as Any)[ns]);
  const nlLeaves = leaves((nl as Any)[ns] ?? {});
  const missing: [string, string][] = [];
  const marker: [string, string][] = [];

  for (const [path, enVal] of enLeaves) {
    if (!nlLeaves.has(path)) {
      missing.push([path, enVal]);
    } else {
      const nlVal = nlLeaves.get(path)!;
      if (MARKERS.some((m) => nlVal.includes(m))) marker.push([path, nlVal]);
    }
  }
  if (missing.length || marker.length) {
    summary.push({ ns, missing: missing.length, marker: marker.length });
    detail[ns] = { missing, marker };
  }
  totalMissing += missing.length;
  totalMarker += marker.length;
}

summary.sort((a, b) => b.missing + b.marker - (a.missing + a.marker));

console.log('=== SUMMARY (namespaces with gaps) ===');
for (const s of summary) {
  console.log(`${s.ns.padEnd(18)} missing=${s.missing}  marker=${s.marker}`);
}
console.log(`\nTOTAL missing keys: ${totalMissing}`);
console.log(`TOTAL marker keys:  ${totalMarker}`);
console.log(`Namespaces with gaps: ${summary.length} / ${namespaces.length}`);

// Emit machine-readable JSON for the workflow to consume
import { writeFileSync } from 'fs';
writeFileSync(
  new URL('./en-nl-gap.json', import.meta.url),
  JSON.stringify({ totalMissing, totalMarker, summary, detail }, null, 2)
);
console.log('\nWrote en-nl-gap.json');
