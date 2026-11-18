/**
 * The public page of a WeldPanel share link, `/s/panel/<token>`: a
 * read-only report or dashboard for anyone with the link, no session. Outside
 * the workspace shell (`share` is reserved in `lib/workspace-url.ts`), kept
 * out of search engines and Referer headers, and shown inside another site's
 * iframe only when the link allows embedding (`?embed=1` drops the header).
 * The data comes from panel-api's public routes; the token is the only
 * credential.
 */

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { ExternalLink, Link2Off } from 'lucide-react';
import { PanelPublicShareError } from '@weldsuite/app-api-client/domains/weldpanel-collab';
import type { PanelPublicReport, PanelPublicShareDto, PanelPublicTile } from '@weldsuite/app-api-client/schemas/weldpanel-collab';
import type { PanelDatePreset, PanelQuerySpec } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@weldsuite/ui/lib/utils';
import { useWeldPanelPublicResult, useWeldPanelPublicShare } from '@/hooks/queries/use-weldpanel-collab-queries';
import { useI18n } from '@/lib/i18n/provider';
import { MarkdownText } from '@/app/weldpanel/components/markdown-text';
import { ReportResultBody } from '@/app/weldpanel/components/report-view';
import { ROW_UNIT_PX, normalizeLayout, orderItems } from '@/app/weldpanel/lib/dashboard-layout';
import { formatDate } from '@/app/weldpanel/lib/format';
import { isFramed } from './framing';

/** Keeps the page out of search indexes and keeps the token out of Referer headers. */
function useQuietPage(title: string) {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    const robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex, nofollow';
    const referrer = document.createElement('meta');
    referrer.name = 'referrer';
    referrer.content = 'no-referrer';
    document.head.append(robots, referrer);
    return () => {
      document.title = previousTitle;
      robots.remove();
      referrer.remove();
    };
  }, [title]);
}

/** A report spec as the result views read it. Public specs lack the project and filter values; the views only read the shape. */
function viewSpec(report: PanelPublicReport): PanelQuerySpec {
  return { ...report.spec, kind: report.kind, projectId: '' } as PanelQuerySpec;
}

function ReportResult({ token, report, tileId, preset }: Readonly<{ token: string; report: PanelPublicReport; tileId?: string; preset: PanelDatePreset | null }>) {
  const { t } = useI18n();
  const tp = t.weldpanel.collab.publicPage;
  const input = useMemo(() => ({ ...(tileId ? { tileId } : {}), ...(preset ? { dateRange: { preset } } : {}) }), [tileId, preset]);
  const { data, isLoading, isError, refetch } = useWeldPanelPublicResult(token, input);
  if (isLoading) return <Skeleton className="h-48 w-full" />;
  if (isError || !data)
    return (
      <div className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
        <p>{tp.tileFailed}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
          {tp.retry}
        </Button>
      </div>
    );
  return <ReportResultBody data={data} spec={viewSpec(report)} projectId="" />;
}

