import type { Dashboard, Framework, SuiteResult } from './aggregate.js';

/**
 * Renders the aggregated model into a single self-contained HTML page —
 * no external CSS/JS, no client fetch. Collapsible failure lists use native
 * <details>, so the page works as a plain static asset.
 */

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

const FRAMEWORK_LABELS: Record<Framework, string> = {
  vitest: 'Vitest · unit',
  playwright: 'Playwright · E2E',
  jest: 'Jest · mobile',
  unknown: 'Other',
};

function statusOf(s: SuiteResult): 'pass' | 'fail' | 'empty' {
  if (s.tests === 0) return 'empty';
  return s.failed > 0 ? 'fail' : 'pass';
}

function suiteRow(s: SuiteResult): string {
  const status = statusOf(s);
  const total = Math.max(s.tests, 1);
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  const bar = `
    <div class="bar" title="${s.passed} passed / ${s.failed} failed / ${s.skipped} skipped">
      <span class="seg pass" style="width:${pct(s.passed)}"></span>
      <span class="seg fail" style="width:${pct(s.failed)}"></span>
      <span class="seg skip" style="width:${pct(s.skipped)}"></span>
    </div>`;

  const failures =
    s.failures.length > 0
      ? `<details class="failures">
           <summary>${s.failures.length} failing test${s.failures.length === 1 ? '' : 's'}</summary>
           <ul>${s.failures
             .map(
               (f) =>
                 `<li><code>${esc(f.name)}</code>${f.message ? `<span>${esc(f.message)}</span>` : ''}</li>`,
             )
             .join('')}</ul>
         </details>`
      : '';

  return `
    <div class="suite ${status}">
      <div class="suite-head">
        <span class="dot"></span>
        <span class="app">${esc(s.app)}</span>
        <span class="counts">
          <b>${s.tests}</b> tests
          ${s.failed > 0 ? `· <em class="fail">${s.failed} failed</em>` : ''}
          ${s.skipped > 0 ? `· <em class="skip">${s.skipped} skipped</em>` : ''}
          · ${fmtDuration(s.durationMs)}
        </span>
      </div>
      ${bar}
      ${failures}
    </div>`;
}

function frameworkSection(framework: Framework, suites: SuiteResult[]): string {
  const tests = suites.reduce((n, s) => n + s.tests, 0);
  const failed = suites.reduce((n, s) => n + s.failed, 0);
  return `
    <section class="fw ${failed > 0 ? 'has-fail' : ''}">
      <h2>${esc(FRAMEWORK_LABELS[framework])}
        <span class="fw-meta">${suites.length} suites · ${tests} tests${failed > 0 ? ` · ${failed} failing` : ''}</span>
      </h2>
      ${suites.map(suiteRow).join('')}
    </section>`;
}

