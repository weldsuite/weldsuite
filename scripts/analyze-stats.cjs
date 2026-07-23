const fs = require('fs');
const html = fs.readFileSync('apps/web/platform/dist/stats.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const dataScript = scripts[1][1];
const m = dataScript.match(/const\s+data\s*=\s*(\{[\s\S]*?\});\s*const\s+run/);
const data = JSON.parse(m[1]);

const metas = data.nodeMetas;
const parts = data.nodeParts;

function findChunks(node, out = []) {
  if (node.name && /^assets\/.+\.js$/.test(node.name)) out.push(node);
  if (node.children) for (const c of node.children) findChunks(c, out);
  return out;
}
function sizeOf(node) {
  if (node.uid) return parts[node.uid] ? parts[node.uid].renderedLength : 0;
  if (!node.children) return 0;
  return node.children.reduce((s, x) => s + sizeOf(x), 0);
}
function pkgOf(id) {
  if (!id) return '(unknown)';
  id = id.replace(/\\/g, '/');
  const pnpm = id.match(/node_modules\/\.pnpm\/([^/]+?)@[^/]+\/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  if (pnpm) return 'npm: ' + pnpm[2];
  const nm = id.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
  if (nm) return 'npm: ' + nm[1];
  const local = id.match(/repos\/weldsuite\/(apps\/[^/]+\/(?:src|app|components|lib|hooks)\/[^/]+|packages\/[^/]+\/[^/]+)/);
  if (local) return '[local] ' + local[1];
  return '[other] ' + id.slice(0,80);
}

const chunks = findChunks(data.tree);
const big = chunks.filter(c => sizeOf(c) > 500 * 1024).sort((a,b) => sizeOf(b) - sizeOf(a));

console.log('Chunks over 500 KB raw:');
for (const c of big) {
  console.log('\n' + '='.repeat(70));
  console.log(c.name, '—', (sizeOf(c) / 1024).toFixed(0), 'KB raw');
  const byPkg = new Map();
  function walk(node) {
    if (node.uid) {
      const part = parts[node.uid];
      if (!part) return;
      const meta = metas[part.metaUid];
      const id = meta ? meta.id : '';
      const pkg = pkgOf(id);
      byPkg.set(pkg, (byPkg.get(pkg) || 0) + part.renderedLength);
    }
    if (node.children) for (const x of node.children) walk(x);
  }
  walk(c);
  [...byPkg.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8).forEach(([pkg,size]) => {
    console.log('  ', (size/1024).toFixed(1).padStart(7), 'KB ', pkg);
  });
}
