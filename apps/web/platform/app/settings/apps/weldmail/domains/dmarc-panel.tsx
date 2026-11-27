'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { ChevronDown, Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@weldsuite/ui/components/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { useMailDmarcSummary, useMarkDmarcSource } from '@/hooks/queries/use-mail-queries';
import type { TranslationNamespaces } from '@/lib/i18n';
import type {
  DmarcBlocker,
  DmarcSource,
  DmarcSummary,
  MailDomainRow,
} from '@weldsuite/app-api-client/domains/mail-domains';
import type { DmarcPeriodDays } from '@weldsuite/app-api-client/schemas/mail-domains';

type DomainLabels = TranslationNamespaces['settings']['weldmail']['domains'];
type DmarcLabels = DomainLabels['dmarc'];

const PERIODS: DmarcPeriodDays[] = [7, 30, 90];

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match,
  );
}

/** Per mille as a percentage with one decimal: 987 -> "98.7". */
function percentOfPermille(permille: number): string {
  return (permille / 10).toFixed(1);
}

function passPercent(passed: number, messages: number): string {
  return messages > 0 ? percentOfPermille(Math.round((passed * 1000) / messages)) : '0.0';
}

function blockerText(blocker: DmarcBlocker, labels: DmarcLabels): string {
  const t = labels.advice.blockers;
  switch (blocker.code) {
    case 'recordProblem': {
      const states = labels.advice.states;
      const state =
        blocker.state in states ? states[blocker.state as keyof typeof states] : blocker.state;
      return fill(t.recordProblem, { state });
    }
    case 'noReports':
      return t.noReports;
    case 'tooFewDays':
      return fill(t.tooFewDays, { have: blocker.have, need: blocker.need });
    case 'tooFewReporters':
      return fill(t.tooFewReporters, {
        have: blocker.have,
        need: blocker.need,
      });
    case 'passRate':
      return fill(t.passRate, {
        percent: percentOfPermille(blocker.permille),
        need: percentOfPermille(blocker.need),
      });
    case 'weldsuiteFailing':
      return fill(t.weldsuiteFailing, {
        percent: percentOfPermille(blocker.permille),
        need: percentOfPermille(blocker.need),
      });
    case 'failingSource':
      return fill(t.failingSource, {
        name: blocker.name,
        share: percentOfPermille(blocker.sharePermille),
        percent: percentOfPermille(blocker.passPermille),
      });
    case 'tooSoon':
      return fill(t.tooSoon, { days: blocker.days, need: blocker.need });
  }
}

