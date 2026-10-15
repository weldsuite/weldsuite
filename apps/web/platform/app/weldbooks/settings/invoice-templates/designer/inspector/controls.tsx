/** Small form controls shared by the inspector panels. */
import { useId, useState, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, ChevronDown, Italic, Type } from 'lucide-react';
import { COLOR_TOKENS, type ColorToken, type LabelStyle, type TemplateColor, type TextStyle } from '@weldsuite/books-domain/invoice-template/schema';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { Switch } from '@weldsuite/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import { Toggle } from '@weldsuite/ui/components/toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { isColorToken, mergeStyle, normalizeHex, resolveColor } from '../model/colors';
import { useDesigner } from '../context';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function InspectorSection({
  title,
  children,
  defaultOpen = true,
  action,
}: Readonly<{ title: string; children: ReactNode; defaultOpen?: boolean; action?: ReactNode }>) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <section className="border-b border-border last:border-b-0">
      <div className="flex items-center justify-between gap-2 px-4 pt-3">
        <button
          type="button"
          className="flex flex-1 items-center gap-1.5 py-1 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')} aria-hidden />
          {title}
        </button>
        {action}
      </div>
      {open ? (
        <div id={bodyId} className="space-y-3 px-4 pb-4 pt-2">
          {children}
        </div>
      ) : (
        <div className="pb-3" />
      )}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  className,
}: Readonly<{ label: ReactNode; htmlFor?: string; hint?: ReactNode; children: ReactNode; className?: string }>) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-xs font-normal text-muted-foreground">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SwitchField({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: Readonly<{ label: ReactNode; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean; hint?: ReactNode }>) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
        <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
      </div>
      {hint ? <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Note({ children }: Readonly<{ children: ReactNode }>) {
  return <p className="rounded-md bg-muted/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const roundTo = (n: number, decimals = 2) => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

interface NumberInputProps {
  id?: string;
  value: number | undefined;
  onChange: (value: number) => void;
  /** An emptied field: reverts to the default. Without it an empty field keeps the last value. */
  onClear?: () => void;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  suffix?: string;
  disabled?: boolean;
  className?: string;
  'aria-label'?: string;
}

/**
 * A number field that accepts what you type as long as it is a valid number
 * in range, ArrowUp / ArrowDown step it (Shift: ten steps), and it settles on
 * the stored value when it loses focus.
 */
export function NumberInput({
  id,
  value,
  onChange,
  onClear,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  placeholder,
  suffix,
  disabled,
  className,
  'aria-label': ariaLabel,
}: Readonly<NumberInputProps>) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value === undefined ? '' : String(roundTo(value)));

  const commit = (text: string) => {
    if (text.trim() === '') {
      onClear?.();
      return;
    }
    const n = Number.parseFloat(text.replace(',', '.'));
    if (Number.isFinite(n) && n >= min && n <= max) onChange(roundTo(n));
  };

  return (
    <div className={cn('relative', className)}>
      <Input
        id={id}
        inputMode="decimal"
        value={shown}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        className={cn('h-8 px-2 text-sm tabular-nums', suffix && 'pr-8')}
        onChange={(e) => {
          setDraft(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const base = value ?? (Number.isFinite(min) ? min : 0);
          const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
          const next = Math.min(max, Math.max(min, roundTo(base + delta)));
          setDraft(null);
          onChange(next);
        }}
      />
      {suffix ? (
        <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-[11px] text-muted-foreground">{suffix}</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

const CHECKERBOARD =
  'repeating-conic-gradient(var(--border) 0% 25%, transparent 0% 50%) 50% / 8px 8px';

function Swatch({ color, className }: Readonly<{ color: string | null; className?: string }>) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-4 w-4 shrink-0 rounded-sm border border-border', className)}
      style={color ? { backgroundColor: color } : { background: CHECKERBOARD }}
    />
  );
}

interface ColorControlProps {
  id?: string;
  value: TemplateColor | undefined;
  onChange: (value: TemplateColor | undefined) => void;
  /** Offer accent / text / muted next to the custom colour. */
  tokens?: boolean;
  /** Label of the "no value" choice: "None" for a background, "Default" for text. */
  emptyLabel?: string;
  /** What an empty value paints as: a theme colour, or null for transparent. */
  emptyColor?: TemplateColor | null;
  disabled?: boolean;
  'aria-label'?: string;
}

/** Theme colour tokens plus a custom colour, in one popover. */
export function ColorControl({ id, value, onChange, tokens = true, emptyLabel, emptyColor = null, disabled, 'aria-label': ariaLabel }: Readonly<ColorControlProps>) {
  const { t } = useI18n();
  const tc = t.accounting.invoiceTemplates.inspector.colors;
  const { theme, readOnly } = useDesigner();
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState<string | null>(null);

  const current = value ?? (emptyColor ?? undefined);
  const swatch = current ? resolveColor(current, theme) : null;
  let text: string;
  if (value === undefined) text = emptyLabel ?? tc.none;
  else if (isColorToken(value)) text = tc[value];
  else text = value;

  const tokenNames: Record<ColorToken, string> = { accent: tc.accent, text: tc.text, muted: tc.muted };
  const customHex = value && !isColorToken(value) ? value : resolveColor(value ?? emptyColor ?? 'text', theme);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setHex(null);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled ?? readOnly}
          aria-label={ariaLabel}
          className="h-8 w-full justify-start gap-2 px-2 font-normal shadow-none"
        >
          <Swatch color={swatch} />
          <span className="truncate font-mono text-xs">{text}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 space-y-3 p-3">
        {tokens ? (
          <div className="grid grid-cols-3 gap-1.5">
            {COLOR_TOKENS.map((token) => (
              <button
                key={token}
                type="button"
                onClick={() => {
                  onChange(token);
                  setOpen(false);
                }}
                className={cn(
                  'flex flex-col items-center gap-1 rounded-md border p-2 text-[11px] outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  value === token ? 'border-primary bg-accent' : 'border-border',
                )}
              >
                <Swatch color={resolveColor(token, theme)} className="h-5 w-5" />
                {tokenNames[token]}
              </button>
            ))}
          </div>
        ) : null}
        <div className="space-y-1.5">
          <Label className="text-xs font-normal text-muted-foreground">{tc.custom}</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={tc.custom}
              value={normalizeHex(customHex) ?? '#000000'}
              onChange={(e) => onChange(e.target.value)}
              className="h-8 w-8 shrink-0 cursor-pointer rounded-md border bg-transparent p-1"
            />
            <Input
              value={hex ?? customHex}
              maxLength={7}
              spellCheck={false}
              aria-label={tc.custom}
              className="h-8 font-mono text-xs"
              onChange={(e) => {
                setHex(e.target.value);
                const normalized = normalizeHex(e.target.value);
                if (normalized) onChange(normalized);
              }}
              onBlur={() => setHex(null)}
            />
          </div>
        </div>
        {emptyLabel ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <Swatch color={emptyColor ? resolveColor(emptyColor, theme) : null} />
            {emptyLabel}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Alignment and text style
// ---------------------------------------------------------------------------

type Align = 'left' | 'center' | 'right';

export function AlignControl({ value, onChange, 'aria-label': ariaLabel }: Readonly<{ value: Align | undefined; onChange: (value: Align | undefined) => void; 'aria-label'?: string }>) {
  const { t } = useI18n();
  const ts = t.accounting.invoiceTemplates.inspector.textStyle;
  const { readOnly } = useDesigner();
  const items: Array<{ value: Align; label: string; icon: ReactNode }> = [
    { value: 'left', label: ts.alignLeft, icon: <AlignLeft className="h-4 w-4" /> },
    { value: 'center', label: ts.alignCenter, icon: <AlignCenter className="h-4 w-4" /> },
    { value: 'right', label: ts.alignRight, icon: <AlignRight className="h-4 w-4" /> },
  ];
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={value ?? 'left'}
      disabled={readOnly}
      aria-label={ariaLabel ?? ts.align}
      onValueChange={(next) => {
        if (next) onChange(next === 'left' ? undefined : (next as Align));
      }}
      className="w-full"
    >
      {items.map((item) => (
        <Tooltip key={item.value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem value={item.value} aria-label={item.label} className="flex-1">
              {item.icon}
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{item.label}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}

function StyleToggle({ pressed, onPressedChange, label, children }: Readonly<{ pressed: boolean; onPressedChange: (next: boolean) => void; label: string; children: ReactNode }>) {
  const { readOnly } = useDesigner();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toggle
          pressed={pressed}
          onPressedChange={onPressedChange}
          aria-label={label}
          disabled={readOnly}
          variant="outline"
          size="sm"
          className="h-8 w-8 min-w-8 px-0"
        >
          {children}
        </Toggle>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** "Accent", "Text" or "Muted" for a theme token, the hex itself otherwise. */
function defaultColorName(color: TemplateColor, names: Record<ColorToken, string>): string {
  return isColorToken(color) ? names[color] : color;
}

interface TextStyleControlsProps {
  value: TextStyle | undefined;
  onChange: (value: TextStyle | undefined) => void;
  /** Size, colour and weight the block prints with when the style leaves them out. */
  defaults?: { size?: number; color?: TemplateColor };
  title?: string;
}

/** Size, bold, italic, uppercase, colour, alignment and line height of a text style. */
export function TextStyleControls({ value, onChange, defaults, title }: Readonly<TextStyleControlsProps>) {
  const { t } = useI18n();
  const ts = t.accounting.invoiceTemplates.inspector.textStyle;
  const { theme } = useDesigner();
  const id = useId();
  const set = (patch: Partial<{ [K in keyof TextStyle]: TextStyle[K] | undefined }>) => onChange(mergeStyle(value, patch));

  return (
    <div className="space-y-3">
      {title ? <p className="text-xs font-medium">{title}</p> : null}
      <div className="grid grid-cols-2 gap-2">
        <Field label={ts.size} htmlFor={`${id}-size`}>
          <NumberInput
            id={`${id}-size`}
            value={value?.fontSize}
            placeholder={String(defaults?.size ?? theme.fontSize)}
            min={5}
            max={72}
            step={0.5}
            suffix="pt"
            onChange={(n) => set({ fontSize: n })}
            onClear={() => set({ fontSize: undefined })}
          />
        </Field>
        <Field label={ts.lineHeight} htmlFor={`${id}-lh`}>
          <NumberInput
            id={`${id}-lh`}
            value={value?.lineHeight}
            placeholder="1.3"
            min={0.8}
            max={3}
            step={0.1}
            onChange={(n) => set({ lineHeight: n })}
            onClear={() => set({ lineHeight: undefined })}
          />
        </Field>
      </div>
      <div className="flex items-center gap-1.5">
        <StyleToggle pressed={Boolean(value?.bold)} onPressedChange={(p) => set({ bold: p || undefined })} label={ts.bold}>
          <Bold className="h-4 w-4" />
        </StyleToggle>
        <StyleToggle pressed={Boolean(value?.italic)} onPressedChange={(p) => set({ italic: p || undefined })} label={ts.italic}>
          <Italic className="h-4 w-4" />
        </StyleToggle>
        <StyleToggle pressed={Boolean(value?.uppercase)} onPressedChange={(p) => set({ uppercase: p || undefined })} label={ts.uppercase}>
          <Type className="h-4 w-4" />
        </StyleToggle>
        <div className="ml-1 min-w-0 flex-1">
          <AlignControl value={value?.align} onChange={(align) => set({ align })} />
        </div>
      </div>
      <Field label={ts.color} htmlFor={`${id}-color`}>
        <ColorControl
          id={`${id}-color`}
          value={value?.color}
          emptyLabel={defaultColorName(defaults?.color ?? 'text', t.accounting.invoiceTemplates.inspector.colors)}
          emptyColor={defaults?.color ?? 'text'}
          onChange={(color) => set({ color })}
        />
      </Field>
    </div>
  );
}

/** Show / hide, override text and colour of the small label above a block. */
export function LabelControls({
  value,
  onChange,
}: Readonly<{ value: LabelStyle | undefined; onChange: (value: LabelStyle | undefined) => void }>) {
  const { t } = useI18n();
  const tl = t.accounting.invoiceTemplates.inspector.label;
  const id = useId();
  const { readOnly } = useDesigner();
  const set = (patch: Partial<{ [K in keyof LabelStyle]: LabelStyle[K] | undefined }>) => onChange(mergeStyle(value, patch));
  const shown = value?.show !== false;
  return (
    <div className="space-y-3">
      <SwitchField label={tl.show} checked={shown} onChange={(show) => set({ show: show ? undefined : false })} />
      {shown ? (
        <Field label={tl.text} htmlFor={`${id}-text`}>
          <Input
            id={`${id}-text`}
            value={value?.text ?? ''}
            maxLength={120}
            placeholder={tl.textPlaceholder}
            disabled={readOnly}
            className="h-8 text-sm"
            onChange={(e) => set({ text: e.target.value === '' ? undefined : e.target.value })}
          />
        </Field>
      ) : null}
    </div>
  );
}
