import { useState } from 'react';
import { EllipsisVertical, Pencil, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { WeldbooksEntityList } from '@/components/accounting/weldbooks-entity-list';
import { RowDate, RowText, RowTitle, StatusChip } from '@/components/accounting/weldbooks-row-cells';
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
import type { Account, ReconciliationRule } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

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
    const accountLabel = a ? `${a.code} ${a.name}` : 'account';
    parts.push(`→ ${accountLabel}`);
  }
  if (rule.actions?.taxRateId) parts.push('tax');
  if (rule.actions?.contactId) parts.push('contact');
  if (rule.actions?.description) parts.push('description');
  return parts.length ? parts.join(' · ') : '';
}

export default function ReconciliationRulesPage() {
  const [createOpen, setCreateOpen] = useState(false);
  const [editRule, setEditRule] = useState<ReconciliationRule | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const { t } = useI18n();
  const { formatDateTime } = useWeldbooksFormat();
  const tbp = t.accounting.bankingPages;

  const { data: rulesRes, isLoading } = useReconciliationRules();
  const { data: accountsRes } = useAccountingAccounts();
  const deleteMutation = useDeleteReconciliationRule();

  const rules = (rulesRes?.data ?? []) as ReconciliationRule[];
  const accountLookup = new Map(
    ((accountsRes?.data ?? []) as Account[]).map((a) => [a.id, { code: a.code, name: a.name }]),
  );

  const filterConfigs: FilterConfig[] = [];

  const columns: ColumnDef<ReconciliationRule>[] = [
    {
      id: 'name',
      header: tbp.columns_rules.name,
      width: 'min-w-[200px] flex-1 gap-2',
      render: (r) => <RowTitle>{r.name}</RowTitle>,
    },
    {
      id: 'priority',
      header: tbp.columns_rules.priority,
      width: 'w-[90px]',
      render: (r) => <RowText className="tabular-nums">{r.priority}</RowText>,
    },
    {
      id: 'conditions',
      header: tbp.columns_rules.conditions,
      width: 'w-[200px]',
      render: (r) => (
        <RowText>{summarizeConditions(r, tbp.conditionsSummary, tbp.conditionsSummaryPlural)}</RowText>
      ),
    },
    {
      id: 'actions',
      header: tbp.columns_rules.actions,
      width: 'w-[200px]',
      render: (r) => <RowText>{summarizeActions(r, accountLookup)}</RowText>,
    },
    {
      id: 'matches',
      header: tbp.columns_rules.matches,
      width: 'w-[90px]',
      render: (r) => <RowText className="tabular-nums">{r.matchCount ?? 0}</RowText>,
    },
    {
      id: 'lastMatched',
      header: tbp.columns_rules.lastMatched,
      width: 'w-[130px]',
      render: (r) => <RowDate>{formatDateTime(r.lastMatchedAt, tbp.ruleNever)}</RowDate>,
    },
    {
      id: 'status',
      header: tbp.columns_rules.status,
      width: 'w-[110px]',
      render: (r) => (
        <StatusChip status={r.isActive ? 'active' : 'inactive'}>
          {r.isActive ? tbp.ruleStatusActive : tbp.ruleStatusInactive}
        </StatusChip>
      ),
    },
  ];

  const renderRowMenu = (r: ReconciliationRule) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent"
        >
          <EllipsisVertical className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setEditRule(r)}>
          <Pencil className="h-3.5 w-3.5 mr-0.5" />
          {tbp.ruleActionEdit}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-red-600 focus:bg-red-50 focus:text-red-600 dark:focus:bg-red-950"
          onClick={() => setDeleteId(r.id)}
        >
          <Trash2 className="h-3.5 w-3.5 mr-0.5 text-red-600" />
          {tbp.ruleActionDelete}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <WeldbooksEntityList<ReconciliationRule>
        items={rules}
        isLoading={isLoading}
        columns={columns}
        renderRowMenu={renderRowMenu}
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
          description: tbp.noRulesDescription,
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
