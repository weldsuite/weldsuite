/** WeldHR org chart: a collapsible tree built from `managerId`, with search. */

import { useMemo, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, Users } from 'lucide-react';
import { Card } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrOrgChartNode } from '@weldsuite/app-api-client/domains/weldhr';
import { PageLoader } from '@/components/page-loader';
import { useHrOrgChart } from '@/hooks/queries/use-weldhr-queries';
import { DashboardPage, emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { EmployeeAvatar, ErrorBanner, StatusBadge, errorMessage } from '../components/shared';

interface TreeNode extends HrOrgChartNode {
  children: TreeNode[];
}

function buildTree(nodes: HrOrgChartNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  nodes.forEach((n) => byId.set(n.id, { ...n, children: [] }));
  const roots: TreeNode[] = [];
  byId.forEach((node) => {
    const manager = node.managerId ? byId.get(node.managerId) : undefined;
    if (manager) manager.children.push(node);
    else roots.push(node);
  });
  return roots;
}

function nodeMatches(node: TreeNode, query: string): boolean {
  if (!query) return true;
  const haystack = `${node.displayName} ${node.jobTitle ?? ''}`.toLowerCase();
  if (haystack.includes(query)) return true;
  return node.children.some((child) => nodeMatches(child, query));
}

export default function WeldHrOrgChartPage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.orgChart.title') });
  const { data, isLoading, error } = useHrOrgChart();
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const roots = useMemo(() => buildTree(data ?? []), [data]);
  const query = search.trim().toLowerCase();

  function toggle(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <DashboardPage
      title={t('weldhr.orgChart.title')}
      actions={
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('weldhr.orgChart.search')} className="w-64" />
      }
    >
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.orgChart.loadFailed')) : null} />

      {roots.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
          {emptyIcon(Users)}
          <p className="text-sm text-muted-foreground">{t('weldhr.orgChart.empty')}</p>
        </div>
      ) : (
        <Card className="space-y-1 p-4">
          {roots
            .filter((node) => nodeMatches(node, query))
            .map((node) => (
              <OrgNode key={node.id} node={node} depth={0} query={query} collapsed={collapsed} onToggle={toggle} />
            ))}
        </Card>
      )}
    </DashboardPage>
  );
}

function OrgNode({
  node,
  depth,
  query,
  collapsed,
  onToggle,
}: {
  node: TreeNode;
  depth: number;
  query: string;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const t = useTranslations();
  const visibleChildren = node.children.filter((child) => nodeMatches(child, query));
  const isSearching = query.length > 0;
  const isExpanded = isSearching ? true : !collapsed.has(node.id);
  const isMatch = !query || `${node.displayName} ${node.jobTitle ?? ''}`.toLowerCase().includes(query);

  return (
    <div>
      <div className="flex items-center gap-1.5 rounded-md py-1.5 hover:bg-muted/50" style={{ paddingLeft: depth * 24 }}>
        {visibleChildren.length > 0 ? (
          <button type="button" onClick={() => onToggle(node.id)} className="shrink-0 text-muted-foreground">
            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="inline-block w-4 shrink-0" />
        )}
        <Link
          to="/weldhr/employees/$employeeId"
          params={{ employeeId: node.id }}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 hover:bg-muted ${isMatch ? '' : 'opacity-60'}`}
        >
          <EmployeeAvatar name={node.displayName} src={node.avatarUrl} className="h-7 w-7" />
          <span className="min-w-0 truncate text-sm font-medium">{node.displayName}</span>
          {node.jobTitle && <span className="truncate text-xs text-muted-foreground">{node.jobTitle}</span>}
          <StatusBadge group="employee" status={node.status} />
          {node.children.length > 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              {t('weldhr.orgChart.reports', { count: node.children.length })}
            </span>
          )}
        </Link>
      </div>
      {isExpanded &&
        visibleChildren.map((child) => (
          <OrgNode key={child.id} node={child} depth={depth + 1} query={query} collapsed={collapsed} onToggle={onToggle} />
        ))}
    </div>
  );
}
