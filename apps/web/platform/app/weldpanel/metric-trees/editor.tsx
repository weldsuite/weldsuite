/**
 * Create or edit a metric tree: a name, who can see it, and the nodes. The
 * root is the key metric; every other node drives a parent (adds up to it,
 * multiplies into it, or only influences it) and is measured by a saved
 * insight or by an event with a measure.
 */

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { PANEL_MAX_METRIC_TREE_NODES, PANEL_METRIC_TREE_RELATIONS, type PanelMetricTreeDto, type PanelMetricTreeRelation } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import { PANEL_VISIBILITIES, type PanelVisibility } from '@weldsuite/app-api-client/schemas/weldpanel-objects';
import { PANEL_TREND_MATHS, type PanelTrendMath } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useCreateWeldPanelMetricTree, useUpdateWeldPanelMetricTree } from '@/hooks/queries/use-weldpanel-analysis-queries';
import { useWeldPanelReports } from '@/hooks/queries/use-weldpanel-queries';
import { useI18n } from '@/lib/i18n/provider';
import { LabeledField } from '../components/labeled-field';
import { EventPicker, PropertyPicker } from '../components/pickers';
import { needsProperty } from '../lib/builders';
import { branchIds, draftsFromNodes, emptyNode, newNodeId, nodesFromDrafts, treeOrder, type NodeDraft } from './tree-draft';

const NONE = '__none__';
/** `unique_groups` needs a group type the editor does not ask for. */
const MATHS = PANEL_TREND_MATHS.filter((m) => m !== 'unique_groups');

interface MetricTreeEditorProps {
  projectId: string;
  /** The tree being edited; null creates one. */
  tree: PanelMetricTreeDto | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (tree: PanelMetricTreeDto) => void;
}

