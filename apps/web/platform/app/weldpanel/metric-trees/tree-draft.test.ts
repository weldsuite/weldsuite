import { describe, expect, it } from 'vitest';
import { makeMetricTree } from '../explore-fixtures';
import { branchIds, draftsFromNodes, emptyNode, newNodeId, nodesFromDrafts, treeOrder } from './tree-draft';

describe('metric tree drafts', () => {
  it('round-trip saved nodes (a report and an inline event)', () => {
    const tree = makeMetricTree();
    const drafts = draftsFromNodes(tree.nodes);
    expect(drafts[0]).toMatchObject({ id: 'root', source: 'report', reportId: 'wpr_1', parentId: null, relation: null });
    expect(drafts[1]).toMatchObject({ id: 'n2', source: 'inline', event: 'Ordered', math: 'total', relation: 'product' });
    const nodes = nodesFromDrafts(drafts, 'wpp_1');
    expect(nodes?.[0]).toEqual({ id: 'root', label: 'Revenue', parentId: null, relation: null, metric: { reportId: 'wpr_1' } });
    expect(nodes?.[1]?.metric).toEqual({ spec: { kind: 'trends', projectId: 'wpp_1', series: [{ event: 'Ordered', math: 'total', filters: [] }] } });
  });

  it('are not saved while a node has no name or measure', () => {
    const drafts = [{ ...emptyNode('root', null), label: 'Revenue', event: 'Paid' }, emptyNode('n2', 'root')];
    expect(nodesFromDrafts(drafts, 'wpp_1')).toBeNull();
    drafts[1] = { ...drafts[1]!, label: 'Orders', event: 'Ordered', math: 'sum' };
    expect(nodesFromDrafts(drafts, 'wpp_1')).toBeNull();
    drafts[1] = { ...drafts[1]!, property: 'amount' };
    expect(nodesFromDrafts(drafts, 'wpp_1')?.[1]?.metric).toMatchObject({ spec: { series: [{ math: 'sum', property: 'amount' }] } });
  });

  it('pick a fresh id and list nodes depth first', () => {
    const nodes = [
      { id: 'root', parentId: null },
      { id: 'n2', parentId: 'root' },
      { id: 'n3', parentId: 'n2' },
      { id: 'n4', parentId: 'root' },
    ];
    expect(newNodeId(nodes)).toBe('n5');
    expect(treeOrder(nodes).map((n) => `${n.node.id}:${n.depth}`)).toEqual(['root:0', 'n2:1', 'n3:2', 'n4:1']);
    expect([...branchIds(nodes, 'n2')].sort()).toEqual(['n2', 'n3']);
  });
});
