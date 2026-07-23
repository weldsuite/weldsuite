import { XMLParser } from 'fast-xml-parser';

/**
 * Minimal JUnit XML reader shared by every framework (Vitest, Playwright,
 * Jest via jest-junit). JUnit is the one report format all three can emit,
 * so the aggregator only ever has to understand this single shape.
 */

export interface JUnitFailure {
  /** Fully-qualified test name (`classname › name` when both exist). */
  name: string;
  /** First line(s) of the failure / error message, trimmed. */
  message: string;
}

export interface JUnitSummary {
  /** Suite name as reported by the framework (best-effort). */
  name: string;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  durationMs: number;
  timestamp: string | null;
  failureDetails: JUnitFailure[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Force the repeating nodes to always be arrays so we never have to
  // branch on "single child vs list" while walking the tree.
  isArray: (name) => name === 'testsuite' || name === 'testcase',
});

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Pull a human-readable message out of a `<failure>`/`<error>` node. */
function failureMessage(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (Array.isArray(node)) return failureMessage(node[0]);
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const msg = (obj['@_message'] ?? obj['#text'] ?? '') as string;
    return String(msg).trim();
  }
  return '';
}

function testCaseName(tc: Record<string, unknown>): string {
  const name = String(tc['@_name'] ?? 'unnamed test');
  const classname = tc['@_classname'] ? String(tc['@_classname']) : '';
  return classname && !name.startsWith(classname)
    ? `${classname} › ${name}`
    : name;
}

/**
 * Parse a single JUnit XML document into one rolled-up summary. A document
 * may contain one `<testsuites>` wrapper, multiple `<testsuite>`s, or a
 * lone `<testsuite>` root — all three collapse to one summary here.
 */
export function parseJUnit(xml: string): JUnitSummary {
  const doc = parser.parse(xml) as Record<string, any>;

  const suites: Record<string, any>[] = doc.testsuites?.testsuite
    ? doc.testsuites.testsuite
    : doc.testsuite ?? [];

  const summary: JUnitSummary = {
    name: doc.testsuites?.['@_name'] || suites[0]?.['@_name'] || 'tests',
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    durationMs: 0,
    timestamp: null,
    failureDetails: [],
  };

  for (const suite of suites) {
    const cases: Record<string, any>[] = suite.testcase ?? [];

    // Prefer the suite's own counters; fall back to counting testcases for
    // reporters that omit the aggregate attributes.
    summary.tests += suite['@_tests'] != null ? num(suite['@_tests']) : cases.length;
    summary.failures += num(suite['@_failures']);
    summary.errors += num(suite['@_errors']);
    summary.skipped += num(suite['@_skipped']);
    summary.durationMs += num(suite['@_time']) * 1000;
    summary.timestamp ??= suite['@_timestamp'] ? String(suite['@_timestamp']) : null;

    for (const tc of cases) {
      const failed = tc.failure ?? tc.error;
      if (failed) {
        summary.failureDetails.push({
          name: testCaseName(tc),
          message: failureMessage(failed).split('\n')[0]?.slice(0, 300) ?? '',
        });
      }
    }
  }

  // Some reporters (jest-junit) report 0 failures at the suite level but
  // still emit <failure> nodes — trust the detail count when it's higher.
  if (summary.failureDetails.length > summary.failures + summary.errors) {
    summary.failures = summary.failureDetails.length;
  }

  return summary;
}
