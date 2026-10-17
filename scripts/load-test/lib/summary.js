/**
 * End-of-run report: a per-endpoint table plus the verdict, printed to the
 * terminal and saved under results/ as Markdown (readable) and JSON (raw k6
 * summary, for comparing runs).
 */

import { PROFILE, RUN_ID, SCALE, WELD_ENV, WRITE_RATIO } from './config.js';

function fmtMs(n) {
  if (n === undefined) return '-';
  return n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}
const fmtPct = (n) => (n === undefined ? '-' : `${(n * 100).toFixed(2)}%`);

function parseDuration(text) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(text || '').trim());
  if (!match) return undefined;
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600 }[match[2]];
  return Number(match[1]) * unit;
}

function endpointRows(metrics, value) {
  return Object.keys(metrics)
    .filter((name) => name.startsWith('ep_') && !name.endsWith('_errors') && !name.includes('{'))
    .map((name) => ({
      endpoint: name.slice(3),
      count: value(name, 'count') || 0,
      med: value(name, 'med'),
      p95: value(name, 'p(95)'),
      p99: value(name, 'p(99)'),
      max: value(name, 'max'),
      errors: value(`${name}_errors`, 'rate'),
    }))
    .filter((row) => row.count > 0)
    .sort((a, b) => b.count - a.count);
}

function thresholdResults(metrics) {
  const results = [];
  for (const [name, metric] of Object.entries(metrics)) {
    for (const [rule, result] of Object.entries(metric.thresholds || {})) {
      results.push({ ok: result.ok, line: `- ${result.ok ? 'PASS' : 'FAIL'}  \`${name}\` ${rule}` });
    }
  }
  return results;
}

/** Where the breakpoint run stopped, from the ramp it was on (start → 1000 × SCALE). */
function breakpointLine(elapsed) {
  const planned = parseDuration(__ENV.DURATION || '15m');
  const target = 1000 * SCALE;
  const start = 5 * SCALE;
  if (planned && elapsed < planned - 5) {
    const reached = start + (target - start) * Math.min(elapsed / planned, 1);
    return `- **Breaking point:** limits tripped after ${elapsed.toFixed(0)}s, at roughly ${Math.round(reached)} iterations/s.`;
  }
  return `- **No breaking point found** up to ${Math.round(target)} iterations/s. Run again with a higher SCALE.`;
}

export function buildReport(api, data) {
  const metrics = data.metrics;
  const value = (name, field) => (metrics[name] && metrics[name].values ? metrics[name].values[field] : undefined);
  const elapsed = data.state.testRunDurationMs / 1000;
  const rows = endpointRows(metrics, value);
  const thresholds = thresholdResults(metrics);
  const totalRequests = rows.reduce((sum, row) => sum + row.count, 0);
  const rateLimited = value('rate_limited', 'count') || 0;
  const failedMetric = `http_req_failed{api:${api}}`;

  const lines = [
    `# WeldSuite pressure test: ${api} / ${PROFILE}`,
    '',
    `Run ${RUN_ID} against **${WELD_ENV}**, scale ${SCALE}, write share ${Math.round(WRITE_RATIO * 100)}%.`,
    '',
    `- Duration: ${elapsed.toFixed(0)}s`,
    `- Peak virtual users: ${value('vus_max', 'value') ?? '-'}`,
    `- Requests: ${totalRequests} (${(totalRequests / Math.max(elapsed, 1)).toFixed(1)} req/s average)`,
    `- Failed requests: ${fmtPct(value(failedMetric, 'rate'))}`,
  ];
  if (rateLimited) lines.push(`- Rate limited (429): ${rateLimited}`);
  lines.push(`- Checks passed: ${fmtPct(value('checks', 'rate'))}`);
  if (PROFILE === 'breakpoint') lines.push(breakpointLine(elapsed));

  lines.push(
    '',
    `## Verdict: ${thresholds.every((t) => t.ok) ? 'PASS' : 'FAIL'}`,
    '',
    ...thresholds.map((t) => t.line),
    '',
    '## Per endpoint',
    '',
    '| Endpoint | Requests | Median | p95 | p99 | Max | Errors |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(
      (row) =>
        `| ${row.endpoint} | ${row.count} | ${fmtMs(row.med)} | ${fmtMs(row.p95)} | ${fmtMs(row.p99)} | ${fmtMs(row.max)} | ${fmtPct(row.errors)} |`,
    ),
    '',
  );
  return lines.join('\n');
}

export function summaryOutputs(api, data) {
  const report = buildReport(api, data);
  const dir = __ENV.RESULTS_DIR || 'results';
  const base = `${dir}/${RUN_ID}-${api}-${PROFILE}`;
  return {
    stdout: `\n${report}\nReport saved to ${base}.md\n`,
    [`${base}.md`]: report,
    [`${base}.json`]: JSON.stringify(data, null, 2),
  };
}
