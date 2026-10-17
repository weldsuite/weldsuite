import { Link } from '@tanstack/react-router';
import { ChevronLeft, Redo2, Undo2 } from 'lucide-react';
import type { PaperSize } from '@weldsuite/books-domain/invoice-template/schema';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';

export const SAMPLE_ROWS = [3, 12, 40] as const;

export type DesignerView = 'desktop' | 'mobile';

/** ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD_KEY = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

interface TopBarProps {
  name: string;
  onNameChange: (name: string) => void;
  /** Settles an emptied name back to the last saved one. */
  onNameBlur: () => void;
  paperSize: PaperSize;
  onPaperSizeChange: (value: PaperSize) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  view: DesignerView;
  onViewChange: (view: DesignerView) => void;
  sampleRows: number;
  onSampleRows: (rows: number) => void;
  onPreview: () => void;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  canEdit: boolean;
}

export function DesignerTopBar(props: Readonly<TopBarProps>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const td = ti.designer;

  return (
    // Laid out like the designer below it: a part over the invoice area, with the name on the left and the page
    // controls centred on the invoice, and a part over the sidebar (same width) with the actions.
    <header className="flex h-[53px] shrink-0 items-center border-b border-border bg-background">
      <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center gap-3 px-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" className="size-7" asChild>
                  <Link to="/weldbooks/settings/invoice-templates" aria-label={td.back}>
                    <ChevronLeft />
                  </Link>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{td.back}</TooltipContent>
            </Tooltip>

            {/* The name reads as the page title and is edited in place, without a field around it. */}
            <Input
              value={props.name}
              maxLength={120}
              placeholder={td.namePlaceholder}
              aria-label={td.nameLabel}
              disabled={!props.canEdit}
              onChange={(e) => props.onNameChange(e.target.value)}
              onBlur={props.onNameBlur}
              className="h-8 w-48 max-w-full rounded-none border-0 bg-transparent px-0 text-sm font-semibold shadow-none focus-visible:ring-0 disabled:opacity-100 dark:bg-transparent"
            />
          </div>

        </div>

        <div className="flex items-center gap-3">
          <Select value={props.paperSize} disabled={!props.canEdit} onValueChange={(v) => props.onPaperSizeChange(v as PaperSize)}>
            <SelectTrigger size="sm" className="h-8 w-[5.5rem] shadow-none" aria-label={td.paperSize}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="a4">{ti.paper.a4}</SelectItem>
              <SelectItem value="letter">{ti.paper.letter}</SelectItem>
            </SelectContent>
          </Select>

          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={String(props.sampleRows)}
                  aria-label={td.sampleSize}
                  onValueChange={(v) => {
                    if (v) props.onSampleRows(Number(v));
                  }}
                >
                  {SAMPLE_ROWS.map((rows) => (
                    <ToggleGroupItem
                      key={rows}
                      value={String(rows)}
                      aria-label={td.sampleRows.replace('{count}', String(rows))}
                      className="h-8 min-w-8 px-2 text-xs tabular-nums"
                    >
                      {rows}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              {td.sampleSize}: {td.sampleHint}
            </TooltipContent>
          </Tooltip>

          <Select value={props.view} onValueChange={(v) => props.onViewChange(v as DesignerView)}>
            <SelectTrigger size="sm" className="h-8 w-[6.5rem] shadow-none" aria-label={td.view}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="desktop">{td.viewDesktop}</SelectItem>
              <SelectItem value="mobile">{td.viewMobile}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div aria-hidden />
      </div>

      <div className="flex shrink-0 items-center justify-end gap-2 px-3 lg:w-[399px]">
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon-sm" className="shadow-none" disabled={!props.canUndo || props.readOnly} onClick={props.onUndo} aria-label={td.undo}>
                <Undo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`${td.undo} (${MOD_KEY}Z)`}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon-sm" className="shadow-none" disabled={!props.canRedo || props.readOnly} onClick={props.onRedo} aria-label={td.redo}>
                <Redo2 />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{`${td.redo} (${MOD_KEY}⇧Z)`}</TooltipContent>
          </Tooltip>
        </div>
        <Button variant="outline" size="sm" className="shadow-none" onClick={props.onPreview}>
          {td.previewPdf}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button size="sm" disabled={!props.dirty || props.saving || !props.canEdit || props.readOnly} onClick={props.onSave}>
                {props.saving ? td.saving : td.save}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{`${td.save} (${MOD_KEY}S)`}</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
