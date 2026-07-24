import { Link } from '@tanstack/react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { BarChart3, FileText, Scale, Clock, ArrowDownUp, BookOpen } from 'lucide-react';
import { useI18n } from '@/lib/i18n/provider';

export default function ReportsIndexPage() {
  const { t } = useI18n();
  const tr = t.accounting.reports;

  const reports = [
    {
      title: tr.profitLoss,
      description: tr.profitLossDesc,
      href: '/weldbooks/reports/profit-loss',
      icon: BarChart3,
    },
    {
      title: tr.balanceSheet,
      description: tr.balanceSheetDesc,
      href: '/weldbooks/reports/balance-sheet',
      icon: Scale,
    },
    {
      title: tr.trialBalance,
      description: tr.trialBalanceDesc,
      href: '/weldbooks/reports/trial-balance',
      icon: FileText,
    },
    {
      title: tr.agedReceivables,
      description: tr.agedReceivablesDesc,
      href: '/weldbooks/reports/aged-receivables',
      icon: Clock,
    },
    {
      title: tr.agedPayables,
      description: tr.agedPayablesDesc,
      href: '/weldbooks/reports/aged-payables',
      icon: Clock,
    },
    {
      title: tr.cashFlow,
      description: tr.cashFlowDesc,
      href: '/weldbooks/reports/cash-flow',
      icon: ArrowDownUp,
    },
    {
      title: tr.generalLedger,
      description: tr.generalLedgerDesc,
      href: '/weldbooks/reports/general-ledger',
      icon: BookOpen,
    },
  ] as const;

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">{tr.title}</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {reports.map((report) => {
          const Icon = report.icon;
          return (
            <Link key={report.href} to={report.href}>
              <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                <CardHeader className="flex flex-row items-center gap-3 pb-2">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                  <CardTitle className="text-base">{report.title}</CardTitle>
                </CardHeader>
                <CardContent>
                  <p className="text-sm text-muted-foreground">{report.description}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