function DashboardTiles({ token, tiles, preset }: Readonly<{ token: string; tiles: PanelPublicTile[]; preset: PanelDatePreset | null }>) {
  const { t } = useI18n();
  const ordered = useMemo(() => {
    const layout = new Map(normalizeLayout(tiles).map((item) => [item.id, item.layout]));
    return orderItems(tiles.map((tile) => ({ ...tile, layout: layout.get(tile.id) ?? tile.layout })));
  }, [tiles]);
  if (ordered.length === 0) return <EmptyState icon={Link2Off} title={t.weldpanel.collab.publicPage.empty} />;
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[repeat(24,minmax(0,1fr))]">
      {ordered.map((tile) => (
        <Card
          key={tile.id}
          className="min-w-0 gap-2 overflow-hidden py-3 lg:[grid-column:var(--tile-col)]"
          style={{ '--tile-col': `span ${tile.layout.w}`, minHeight: tile.layout.h * ROW_UNIT_PX } as React.CSSProperties}
        >
          {tile.report && (
            <CardHeader className="px-4 pb-0">
              <CardTitle className="truncate text-sm font-medium">{tile.report.name}</CardTitle>
            </CardHeader>
          )}
          <CardContent className="min-h-0 flex-1 overflow-auto px-4">
            {tile.kind === 'text' && <MarkdownText>{tile.text ?? ''}</MarkdownText>}
            {tile.kind === 'report' && tile.report && <ReportResult token={token} report={tile.report} tileId={tile.id} preset={preset} />}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SharedView({ token, share, embed }: Readonly<{ token: string; share: PanelPublicShareDto; embed: boolean }>) {
  const { t, language, format } = useI18n();
  const tp = t.weldpanel.collab.publicPage;
  const tr = t.weldpanel.analytics.range;
  const [preset, setPreset] = useState<PanelDatePreset | null>(null);
  const presets = share.allowDateChange ? share.datePresets : [];
  const defaultPreset = (share.report?.spec.dateRange as { preset?: PanelDatePreset } | undefined)?.preset;

  return (
    <div className={cn('min-h-screen bg-muted/30 text-foreground', embed ? 'p-3' : 'px-4 py-6 sm:px-6 sm:py-8')}>
      <main className="mx-auto grid w-full max-w-6xl gap-4">
        {!embed && (
          <header className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">{format(tp.sharedFrom, { project: share.projectName })}</p>
              <h1 className="truncate text-2xl font-semibold tracking-tight">{share.name}</h1>
              {share.description && <p className="mt-1 text-sm text-muted-foreground">{share.description}</p>}
            </div>
            {presets.length > 0 && (
              <PresetPicker presets={presets} value={preset ?? defaultPreset ?? null} onChange={setPreset} label={tp.periodLabel} names={tr} />
            )}
          </header>
        )}
        {embed && presets.length > 0 && (
          <div className="flex justify-end">
            <PresetPicker presets={presets} value={preset ?? defaultPreset ?? null} onChange={setPreset} label={tp.periodLabel} names={tr} />
          </div>
        )}

        {share.targetType === 'report' && share.report && (
          <Card className="gap-3 py-4">
            {embed && (
              <CardHeader className="px-4 pb-0">
                <CardTitle className="text-sm font-medium">{share.name}</CardTitle>
              </CardHeader>
            )}
            <CardContent className="px-4">
              <ReportResult token={token} report={share.report} preset={preset} />
            </CardContent>
          </Card>
        )}
        {share.targetType === 'dashboard' && <DashboardTiles token={token} tiles={share.tiles} preset={preset} />}

        <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{share.expiresAt && !embed ? format(tp.expires, { date: formatDate(share.expiresAt, language) }) : ''}</span>
          <a href="https://weldsuite.org" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 hover:text-foreground">
            <img src="/assets/images/weldpanel/icon.svg?v=2" alt="" className="size-4" />
            {tp.madeWith}
          </a>
        </footer>
      </main>
    </div>
  );
}

function PresetPicker({
  presets,
  value,
  onChange,
  label,
  names,
}: Readonly<{ presets: PanelDatePreset[]; value: PanelDatePreset | null; onChange: (preset: PanelDatePreset) => void; label: string; names: Record<PanelDatePreset, string> }>) {
  return (
    <Select value={value ?? undefined} onValueChange={(next) => onChange(next as PanelDatePreset)}>
      <SelectTrigger size="sm" className="h-8 w-44" aria-label={label}>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {presets.map((preset) => (
          <SelectItem key={preset} value={preset}>
            {names[preset]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Problem({ title, description, action }: Readonly<{ title: string; description: string; action?: React.ReactNode }>) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <EmptyState icon={Link2Off} title={title} description={description} action={action} />
    </div>
  );
}

export default function PanelSharePage() {
  const { t } = useI18n();
  const tp = t.weldpanel.collab.publicPage;
  const { token = '' } = useParams({ strict: false });
  const search = useSearch({ strict: false }) as { embed?: unknown };
  const embed = search.embed === 1 || search.embed === '1' || search.embed === true;
  const { data: share, isLoading, error } = useWeldPanelPublicShare(token);
  const framed = useMemo(() => isFramed(), []);
  useQuietPage(share?.name ?? tp.title);

  if (isLoading) return <PageLoader label={tp.loading} />;
  if (error || !share) {
    if (error instanceof PanelPublicShareError && error.isRateLimited) return <Problem title={tp.rateLimitedTitle} description={tp.rateLimitedDescription} />;
    if (!error || (error instanceof PanelPublicShareError && error.isNotFound)) return <Problem title={tp.notFoundTitle} description={tp.notFoundDescription} />;
    return <Problem title={tp.failedTitle} description={tp.failedDescription} />;
  }
  // Framed by a site the link does not allow: show nothing of the report (no clickjacking, no silent embedding).
  if (framed && !share.allowEmbed) {
    return (
      <Problem
        title={tp.embedBlockedTitle}
        description={tp.embedBlockedDescription}
        action={
          <Button asChild size="sm" variant="outline">
            <a href={window.location.pathname} target="_blank" rel="noopener noreferrer">
              <ExternalLink />
              {tp.openInTab}
            </a>
          </Button>
        }
      />
    );
  }
  return <SharedView token={token} share={share} embed={embed} />;
}
