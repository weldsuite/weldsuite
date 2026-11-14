/**
 * `heatmap`: clicks per element and position (from `$autocapture` clicks:
 * `el_selector`, `rel_x`, `rel_y`) and scroll depth (from `$pageleave`), for a
 * page group (a URL pattern) at one device class. The device class comes from
 * the viewport width (./device-class: under 768 mobile, under 1024 tablet).
 */

import type {
  PanelHeatmapElement,
  PanelHeatmapPoint,
  PanelHeatmapResult,
  ParsedHeatmapSpec,
} from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { MOBILE_MAX_WIDTH, TABLET_MAX_WIDTH } from '../device-class';
import type { PanelQueryContext } from './context';
import { eventsScope } from './scope';
import { PanelQueryError, int, likePattern, lit, LIKE_ESCAPE } from './sql';
import { resolveRange, type ResolvedRange } from './time';
import { toNullableText, toNumber, toText, type PanelSqlQuery, type Row } from './rows';
import { toResolvedRange } from './result-range';

const MAX_ELEMENTS = 200;
const MAX_POINTS = 2000;
/** Scroll depth is grouped in tenths. */
const SCROLL_STEP = 10;

/** The URL pattern the spec stands for: the saved page group, or the ad-hoc pattern. */
export function resolveUrlPattern(spec: ParsedHeatmapSpec, ctx: PanelQueryContext): string {
  if (spec.pageGroupId) {
    const pattern = ctx.pageGroups?.[spec.pageGroupId];
    if (!pattern) throw new PanelQueryError('That page group does not exist');
    return pattern;
  }
  if (!spec.urlPattern) throw new PanelQueryError('Choose a page group or a URL pattern');
  return spec.urlPattern;
}

function deviceCondition(deviceClass: ParsedHeatmapSpec['deviceClass']): string {
  if (deviceClass === 'mobile') return `e.viewport_w < ${MOBILE_MAX_WIDTH}`;
  if (deviceClass === 'tablet') return `(e.viewport_w >= ${MOBILE_MAX_WIDTH} AND e.viewport_w < ${TABLET_MAX_WIDTH})`;
  // An unknown width counts as desktop (device-class.ts).
  return `(e.viewport_w IS NULL OR e.viewport_w >= ${TABLET_MAX_WIDTH})`;
}

export function heatmapQueries(spec: ParsedHeatmapSpec, ctx: PanelQueryContext, range: ResolvedRange, pattern: string): PanelSqlQuery[] {
  const scope = eventsScope(ctx, range, range);
  const page = `e.path LIKE ${likePattern(pattern)}${LIKE_ESCAPE}`;
  const device = deviceCondition(spec.deviceClass);
  const click = [`e.name = ${lit('$autocapture')}`, `json_get_str(e.properties, '$action') = 'click'`, 'e.el_selector IS NOT NULL', page, device];

  const pageviewWhere = scope.where(`e.name = ${lit('$pageview')}`, page, device);
  const pageviews: PanelSqlQuery = {
    name: 'heatmap.pageviews',
    sql: `SELECT COUNT(*) AS pageviews FROM ${scope.from} ${pageviewWhere}`,
    columns: ['pageviews'],
  };

  if (spec.type === 'scroll') {
    const bucket = `FLOOR(e.scroll_depth / ${SCROLL_STEP}.0) * ${SCROLL_STEP}`;
    const leaveWhere = scope.where(`e.name = ${lit('$pageleave')}`, 'e.scroll_depth IS NOT NULL', page, device);
    return [
      pageviews,
      {
        name: 'heatmap.scroll',
        sql:
          `SELECT ${bucket} AS depth, COUNT(*) AS leaves FROM ${scope.from} ` +
          `${leaveWhere} GROUP BY ${bucket} ORDER BY ${bucket} ASC`,
        columns: ['depth', 'leaves'],
      },
    ];
  }

  if (spec.type === 'area') {
    return [
      pageviews,
      {
        name: 'heatmap.elements',
        sql:
          `SELECT e.el_selector AS selector, MAX(e.el_text) AS text, COUNT(*) AS clicks, AVG(e.rel_x) AS rel_x, AVG(e.rel_y) AS rel_y ` +
          `FROM ${scope.from} ${scope.where(...click)} GROUP BY e.el_selector ORDER BY COUNT(*) DESC LIMIT ${int(MAX_ELEMENTS, MAX_ELEMENTS)}`,
        columns: ['selector', 'text', 'clicks', 'rel_x', 'rel_y'],
      },
    ];
  }

  const gridX = 'ROUND(e.rel_x * 10) / 10.0';
  const gridY = 'ROUND(e.rel_y * 10) / 10.0';
  return [
    pageviews,
    {
      name: 'heatmap.points',
      sql:
        `SELECT e.el_selector AS selector, ${gridX} AS rel_x, ${gridY} AS rel_y, COUNT(*) AS clicks ` +
        `FROM ${scope.from} ${scope.where(...click, 'e.rel_x IS NOT NULL', 'e.rel_y IS NOT NULL')} ` +
        `GROUP BY e.el_selector, ${gridX}, ${gridY} ORDER BY COUNT(*) DESC LIMIT ${int(MAX_POINTS, MAX_POINTS)}`,
      columns: ['selector', 'rel_x', 'rel_y', 'clicks'],
    },
  ];
}

