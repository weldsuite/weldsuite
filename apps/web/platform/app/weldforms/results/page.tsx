/**
 * Results tab of a form: Summary, Responses and Insights as sub-tabs (the
 * `tab` search parameter). The data refreshes when the realtime sync map
 * invalidates the form's queries and when the window gets focus again.
 */

import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Table2, ShieldOff } from 'lucide-react';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useI18n } from '@/lib/i18n/provider';
import { FormGate, FormTabFrame } from './form-gate';
import { InsightsTab } from './insights-tab';
import { ResponsesTab } from './responses-tab';
import { RESULTS_TABS, parseResultsSearch, type ResultsTab } from './search';
import { SummaryTab } from './summary-tab';
import { useOpenInSheets } from './use-open-in-sheets';

export default function ResultsTabPage() {
  const { formId = '' } = useParams({ strict: false });
  return <FormGate formId={formId}>{(form) => <ResultsContent key={form.id} form={form} />}</FormGate>;
}

function ResultsContent({ form }: Readonly<{ form: FormDetail }>) {
  const { t } = useI18n();
  const tr = t.weldformsResults.results;
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const { tab } = parseResultsSearch(search as Record<string, unknown>);
  const sheets = useOpenInSheets(form);

  if (!form.permissions.readResponses) {
    return (
      <FormTabFrame>
        <EmptyState icon={ShieldOff} title={tr.noAccessTitle} description={tr.noAccessDescription} />
      </FormTabFrame>
    );
  }

  const setTab = (next: ResultsTab) =>
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, tab: next }), replace: true });

  return (
    <FormTabFrame wide>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs value={tab} onValueChange={(value) => setTab(value as ResultsTab)}>
          <TabsList>
            {RESULTS_TABS.map((value) => (
              <TabsTrigger key={value} value={value}>
                {tr.tabs[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {sheets.available && (
          <Button type="button" variant="outline" size="sm" disabled={sheets.pending} onClick={sheets.open}>
            <Table2 className="size-4" />
            {sheets.pending ? tr.openingInSheets : tr.openInSheets}
          </Button>
        )}
      </div>

      {tab === 'summary' && <SummaryTab form={form} />}
      {tab === 'responses' && <ResponsesTab form={form} />}
      {tab === 'insights' && <InsightsTab form={form} />}
    </FormTabFrame>
  );
}
