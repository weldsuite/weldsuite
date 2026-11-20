/**
 * WeldDesk → Reports → BI connector: the OData feed Power BI and Excel read
 * (TASK-1235). The feed itself is `/v1/odata` on the public API.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { BI_TABLES, feedUrl } from './bi-tables';

function Steps({ steps }: Readonly<{ steps: readonly string[] }>) {
  return (
    <ol className="list-decimal space-y-1.5 pl-5 text-sm">
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

export default function DeskBiConnectorPage() {
  const { t } = useI18n();
  const tb = t.deskBi;
  const url = feedUrl();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: t.helpdesk.reports.title, href: '/welddesk/reports' },
    { label: tb.title },
  ]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(tb.feed.copyFailed);
    }
  };

  return (
    <DashboardPage title={tb.title} description={tb.description} className="max-w-4xl">
      <SectionCard title={tb.feed.title} description={tb.feed.description}>
        <div className="flex items-stretch gap-2">
          {/* A focusable, selectable value that wraps instead of being cut off. */}
          <div
            role="textbox"
            aria-readonly="true"
            aria-label={tb.feed.label}
            tabIndex={0}
            className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-[13px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {url}
          </div>
          <Button type="button" variant="outline" className="h-auto shrink-0 gap-2 shadow-none" onClick={copy}>
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
            {copied ? tb.feed.copied : tb.feed.copy}
          </Button>
        </div>
      </SectionCard>

      <SectionCard title={tb.key.title} description={tb.key.description}>
        <Button asChild variant="outline" className="shadow-none">
          <Link href="/settings/api-keys">
            <KeyRound className="h-4 w-4" />
            {tb.key.action}
          </Link>
        </Button>
      </SectionCard>

      <SectionCard title={tb.tables.title} description={tb.tables.description}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-48">{tb.tables.name}</TableHead>
              <TableHead>{tb.tables.contains}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {BI_TABLES.map((name) => (
              <TableRow key={name}>
                <TableCell className="font-mono text-[13px]">{name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{tb.tables.items[name]}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SectionCard>

      <div className="grid gap-6 md:grid-cols-2">
        <SectionCard title={tb.powerBi.title}>
          <Steps steps={tb.powerBi.steps} />
        </SectionCard>
        <SectionCard title={tb.excel.title}>
          <Steps steps={tb.excel.steps} />
        </SectionCard>
      </div>

      <InfoBanner variant="tip" title={tb.refresh.title}>
        {tb.refresh.body}
      </InfoBanner>
    </DashboardPage>
  );
}