export async function runHeatmap(
  spec: ParsedHeatmapSpec,
  ctx: PanelQueryContext,
  run: (queries: readonly PanelSqlQuery[]) => Promise<Row[][]>,
): Promise<PanelHeatmapResult> {
  const range = resolveRange(spec.dateRange, spec.timezone, ctx);
  const pattern = resolveUrlPattern(spec, ctx);
  const queries = heatmapQueries(spec, ctx, range, pattern);
  const results = await run(queries);
  const [pageviewRows = [], dataRows = []] = results;
  const pageviews = toNumber(pageviewRows[0]?.pageviews);

  let elements: PanelHeatmapElement[] = [];
  let points: PanelHeatmapPoint[] = [];
  let clicks = 0;
  let scroll: PanelHeatmapResult['scroll'] = { leaves: 0, buckets: [] };

  if (spec.type === 'area') {
    clicks = dataRows.reduce((sum, r) => sum + toNumber(r.clicks), 0);
    elements = dataRows.map((r) => ({
      selector: toText(r.selector),
      text: toNullableText(r.text),
      clicks: toNumber(r.clicks),
      share: clicks > 0 ? toNumber(r.clicks) / clicks : 0,
      relX: clamp01(toNumber(r.rel_x)),
      relY: clamp01(toNumber(r.rel_y)),
    }));
  } else if (spec.type === 'click') {
    points = dataRows.map((r) => ({
      selector: toText(r.selector),
      relX: clamp01(toNumber(r.rel_x)),
      relY: clamp01(toNumber(r.rel_y)),
      count: toNumber(r.clicks),
    }));
    clicks = points.reduce((sum, p) => sum + p.count, 0);
  } else {
    const leaves = dataRows.reduce((sum, r) => sum + toNumber(r.leaves), 0);
    const byDepth = new Map(dataRows.map((r) => [toNumber(r.depth), toNumber(r.leaves)]));
    // Share of leaves that scrolled at least `depth` percent: everything from that tenth down.
    const buckets: { depth: number; reachedShare: number }[] = [];
    for (let depth = 0; depth <= 100; depth += SCROLL_STEP) {
      let reached = 0;
      for (const [bucketDepth, count] of byDepth) if (bucketDepth >= depth) reached += count;
      buckets.push({ depth, reachedShare: leaves > 0 ? reached / leaves : 0 });
    }
    scroll = { leaves, buckets };
  }

  return {
    range: toResolvedRange(range, null),
    type: spec.type,
    deviceClass: spec.deviceClass,
    urlPattern: pattern,
    pageviews,
    clicks,
    elements,
    points,
    scroll,
  };
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}
