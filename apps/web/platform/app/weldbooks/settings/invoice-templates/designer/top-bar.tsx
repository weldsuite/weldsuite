import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, ChevronDown, Eye, Loader2, Minus, Plus, Redo2, Save, Undo2 } from 'lucide-react';
import type { PaperSize } from '@weldsuite/books-domain/invoice-template/schema';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';

export const ZOOM_STEPS = [50, 75, 100, 125, 150, 200] as const;
export const SAMPLE_ROWS = [3, 12, 40] as const;

/** ⌘ on Apple platforms, Ctrl elsewhere. */
export const MOD_KEY = typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.platform) ? '⌘' : 'Ctrl+';

interface TopBarProps {
  name: string;
  onNameChange: (name: string) => void;
  /** Settles an emptied name back to the last saved one. */
  onNameBlur: () => void;
  isDefault: boolean;
  onDefaultChange: (value: boolean) => void;
  paperSize: PaperSize;
  onPaperSizeChange: (value: PaperSize) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** Zoom percentage shown (the fitted one in fit mode). */
  zoomPercent: number;
  fit: boolean;
  onFit: () => void;
  onZoomPercent: (percent: number) => void;
  onZoomStep: (direction: 1 | -1) => void;
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
  const [nameFocused, setNameFocused] = useState(false);

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background px-3 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" asChild>
            <Link to="/weldbooks/settings/invoice-templates" aria-label={td.back}>
              <ArrowLeft />
            </Link>
          </Button>
        </TooltipTrigger>
        <TooltipContent>{td.back}</TooltipContent>
      </Tooltip>

      <Input
        value={props.name}
        maxLength={120}
        placeholder={td.namePlaceholder}
        aria-label={td.nameLabel}
        disabled={!props.canEdit}
        onFocus={() => setNameFocused(true)}
        onChange={(e) => props.onNameChange(e.target.value)}
        onBlur={() => {
          setNameFocused(false);
          props.onNameBlur();
        }}
        className={`h-8 w-48 max-w-full border-transparent bg-transparent px-2 text-sm font-semibold shadow-none hover:border-input focus-visible:border-ring ${nameFocused ? 'bg-background' : ''}`}
      />

      {props.dirty ? (
        <Badge variant="outline" className="border-amber-500/60 text-amber-700 dark:text-amber-400">
          {td.unsaved}
        </Badge>
      ) : null}

      <div className="mx-1 hidden h-5 w-px bg-border md:block" aria-hidden />

      <Tooltip>
        <TooltipTrigger asChild>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={props.isDefault} disabled={!props.canEdit} onCheckedChange={props.onDefaultChange} aria-label={td.defaultToggle} />
            <span className="hidden sm:inline">{td.defaultToggle}</span>
          </label>
        </TooltipTrigger>
        <TooltipContent className="max-w-60">{td.defaultHint}</TooltipContent>
      </Tooltip>

      <Select value={props.paperSize} disabled={!props.canEdit} onValueChange={(v) => props.onPaperSizeChange(v as PaperSize)}>
        <SelectTrigger size="sm" className="h-8 w-[5.5rem] shadow-none" aria-label={td.paperSize}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a4">{ti.paper.a4}</SelectItem>
          <SelectItem value="letter">{ti.paper.letter}</SelectItem>
        </SelectContent>
      </Select>

      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={!props.canUndo || props.readOnly} onClick={props.onUndo} aria-label={td.undo}>
              <Undo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{`${td.undo} (${MOD_KEY}Z)`}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" disabled={!props.canRedo || props.readOnly} onClick={props.onRedo} aria-label={td.redo}>
              <Redo2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{`${td.redo} (${MOD_KEY}⇧Z)`}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex items-center gap-0.5" role="group" aria-label={td.zoom}>
        <Button variant="ghost" size="icon-sm" onClick={() => props.onZoomStep(-1)} aria-label={td.zoomOut}>
          <Minus />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="w-[4.5rem] justify-between gap-1 px-2 tabular-nums" aria-label={td.zoom}>
              {props.zoomPercent}%
              <ChevronDown className="h-3 w-3 opacity-60" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center">
            <DropdownMenuItem onSelect={props.onFit} className={props.fit ? 'bg-accent' : undefined}>
              {td.zoomFit}
            </DropdownMenuItem>
            {ZOOM_STEPS.map((step) => (
              <DropdownMenuItem key={step} onSelect={() => props.onZoomPercent(step)} className={!props.fit && props.zoomPercent === step ? 'bg-accent' : undefined}>
                {step}%
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon-sm" onClick={() => props.onZoomStep(1)} aria-label={td.zoomIn}>
          <Plus />
        </Button>
      </div>

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
                <ToggleGroupItem key={rows} value={String(rows)} aria-label={td.sampleRows.replace('{count}', String(rows))} className="h-8 min-w-8 px-2 text-xs tabular-nums">
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

      <div className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" className="shadow-none" onClick={props.onPreview}>
          <Eye aria-hidden />
          <span className="hidden md:inline">{td.previewPdf}</span>
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button size="sm" disabled={!props.dirty || props.saving || !props.canEdit || props.readOnly} onClick={props.onSave}>
                {props.saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
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
