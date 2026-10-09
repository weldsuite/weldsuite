import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useI18n } from '@/lib/i18n/provider';
import { SalesTaxFrame } from '../shared/sales-tax-frame';
import { ExceptionsReport } from './exceptions-report';
import { LiabilityReport } from './liability-report';
import { ProviderReconciliationReport } from './provider-reconciliation-report';
import { SalesSummaryReport } from './sales-summary-report';

type ReportTab = 'liability' | 'salesSummary' | 'exceptions' | 'providerReconciliation';

/** The sales tax reports: liability, sales summary, exceptions and the provider reconciliation. */
export default function SalesTaxReportsPage() {
  const { t } = useI18n();
  const tr = t.weldbooksUs.salesTax.center.reports;
  const [tab, setTab] = useState<ReportTab>('liability');

  return (
    <SalesTaxFrame title={tr.title} subtitle={tr.subtitle}>
      <Tabs value={tab} onValueChange={(value) => setTab(value as ReportTab)}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="liability">{tr.tabs.liability}</TabsTrigger>
          <TabsTrigger value="salesSummary">{tr.tabs.salesSummary}</TabsTrigger>
          <TabsTrigger value="exceptions">{tr.tabs.exceptions}</TabsTrigger>
          <TabsTrigger value="providerReconciliation">{tr.tabs.providerReconciliation}</TabsTrigger>
        </TabsList>
        <TabsContent value="liability">
          <LiabilityReport />
        </TabsContent>
        <TabsContent value="salesSummary">
          <SalesSummaryReport />
        </TabsContent>
        <TabsContent value="exceptions">
          <ExceptionsReport />
        </TabsContent>
        <TabsContent value="providerReconciliation">
          <ProviderReconciliationReport />
        </TabsContent>
      </Tabs>
    </SalesTaxFrame>
  );
}