export function renderDashboard(d: Dashboard): string {
  const { totals } = d;
  const order: Framework[] = ['playwright', 'vitest', 'jest', 'unknown'];
  const byFramework = order
    .map((fw) => [fw, d.suites.filter((s) => s.framework === fw)] as const)
    .filter(([, list]) => list.length > 0);

  const overall = totals.failed > 0 ? 'fail' : totals.tests > 0 ? 'pass' : 'empty';
  const overallLabel =
    overall === 'fail' ? `${totals.failed} failing` : overall === 'pass' ? 'All passing' : 'No data';

  const meta = [
    d.branch ? `branch <b>${esc(d.branch)}</b>` : null,
    d.commit ? `commit <b>${esc(d.commit)}</b>` : null,
    `generated ${esc(new Date(d.generatedAt).toUTCString())}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeldSuite · Test Dashboard</title>
<style>
  :root {
    --bg:#0b0e14; --panel:#141925; --panel-2:#1b2230; --border:#262e3d;
    --text:#e6e9ef; --muted:#8a93a6; --pass:#2ecc71; --fail:#ff5c5c;
    --skip:#f0b429; --accent:#5b8cff;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1040px; margin:0 auto; padding:32px 20px 64px; }
  header { display:flex; align-items:center; gap:16px; flex-wrap:wrap;
    margin-bottom:8px; }
  h1 { font-size:20px; margin:0; font-weight:650; }
  h1 span { color:var(--accent); }
  .badge { font-weight:650; padding:4px 12px; border-radius:999px; font-size:13px; }
  .badge.pass { background:rgba(46,204,113,.15); color:var(--pass); }
  .badge.fail { background:rgba(255,92,92,.15); color:var(--fail); }
  .badge.empty { background:var(--panel-2); color:var(--muted); }
  .meta { color:var(--muted); font-size:12px; margin-bottom:24px; }
  .meta b { color:var(--text); font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr));
    gap:12px; margin-bottom:32px; }
  .card { background:var(--panel); border:1px solid var(--border);
    border-radius:12px; padding:16px; }
  .card .n { font-size:26px; font-weight:700; line-height:1; }
  .card .l { color:var(--muted); font-size:12px; margin-top:6px; }
  .card.pass .n { color:var(--pass); } .card.fail .n { color:var(--fail); }
  .card.skip .n { color:var(--skip); }
  section.fw { margin-bottom:28px; }
  section.fw h2 { font-size:14px; text-transform:uppercase; letter-spacing:.04em;
    color:var(--muted); font-weight:650; margin:0 0 12px;
    display:flex; align-items:baseline; gap:10px; }
  .fw-meta { font-size:12px; text-transform:none; letter-spacing:0; }
  section.fw.has-fail h2 { color:var(--fail); }
  .suite { background:var(--panel); border:1px solid var(--border);
    border-left:3px solid var(--border); border-radius:10px;
    padding:14px 16px; margin-bottom:10px; }
  .suite.pass { border-left-color:var(--pass); }
  .suite.fail { border-left-color:var(--fail); }
  .suite.empty { border-left-color:var(--muted); opacity:.7; }
  .suite-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .dot { width:8px; height:8px; border-radius:50%; background:var(--muted); }
  .suite.pass .dot { background:var(--pass); }
  .suite.fail .dot { background:var(--fail); }
  .app { font-weight:600; }
  .counts { color:var(--muted); font-size:12px; }
  .counts b { color:var(--text); }
  .counts em { font-style:normal; }
  .counts em.fail { color:var(--fail); } .counts em.skip { color:var(--skip); }
  .bar { display:flex; height:6px; border-radius:4px; overflow:hidden;
    background:var(--panel-2); margin-top:10px; }
  .seg.pass { background:var(--pass); } .seg.fail { background:var(--fail); }
  .seg.skip { background:var(--skip); }
  details.failures { margin-top:10px; }
  details.failures summary { cursor:pointer; color:var(--fail); font-size:12px;
    font-weight:600; }
  details.failures ul { list-style:none; margin:8px 0 0; padding:0;
    border-top:1px solid var(--border); }
  details.failures li { padding:8px 0; border-bottom:1px solid var(--border); }
  details.failures code { color:var(--text); font-size:12px;
    font-family:ui-monospace,"SF Mono",Menlo,monospace; }
  details.failures span { display:block; color:var(--muted); font-size:12px;
    margin-top:4px; font-family:ui-monospace,monospace; }
  .empty-state { text-align:center; color:var(--muted); padding:64px 0; }
  footer { color:var(--muted); font-size:12px; margin-top:40px;
    border-top:1px solid var(--border); padding-top:16px; }
  footer a { color:var(--accent); text-decoration:none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Weld<span>Suite</span> · Test Dashboard</h1>
    <span class="badge ${overall}">${overallLabel}</span>
  </header>
  <div class="meta">${meta}</div>

  <div class="cards">
    <div class="card"><div class="n">${totals.suites}</div><div class="l">Suites</div></div>
    <div class="card"><div class="n">${totals.tests}</div><div class="l">Tests</div></div>
    <div class="card pass"><div class="n">${totals.passed}</div><div class="l">Passed</div></div>
    <div class="card fail"><div class="n">${totals.failed}</div><div class="l">Failed</div></div>
    <div class="card skip"><div class="n">${totals.skipped}</div><div class="l">Skipped</div></div>
    <div class="card"><div class="n">${fmtDuration(totals.durationMs)}</div><div class="l">Duration</div></div>
  </div>

  ${
    byFramework.length > 0
      ? byFramework.map(([fw, list]) => frameworkSection(fw, list)).join('')
      : `<div class="empty-state">No JUnit reports were found.<br>Run the suites with the junit reporter, then rebuild the dashboard.</div>`
  }

  <footer>
    Aggregated from Vitest, Playwright &amp; Jest JUnit reports.
    <a href="./data.json">data.json</a>
  </footer>
</div>
</body>
</html>`;
}