function sourceName(source: { kind: DmarcSource['kind']; name: string }, labels: DmarcLabels) {
  return source.kind === 'weldsuite' ? labels.sources.weldsuite : source.name;
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

/**
 * The DMARC reports of one verified mail domain (ADR MAIL-015). Collapsed by
 * default; the summary is only fetched once it is opened.
 */
export function DmarcPanel({
  domain,
  labels,
}: Readonly<{ domain: MailDomainRow; labels: DomainLabels }>) {
  const [open, setOpen] = useState(false);
  const dl = labels.dmarc;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border"
      data-testid={`dmarc-panel-${domain.domainName}`}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium"
        >
          {dl.title}
          <ChevronDown
            className={`size-4 shrink-0 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open && <DmarcPanelBody domain={domain} labels={labels} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function DmarcPanelBody({
  domain,
  labels,
}: Readonly<{ domain: MailDomainRow; labels: DomainLabels }>) {
  const dl = labels.dmarc;
  const [days, setDays] = useState<DmarcPeriodDays>(30);
  const { data, isLoading, isError } = useMailDmarcSummary(domain.id, days);
  const summary = data?.data;

  return (
    <div className="space-y-4 border-t p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-sm text-muted-foreground">{dl.description}</p>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v) as DmarcPeriodDays)}>
          <SelectTrigger className="w-full sm:w-[180px]" aria-label={dl.period}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PERIODS.map((p) => (
              <SelectItem key={p} value={String(p)}>
                {fill(dl.periodDays, { days: p })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading && <PageLoader fullScreen={false} />}
      {isError && <InfoBanner variant="danger">{dl.loadFailed}</InfoBanner>}
      {summary && <DmarcSummaryView domain={domain} summary={summary} labels={labels} />}

      <p className="text-xs text-muted-foreground">{dl.privacy}</p>
    </div>
  );
}

function DmarcSummaryView({
  domain,
  summary,
  labels,
}: Readonly<{
  domain: MailDomainRow;
  summary: DmarcSummary;
  labels: DomainLabels;
}>) {
  const dl = labels.dmarc;
  const { totals } = summary;

  if (totals.reports === 0) {
    return (
      <div className="space-y-2 rounded-lg border border-dashed p-4 text-center">
        <p className="font-medium">{dl.emptyTitle}</p>
        <p className="mx-auto max-w-xl text-sm text-muted-foreground">
          {summary.reportAddress
            ? fill(dl.emptyWithAddress, { address: summary.reportAddress })
            : dl.emptyNoAddress}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border p-3">
          <dt className="text-xs text-muted-foreground">{dl.passRate}</dt>
          <dd className="text-2xl font-semibold">{passPercent(totals.passed, totals.messages)}%</dd>
          <dd className="text-xs text-muted-foreground">
            {fill(dl.messageCount, { count: totals.messages.toLocaleString() })}
          </dd>
        </div>
        <div className="rounded-lg border p-3 sm:col-span-2">
          <dt className="text-xs text-muted-foreground">{dl.lastReport}</dt>
          <dd className="text-sm font-medium">
            {totals.lastReportAt ? formatDateTime(totals.lastReportAt) : dl.noReportYet}
          </dd>
        </div>
      </dl>

      <InfoBanner variant="neutral">{dl.spfNote}</InfoBanner>

      <AdviceBox domain={domain} summary={summary} labels={labels} />
      <SourcesTable domain={domain} summary={summary} labels={labels} />
      <FailuresTable summary={summary} labels={labels} />
      <ReportersTable summary={summary} labels={labels} />
    </div>
  );
}

function AdviceBox({
  summary,
  labels,
}: Readonly<{
  domain: MailDomainRow;
  summary: DmarcSummary;
  labels: DomainLabels;
}>) {
  const dl = labels.dmarc;
  const { advice } = summary;
  const current = advice.current ?? summary.record.policy?.p ?? null;

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(labels.messages.copied);
    } catch {
      // Clipboard access denied: the record stays selectable.
    }
  }

  return (
    <section className="space-y-2" aria-label={dl.advice.suggestedRecord}>
      <p className="text-sm text-muted-foreground">
        {current ? fill(dl.advice.current, { policy: current }) : dl.advice.noPolicy}
      </p>
      {advice.ready && advice.next ? (
        <InfoBanner variant="success" title={fill(dl.advice.readyTitle, { policy: advice.next })}>
          <p>{fill(dl.advice.readyDescription, { policy: advice.next })}</p>
          {advice.suggestedRecord && (
            <div className="mt-2 flex items-start gap-1">
              <code className="break-all rounded bg-background/60 px-2 py-1 font-mono text-xs">
                {advice.suggestedRecord}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                aria-label={labels.copy}
                onClick={() => copy(advice.suggestedRecord ?? '')}
              >
                <Copy className="size-3.5" />
              </Button>
            </div>
          )}
        </InfoBanner>
      ) : (
        advice.blockers.length > 0 && (
          <InfoBanner variant="warning" title={dl.advice.notReadyTitle}>
            <ul className="list-disc space-y-1 pl-4">
              {advice.blockers.map((blocker, i) => (
                <li key={`${blocker.code}-${i}`}>{blockerText(blocker, dl)}</li>
              ))}
            </ul>
          </InfoBanner>
        )
      )}
    </section>
  );
}

function SourcesTable({
  domain,
  summary,
  labels,
}: Readonly<{
  domain: MailDomainRow;
  summary: DmarcSummary;
  labels: DomainLabels;
}>) {
  const dl = labels.dmarc;
  const mark = useMarkDmarcSource(domain.id);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function setMark(source: DmarcSource, next: DmarcSource['mark']) {
    setPendingKey(source.key);
    try {
      await mark.mutateAsync({ key: source.key, mark: next });
      toast.success(
        next === 'mine'
          ? dl.sources.markedMine
          : next === 'not_mine'
            ? dl.sources.markedNotMine
            : dl.sources.markCleared,
      );
    } catch {
      toast.error(dl.sources.markFailed);
    } finally {
      setPendingKey(null);
    }
  }

  if (summary.sources.length === 0) return null;

  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">{dl.sources.title}</h4>
        <p className="text-xs text-muted-foreground">{dl.sources.description}</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{dl.sources.source}</TableHead>
              <TableHead scope="col">{dl.sources.messages}</TableHead>
              <TableHead scope="col">{dl.sources.passRate}</TableHead>
              <TableHead scope="col">{dl.sources.mark}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.sources.map((source) => {
              const name = sourceName(source, dl);
              return (
                <TableRow key={source.key}>
                  <TableCell className="max-w-[260px]">
                    <div className="truncate font-medium" title={name}>
                      {name}
                    </div>
                    {source.kind !== 'weldsuite' && source.ips.length > 0 && (
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {source.ips.join(', ')}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{source.messages.toLocaleString()}</TableCell>
                  <TableCell>{passPercent(source.passed, source.messages)}%</TableCell>
                  <TableCell>
                    {source.kind === 'weldsuite' ? (
                      <SoftBadge tone="success">{dl.sources.weldsuite}</SoftBadge>
                    ) : (
                      <div
                        className="flex flex-wrap gap-1"
                        role="group"
                        aria-label={fill(dl.sources.markLabel, { name })}
                      >
                        <Button
                          type="button"
                          size="sm"
                          variant={source.mark === 'mine' ? 'default' : 'outline'}
                          aria-pressed={source.mark === 'mine'}
                          disabled={pendingKey === source.key}
                          onClick={() => setMark(source, source.mark === 'mine' ? null : 'mine')}
                        >
                          {dl.sources.mine}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={source.mark === 'not_mine' ? 'default' : 'outline'}
                          aria-pressed={source.mark === 'not_mine'}
                          disabled={pendingKey === source.key}
                          onClick={() =>
                            setMark(source, source.mark === 'not_mine' ? null : 'not_mine')
                          }
                        >
                          {dl.sources.notMine}
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function FailuresTable({
  summary,
  labels,
}: Readonly<{ summary: DmarcSummary; labels: DomainLabels }>) {
  const dl = labels.dmarc;
  if (summary.failures.length === 0) return null;

  return (
    <section className="space-y-2">
      <div>
        <h4 className="text-sm font-medium">{dl.failures.title}</h4>
        <p className="text-xs text-muted-foreground">{dl.failures.description}</p>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{dl.failures.source}</TableHead>
              <TableHead scope="col">{dl.failures.from}</TableHead>
              <TableHead scope="col">{dl.failures.dkim}</TableHead>
              <TableHead scope="col">{dl.failures.spf}</TableHead>
              <TableHead scope="col">{dl.failures.messages}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.failures.map((f) => (
              <TableRow key={`${f.sourceKey}-${f.headerFrom}-${f.dkimAligned}-${f.spfAligned}`}>
                <TableCell className="max-w-[200px] truncate" title={f.sourceName}>
                  {f.sourceName}
                </TableCell>
                <TableCell className="font-mono text-xs">{f.headerFrom}</TableCell>
                <TableCell className="whitespace-normal">
                  <div>{f.dkimAligned ? dl.failures.aligned : dl.failures.notAligned}</div>
                  {f.dkimDomains.length > 0 && (
                    <div className="break-all font-mono text-xs text-muted-foreground">
                      {fill(dl.failures.dkimDomains, {
                        domains: f.dkimDomains.join(', '),
                      })}
                    </div>
                  )}
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div>{f.spfAligned ? dl.failures.aligned : dl.failures.notAligned}</div>
                  {f.spfDomain && (
                    <div className="break-all font-mono text-xs text-muted-foreground">
                      {fill(dl.failures.spfDomain, { domain: f.spfDomain })}
                    </div>
                  )}
                </TableCell>
                <TableCell>{f.messages.toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function ReportersTable({
  summary,
  labels,
}: Readonly<{ summary: DmarcSummary; labels: DomainLabels }>) {
  const dl = labels.dmarc;
  if (summary.reporters.length === 0) return null;

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">{dl.reporters.title}</h4>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{dl.reporters.reporter}</TableHead>
              <TableHead scope="col">{dl.reporters.reports}</TableHead>
              <TableHead scope="col">{dl.reporters.messages}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.reporters.map((r) => (
              <TableRow key={`${r.domain}-${r.org}`}>
                <TableCell>
                  {r.org}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{r.domain}</span>
                </TableCell>
                <TableCell>{r.reports.toLocaleString()}</TableCell>
                <TableCell>{r.messages.toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
