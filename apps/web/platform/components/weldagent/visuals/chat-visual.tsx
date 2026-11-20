/**
 * One visual in an AI reply: a chart, stat tiles, a table or record cards
 * (ADR AGENT-016). The frame carries the title and the actions: expand to a
 * dialog, download the data (and a chart as an image), and, where the chat
 * allows it, ask about a bar, slice, row or tile.
 */

import { useRef, useState, type ReactNode } from 'react';
import { Download, Maximize2 } from 'lucide-react';
import {
  visualTitle,
  type ChatVisual as ChatVisualSpec,
  type TableCell,
} from '@weldsuite/app-api-client/schemas/chat-visuals';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { cn } from '@/lib/utils';
import { getLocale, getTranslations } from '@/lib/i18n';
import { downloadChartPng, downloadVisualCsv } from './download';
import { formatNumber } from './format';
import { useChatVisualActions } from './visual-actions-context';
import { ChartDataTable, VisualChart, type ChartPick } from './visual-chart';
import { VisualRecords, type RecordCardLabels } from './visual-records';
import { VisualStats } from './visual-stats';
import { INLINE_TABLE_ROWS, VisualTable } from './visual-table';

/** `{name}` placeholders filled in. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

function useVisualStrings() {
  return getTranslations('common').ai.visuals;
}

/** The first cells of a row, as the thing to ask about. */
function rowLabel(row: TableCell[]): string {
  return row
    .filter((cell) => cell !== null && cell !== '')
    .slice(0, 3)
    .map(String)
    .join(' · ');
}

interface VisualBodyProps {
  visual: ChatVisualSpec;
  expanded: boolean;
  locale: string;
  onAsk?: (label: string, value?: string) => void;
  surfaceRef?: React.Ref<HTMLDivElement>;
  onShowAll?: () => void;
}

function VisualBody({ visual, expanded, locale, onAsk, surfaceRef, onShowAll }: Readonly<VisualBodyProps>) {
  const t = useVisualStrings();
  switch (visual.type) {
    case 'chart':
      return (
        <>
          <VisualChart
            visual={visual}
            locale={locale}
            expanded={expanded}
            surfaceRef={surfaceRef}
            otherLabel={t.other}
            onPick={
              onAsk
                ? (pick: ChartPick) =>
                    onAsk(pick.label, pick.value === undefined ? undefined : formatNumber(pick.value, visual.format, locale))
                : undefined
            }
          />
          <ChartDataTable visual={visual} locale={locale} />
        </>
      );
    case 'stats':
      return (
        <VisualStats
          visual={visual}
          locale={locale}
          onPick={onAsk ? (item, value) => onAsk(item.label, value) : undefined}
          askLabel={(label) => fill(t.askAbout, { label })}
        />
      );
    case 'table':
      return (
        <>
          <VisualTable
            visual={visual}
            locale={locale}
            expanded={expanded}
            sortLabel={(column) => fill(t.sortBy, { column })}
            onPickRow={onAsk ? (row) => onAsk(rowLabel(row)) : undefined}
          />
          {!expanded && visual.rows.length > INLINE_TABLE_ROWS && onShowAll && (
            <Button variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs text-muted-foreground" onClick={onShowAll}>
              {fill(t.showAllRows, { count: visual.rows.length })}
            </Button>
          )}
        </>
      );
    case 'records': {
      const labels: RecordCardLabels = {
        open: (name) => fill(t.openRecord, { name }),
        noAccess: (name) => fill(t.noAccess, { name }),
        deleted: (name) => fill(t.deleted, { name }),
      };
      return <VisualRecords visual={visual} labels={labels} />;
    }
    default:
      return null;
  }
}

function Header({ visual, actions }: Readonly<{ visual: ChatVisualSpec; actions?: ReactNode }>) {
  const title = visual.title;
  const description = visual.type === 'chart' ? visual.description : undefined;
  if (!title && !description && !actions) return null;
  return (
    <div className="mb-2 flex items-start justify-between gap-2">
      <div className="min-w-0">
        {title && <p className="text-sm font-medium leading-snug text-foreground">{title}</p>}
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function ChatVisual({ visual, className }: Readonly<{ visual: ChatVisualSpec; className?: string }>) {
  const t = useVisualStrings();
  const locale = getLocale();
  const { ask } = useChatVisualActions();
  const [expanded, setExpanded] = useState(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const title = visualTitle(visual) || t.kinds[visual.type];
  const caption = visual.type === 'chart' ? visual.caption : undefined;

  const onAsk = ask
    ? (label: string, value?: string) => {
        setExpanded(false);
        ask(value ? fill(t.askPromptValue, { label, value, title }) : fill(t.askPrompt, { label, title }));
      }
    : undefined;

  const csvHeaders = t.csv;
  const actions = (
    <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover/visual:opacity-100 group-focus-within/visual:opacity-100">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-7" title={t.download} aria-label={t.download}>
            <Download className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => downloadVisualCsv(visual, csvHeaders)}>{t.downloadCsv}</DropdownMenuItem>
          {visual.type === 'chart' && (
            <DropdownMenuItem
              onSelect={() => {
                if (surfaceRef.current) void downloadChartPng(surfaceRef.current, visual);
              }}
            >
              {t.downloadPng}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        title={t.expand}
        aria-label={t.expand}
        onClick={() => setExpanded(true)}
      >
        <Maximize2 className="size-3.5" />
      </Button>
    </div>
  );

  return (
    <figure
      className={cn('not-prose group/visual my-3 rounded-xl border bg-card p-3 text-card-foreground', className)}
      data-visual-type={visual.type}
    >
      <Header visual={visual} actions={actions} />
      <VisualBody
        visual={visual}
        expanded={false}
        locale={locale}
        onAsk={onAsk}
        surfaceRef={surfaceRef}
        onShowAll={() => setExpanded(true)}
      />
      {caption && <figcaption className="mt-2 text-xs text-muted-foreground">{caption}</figcaption>}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {(visual.type === 'chart' && visual.description) || caption ? (
              <DialogDescription>
                {[visual.type === 'chart' ? visual.description : undefined, caption].filter(Boolean).join(' · ')}
              </DialogDescription>
            ) : (
              <DialogDescription className="sr-only">{t.kinds[visual.type]}</DialogDescription>
            )}
          </DialogHeader>
          {expanded && <VisualBody visual={visual} expanded locale={locale} onAsk={onAsk} />}
        </DialogContent>
      </Dialog>
    </figure>
  );
}

/** Where a visual is still streaming in. */
export function ChatVisualPlaceholder() {
  const t = useVisualStrings();
  return (
    <div className="not-prose my-3 rounded-xl border p-3" aria-busy="true">
      <Skeleton className="mb-3 h-4 w-40" />
      <Skeleton className="h-40 w-full" />
      <span className="sr-only">{t.drawing}</span>
    </div>
  );
}

