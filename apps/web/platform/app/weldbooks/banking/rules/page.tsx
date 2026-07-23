import { useState } from 'react';
import { Edit, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import {
  EmptyStateIllustration,
  type ColumnDef,
  type FilterConfig,
} from '@/components/entity-list';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import {
  useReconciliationRules,
  useDeleteReconciliationRule,
  useAccountingAccounts,
} from '@/hooks/queries/use-accounting-queries';
import { ReconciliationRuleFormDialog } from '@/components/accounting/reconciliation-rule-form-dialog';
import type { ReconciliationRule } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';

function summarizeConditions(rule: ReconciliationRule, condSummary: string, condSummaryPlural: string): string {
  const count = rule.conditions?.length ?? 0;
  const mode = rule.matchMode === 'any' ? 'any' : 'all';
  const template = count === 1 ? condSummary : condSummaryPlural;
  return template.replace('{count}', String(count)).replace('{mode}', mode);
}

function summarizeActions(
  rule: ReconciliationRule,
  accountLookup: Map<string, { code: string; name: string }>,
): string {
  const parts: string[] = [];
  if (rule.actions?.categoryAccountId) {
    const a = accountLookup.get(rule.actions.categoryAccountId);
    parts.push(`→ ${a ? `${a.code} ${a.name}` : 'account'}`);
  }
  if (rule.actions?.taxRateId) parts.push('tax');
  if (rule.actions?.contactId) parts.push('contact');
  if (rule.actions?.description) parts.push('description');
  return parts.length ? parts.join(' · ') : '—';
}

function formatDate(v: string | null | undefined, neverLabel: string): string {
  if (!v) return neverLabel;
  try {
    return new Intl.DateTimeFormat('nl-NL', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(v));
  } catch {
    return v;
  }
}

export default function ReconciliationRulesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editRule, setEditRule] = useState<ReconciliationRule | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const { t } = useI18n();
  const tbp = t.accounting.bankingPages;

  const { data: rulesRes, isLoading } = useReconciliationRules();
  const { data: accountsRes } = useAccountingAccounts();
  const deleteMutation = useDeleteReconciliationRule();

  const rules = (rulesRes?.data ?? []) as ReconciliationRule[];
  const accountLookup = new Map(
    ((accountsRes?.data ?? []) as any[]).map((a) => [a.id, { code: a.code, name: a.name }]),
  );

  const filterConfigs: FilterConfig[] = [];

  const columns: ColumnDef<ReconciliationRule>[] = [
    {
      id: 'name',
      header: tbp.columns_rules.name,
      width: 'flex-1',
      render: (r) => <span className="font-medium">{r.name}</span>,
    },
    {
      id: 'priority',
      header: tbp.columns_rules.priority,
      width: 'w-[90px]',
      render: (r) => <span className="tabular-nums">{r.priority}</span>,
    },
    {
      id: 'conditions',
      header: tbp.columns_rules.conditions,
      width: 'w-[200px]',
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {summarizeConditions(r, tbp.conditionsSummary, tbp.conditionsSummaryPlural)}
        </span>
      ),
    },
    {
      id: 'actions',
      header: tbp.columns_rules.actions,
      width: 'w-[200px]',
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {summarizeActions(r, accountLookup)}
        </span>
      ),
    },
    {
      id: 'matches',
      header: tbp.columns_rules.matches,
      width: 'w-[90px]',
      render: (r) => <span className="tabular-nums">{r.matchCount ?? 0}</span>,
    },
    {
      id: 'lastMatched',
      header: tbp.columns_rules.lastMatched,
      width: 'w-[130px]',
      render: (r) => (
        <span className="text-sm text-muted-foreground">
          {formatDate(r.lastMatchedAt, tbp.ruleNever)}
        </span>
      ),
    },
    {
      id: 'status',
      header: tbp.columns_rules.status,
      width: 'w-[100px]',
      render: (r) =>
        r.isActive ? (
          <Badge variant="default">{tbp.ruleStatusActive}</Badge>
        ) : (
          <Badge variant="outline">{tbp.ruleStatusInactive}</Badge>
        ),
    },
    {
      id: 'rowActions',
      header: '',
      width: 'w-[80px]',
      render: (r) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={(e) => {
              e.stopPropagation();
              setEditRule(r);
            }}
            aria-label={tbp.ruleActionEdit}
          >
            <Edit className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 text-red-600 hover:text-red-600 dark:text-red-400"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteId(r.id);
            }}
            aria-label={tbp.ruleActionDelete}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <WeldbooksEntityList<ReconciliationRule>
        items={rules}
        isLoading={isLoading}
        columns={columns}
        filters={filterConfigs}
        searchFields={['name']}
        createButton={{ label: tbp.newRule, onClick: () => setCreateOpen(true) }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <Wand2 className="h-10 w-10 text-muted-foreground/60" strokeWidth={1.5} />
            </EmptyStateIllustration>
          ),
          title: tbp.noRulesTitle,
          description: tbp.noRulesTitle,
          action: {
            label: tbp.createFirstRule,
            onClick: () => setCreateOpen(true),
          },
        }}
      />

      <ReconciliationRuleFormDialog open={createOpen} onOpenChange={setCreateOpen} />
      <ReconciliationRuleFormDialog
        open={!!editRule}
        onOpenChange={(o) => !o && setEditRule(null)}
        rule={editRule}
      />

      <AlertDialog open={!!deleteId} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tbp.deleteRuleTitle}</AlertDialogTitle>
            <AlertDialogDescription>{tbp.deleteRuleDesc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tbp.cancel}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteId)
                  deleteMutation.mutate(deleteId, {
                    onSuccess: () => setDeleteId(null),
                  });
              }}
            >
              {tbp.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
