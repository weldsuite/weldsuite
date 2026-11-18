/**
 * The metric tree editor's draft: nodes as form rows (a saved insight or an
 * inline event with a measure) and the conversions to and from the stored
 * nodes, plus the order nodes are shown in (depth first, root on top).
 */

import {
  PANEL_MAX_METRIC_TREE_NODES,
  panelMetricTreeProblem,
  type PanelMetricTreeNode,
  type PanelMetricTreeRelation,
  type ParsedPanelMetricTreeNode,
} from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelTrendMath } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { needsProperty } from '../lib/builders';

export interface NodeDraft {
  id: string;
  label: string;
  parentId: string | null;
  relation: PanelMetricTreeRelation | null;
  source: 'report' | 'inline';
  reportId: string;
  event: string;
  math: PanelTrendMath;
  property: string;
}

export function newNodeId(nodes: readonly { id: string }[]): string {
  let n = nodes.length + 1;
  while (nodes.some((node) => node.id === `n${n}`)) n += 1;
  return `n${n}`;
}

export function emptyNode(id: string, parentId: string | null): NodeDraft {
  return { id, label: '', parentId, relation: parentId === null ? null : 'sum', source: 'inline', reportId: '', event: '', math: 'total', property: '' };
}

export function draftsFromNodes(nodes: readonly ParsedPanelMetricTreeNode[]): NodeDraft[] {
  return nodes.map((node) => {
    const base = { id: node.id, label: node.label, parentId: node.parentId, relation: node.relation };
    if ('reportId' in node.metric) return { ...base, source: 'report', reportId: node.metric.reportId, event: '', math: 'total', property: '' };
    const series = node.metric.spec.series[0];
    return { ...base, source: 'inline', reportId: '', event: series?.event ?? '', math: series?.math ?? 'total', property: series?.property ?? '' };
  });
}

export function isNodeComplete(node: NodeDraft): boolean {
  if (node.label.trim() === '') return false;
  if (node.source === 'report') return node.reportId !== '';
  return node.event !== '' && (!needsProperty(node.math) || node.property !== '') && node.math !== 'unique_groups';
}

/** The stored nodes, or null while a node is incomplete or the tree is not a tree. */
export function nodesFromDrafts(drafts: readonly NodeDraft[], projectId: string): PanelMetricTreeNode[] | null {
  if (drafts.length === 0 || drafts.length > PANEL_MAX_METRIC_TREE_NODES || !drafts.every(isNodeComplete)) return null;
  const nodes: PanelMetricTreeNode[] = drafts.map((d) => ({
    id: d.id,
    label: d.label.trim(),
    parentId: d.parentId,
    relation: d.parentId === null ? null : d.relation,
    metric:
      d.source === 'report'
        ? { reportId: d.reportId }
        : {
            spec: {
              kind: 'trends',
              projectId,
              series: [{ event: d.event, math: d.math, ...(needsProperty(d.math) ? { property: d.property } : {}), filters: [] }],
            },
          },
  }));
  return panelMetricTreeProblem(nodes) === null ? nodes : null;
}

/** Nodes depth first from the root, each with its depth; nodes whose parent is missing come last at depth 0. */
export function treeOrder<T extends { id: string; parentId: string | null }>(nodes: readonly T[]): { node: T; depth: number }[] {
  const children = new Map<string | null, T[]>();
  for (const node of nodes) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node]);
  const out: { node: T; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const node of children.get(parentId) ?? []) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push({ node, depth });
      walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  for (const node of nodes) if (!seen.has(node.id)) out.push({ node, depth: 0 });
  return out;
}

/** A node and everything under it (to remove a branch). */
export function branchIds(nodes: readonly { id: string; parentId: string | null }[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of nodes) {
      if (node.parentId !== null && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function metricTreeHref(id: string): string {
  return `/weldpanel/metric-trees/${encodeURIComponent(id)}`;
}