function NodeRow({
  node,
  depth,
  projectId,
  reports,
  onChange,
  onAddChild,
  onRemove,
  canAddChild,
  index,
}: Readonly<{
  node: NodeDraft;
  depth: number;
  projectId: string;
  reports: { id: string; name: string }[];
  onChange: (patch: Partial<NodeDraft>) => void;
  onAddChild: () => void;
  onRemove: (() => void) | null;
  canAddChild: boolean;
  index: number;
}>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.metricTrees.editor;
  const ti = t.weldpanel.analytics.insights;
  const isRoot = node.parentId === null;
  const name = node.label || format(tx.untitled, { n: index + 1 });
  const id = `weldpanel-tree-node-${node.id}`;

  return (
    <li className="grid gap-3 rounded-lg border p-3" style={{ marginLeft: `${Math.min(depth, 4) * 1.25}rem` }} aria-label={name}>
      <div className="flex items-start gap-2">
        <div className="grid min-w-0 flex-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <LabeledField label={isRoot ? tx.root : tx.label} htmlFor={`${id}-label`}>
            <Input id={`${id}-label`} value={node.label} onChange={(event) => onChange({ label: event.target.value })} maxLength={100} autoComplete="off" />
          </LabeledField>
          {!isRoot && (
            <LabeledField label={tx.relation} htmlFor={`${id}-relation`}>
              <Select value={node.relation ?? NONE} onValueChange={(next) => onChange({ relation: next === NONE ? null : (next as PanelMetricTreeRelation) })}>
                <SelectTrigger id={`${id}-relation`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PANEL_METRIC_TREE_RELATIONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {tx.relations[r]}
                    </SelectItem>
                  ))}
                  <SelectItem value={NONE}>{tx.relations.none}</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
          )}
          <LabeledField label={tx.source} htmlFor={`${id}-source`}>
            <Select value={node.source} onValueChange={(next) => onChange({ source: next as NodeDraft['source'] })}>
              <SelectTrigger id={`${id}-source`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inline">{tx.sources.inline}</SelectItem>
                <SelectItem value="report">{tx.sources.report}</SelectItem>
              </SelectContent>
            </Select>
          </LabeledField>
          {node.source === 'report' ? (
            <LabeledField label={tx.report} htmlFor={`${id}-report`}>
              {reports.length === 0 ? (
                <p className="text-sm text-muted-foreground">{tx.noReports}</p>
              ) : (
                <Select value={node.reportId} onValueChange={(reportId) => onChange({ reportId, label: node.label || (reports.find((r) => r.id === reportId)?.name ?? '') })}>
                  <SelectTrigger id={`${id}-report`}>
                    <SelectValue placeholder={tx.reportPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {reports.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </LabeledField>
          ) : (
            <>
              <LabeledField label={tx.event} htmlFor={`${id}-event`}>
                <EventPicker id={`${id}-event`} projectId={projectId} value={node.event} onChange={(event) => onChange({ event })} ariaLabel={`${tx.event} ${name}`} />
              </LabeledField>
              <LabeledField label={tx.math} htmlFor={`${id}-math`}>
                <Select value={node.math} onValueChange={(next) => onChange({ math: next as PanelTrendMath })}>
                  <SelectTrigger id={`${id}-math`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MATHS.map((m) => (
                      <SelectItem key={m} value={m}>
                        {ti.measures[m as Exclude<PanelTrendMath, 'unique_groups'>]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </LabeledField>
              {needsProperty(node.math) && (
                <LabeledField label={ti.measureProperty} htmlFor={`${id}-property`}>
                  <PropertyPicker id={`${id}-property`} projectId={projectId} value={node.property} onChange={(property) => onChange({ property })} includeComputed />
                </LabeledField>
              )}
            </>
          )}
        </div>
        {onRemove && (
          <Button type="button" variant="ghost" size="icon" className="mt-6 size-8 shrink-0" aria-label={format(tx.remove, { name })} onClick={onRemove}>
            <X />
          </Button>
        )}
      </div>
      {canAddChild && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={onAddChild}>
            <Plus />
            {tx.addChild}
          </Button>
        </div>
      )}
    </li>
  );
}

export function MetricTreeEditor({ projectId, tree, open, onOpenChange, onSaved }: Readonly<MetricTreeEditorProps>) {
  const { t, format } = useI18n();
  const tx = t.weldpanel.explore.metricTrees.editor;
  const tc = t.weldpanel.analytics.common;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<PanelVisibility>('private');
  const [nodes, setNodes] = useState<NodeDraft[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useCreateWeldPanelMetricTree();
  const update = useUpdateWeldPanelMetricTree(tree?.id ?? '');
  const busy = create.isPending || update.isPending;
  const { data: reports } = useWeldPanelReports({ projectId, kind: 'trends' }, open);

  // Every opening starts from the tree being edited, or a root alone.
  useEffect(() => {
    if (!open) return;
    setProblem(null);
    setName(tree?.name ?? '');
    setDescription(tree?.description ?? '');
    setVisibility(tree?.visibility ?? 'private');
    setNodes(tree ? draftsFromNodes(tree.nodes) : [emptyNode('root', null)]);
  }, [open, tree]);

  const ordered = treeOrder(nodes);
  const full = nodes.length >= PANEL_MAX_METRIC_TREE_NODES;
  const changeNode = (id: string, patch: Partial<NodeDraft>) => setNodes((list) => list.map((n) => (n.id === id ? { ...n, ...patch } : n)));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (name.trim() === '') return setProblem(t.weldpanel.analytics.save.nameRequired);
    const stored = nodesFromDrafts(nodes, projectId);
    if (!stored) return setProblem(tx.incomplete);
    setProblem(null);
    const body = { name: name.trim(), description: description.trim() === '' ? null : description.trim(), visibility, nodes: stored };
    try {
      const saved = tree ? await update.mutateAsync(body) : await create.mutateAsync({ projectId, ...body });
      toast.success(tx.saved);
      onOpenChange(false);
      onSaved?.(saved);
    } catch {
      toast.error(tx.saveFailed);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{tree ? tx.editTitle : tx.createTitle}</DialogTitle>
          <DialogDescription>{t.weldpanel.explore.metricTrees.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void submit(event)} noValidate className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <LabeledField label={tc.name} htmlFor="weldpanel-tree-name">
              <Input id="weldpanel-tree-name" value={name} onChange={(event) => setName(event.target.value)} placeholder={tx.namePlaceholder} maxLength={255} autoComplete="off" />
            </LabeledField>
            <LabeledField label={tc.visibility} htmlFor="weldpanel-tree-visibility" hint={visibility === 'private' ? tc.privateHint : tc.workspaceHint}>
              <Select value={visibility} onValueChange={(next) => setVisibility(next as PanelVisibility)}>
                <SelectTrigger id="weldpanel-tree-visibility">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PANEL_VISIBILITIES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v === 'private' ? tc.private : tc.workspace}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
          </div>
          <LabeledField label={`${tc.description} (${tc.optional})`} htmlFor="weldpanel-tree-description">
            <Textarea id="weldpanel-tree-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={2} maxLength={2000} />
          </LabeledField>

          <div className="grid gap-2">
            <p className="text-sm font-medium">{tx.metrics}</p>
            <ol className="grid gap-3">
              {ordered.map(({ node, depth }, index) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  depth={depth}
                  index={index}
                  projectId={projectId}
                  reports={reports ?? []}
                  canAddChild={!full}
                  onChange={(patch) => changeNode(node.id, patch)}
                  onAddChild={() => setNodes((list) => [...list, emptyNode(newNodeId(list), node.id)])}
                  onRemove={
                    node.parentId === null
                      ? null
                      : () =>
                          setNodes((list) => {
                            const gone = branchIds(list, node.id);
                            return list.filter((n) => !gone.has(n.id));
                          })
                  }
                />
              ))}
            </ol>
            {full && <p className="text-xs text-muted-foreground">{format(tx.tooMany, { count: PANEL_MAX_METRIC_TREE_NODES })}</p>}
          </div>

          {problem && <InfoBanner variant="danger">{problem}</InfoBanner>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {tc.cancel}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? tc.saving : tc.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
