import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, Bold, Italic, Plus, Strikethrough, Trash2, Underline } from 'lucide-react';
import type { ColorPoint, ConditionalFormat, ConditionalStyle } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useI18n } from '@/lib/i18n/provider';
import type { SheetController } from '../model/sheet-controller';
import { moveFormat, newRuleId, nextFormatOrder, removeFormat, saveFormat } from '../model/rules';
import { fromDraft, parseRanges, rangesText, toDraft, type ConditionDraft } from './conditions';
import { ColorSelect, ConditionFields, Field } from './fields';
import { conditionSummary, RulePanel, selectionText } from './panel';

const DEFAULT_STYLE: ConditionalStyle = { fill: '#b7e1cd' };
const DEFAULT_SCALE: ColorPoint[] = [
  { kind: 'min', color: '#ffffff' },
  { kind: 'max', color: '#57bb8a' },
];

/** The conditional formatting side panel: the sheet's rules in order, and an editor for one. */
export function FormatsPanel({ controller }: { controller: SheetController }) {
  const { t } = useI18n();
  const tf = t.weldsheets.conditionalFormats;
  const [editing, setEditing] = useState<ConditionalFormat | null>(null);
  const rules = controller.sheet.conditionalFormats;
  const close = () => controller.openPanel(null);

  if (editing) {
    return (
      <RulePanel title={tf.title} closeLabel={tf.close} onClose={close}>
        <FormatEditor controller={controller} rule={editing} onDone={() => setEditing(null)} />
      </RulePanel>
    );
  }

  const add = () =>
    setEditing({
      id: newRuleId(),
      order: nextFormatOrder(controller),
      ranges: parseRanges(selectionText(controller)) ?? [],
      rule: { type: 'condition', condition: { type: 'notEmpty' }, style: DEFAULT_STYLE },
    });

  return (
    <RulePanel title={tf.title} closeLabel={tf.close} onClose={close}>
      {rules.length === 0 && <p className="text-sm text-muted-foreground">{tf.empty}</p>}
      <ul className="flex flex-col gap-2">
        {rules.map((rule, i) => (
          <li key={rule.id} className="group flex items-center gap-2 rounded-md border p-2 hover:bg-accent/50">
            <RuleSwatch rule={rule} />
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setEditing(rule)}>
              <span className="block truncate text-sm">{ruleLabel(rule, t.weldsheets.conditions, tf.scale)}</span>
              <span className="block truncate text-xs text-muted-foreground">{rangesText(rule.ranges)}</span>
            </button>
            <div className="flex opacity-0 group-hover:opacity-100">
              <IconAction label={tf.moveUp} disabled={i === 0} onClick={() => moveFormat(controller, rule.id, -1)}>
                <ArrowUp />
              </IconAction>
              <IconAction label={tf.moveDown} disabled={i === rules.length - 1} onClick={() => moveFormat(controller, rule.id, 1)}>
                <ArrowDown />
              </IconAction>
              <IconAction label={tf.remove} onClick={() => removeFormat(controller, rule.id)}>
                <Trash2 />
              </IconAction>
            </div>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="self-start" onClick={add}>
        <Plus />
        {tf.addRule}
      </Button>
    </RulePanel>
  );
}

function ruleLabel(rule: ConditionalFormat, labels: Parameters<typeof conditionSummary>[1], scale: string): string {
  return rule.rule.type === 'condition' ? conditionSummary(rule.rule.condition, labels) : scale;
}

/** A small sample of what the rule does. */
function RuleSwatch({ rule }: { rule: ConditionalFormat }) {
  if (rule.rule.type === 'colorScale') {
    const colors = rule.rule.points.map((p) => p.color).join(', ');
    return <span className="h-6 w-8 shrink-0 rounded border" style={{ background: `linear-gradient(to right, ${colors})` }} />;
  }
  return <StyledSample style={rule.rule.style} className="h-6 w-8 shrink-0 text-xs" />;
}

function StyledSample({ style, className }: { style: ConditionalStyle; className: string }) {
  return (
    <span
      className={`flex items-center justify-center rounded border ${className}`}
      style={{
        backgroundColor: style.fill,
        color: style.color,
        fontWeight: style.bold ? 700 : undefined,
        fontStyle: style.italic ? 'italic' : undefined,
        textDecoration: [style.underline && 'underline', style.strike && 'line-through'].filter(Boolean).join(' ') || undefined,
      }}
    >
      123
    </span>
  );
}

function IconAction({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="rounded p-1 hover:bg-accent disabled:opacity-30 [&_svg]:size-3.5" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

interface PointDraft {
  kind: ColorPoint['kind'] | 'none';
  value: string;
  color: string;
}

function FormatEditor({ controller, rule, onDone }: { controller: SheetController; rule: ConditionalFormat; onDone: () => void }) {
  const { t } = useI18n();
  const tf = t.weldsheets.conditionalFormats;
  const locale = controller.options.formulaLocale;
  const existing = controller.sheet.conditionalFormats.some((r) => r.id === rule.id);
  const [ranges, setRanges] = useState(rangesText(rule.ranges));
  const [mode, setMode] = useState<'condition' | 'colorScale'>(rule.rule.type);
  const [draft, setDraft] = useState<ConditionDraft>(() => toDraft(rule.rule.type === 'condition' ? rule.rule.condition : undefined, locale));
  const [style, setStyle] = useState<ConditionalStyle>(rule.rule.type === 'condition' ? rule.rule.style : DEFAULT_STYLE);
  const [points, setPoints] = useState<PointDraft[]>(() => {
    const scale = rule.rule.type === 'colorScale' ? rule.rule.points : DEFAULT_SCALE;
    const draftOf = (p: ColorPoint): PointDraft => ({ kind: p.kind, value: p.value === undefined ? '' : String(p.value), color: p.color });
    const low = draftOf(scale[0]!);
    const high = draftOf(scale.at(-1)!);
    const mid = scale.length === 3 ? draftOf(scale[1]!) : { kind: 'none' as const, value: '50', color: '#ffd666' };
    return [low, mid, high];
  });

  const save = () => {
    const parsed = parseRanges(ranges);
    if (!parsed) {
      toast.error(tf.rangeInvalid);
      return;
    }
    if (mode === 'condition') {
      const condition = fromDraft(draft, locale);
      if (!condition) {
        toast.error(condition === null ? t.weldsheets.filterMenu.invalid : tf.conditionRequired);
        return;
      }
      saveFormat(controller, { ...rule, ranges: parsed, rule: { type: 'condition', condition, style } });
    } else {
      const used = points.filter((p) => p.kind !== 'none');
      const scale: ColorPoint[] = used.map((p) => {
        const kind = p.kind as ColorPoint['kind'];
        const value = Number(p.value.replace(',', '.'));
        return kind === 'min' || kind === 'max' || !Number.isFinite(value) ? { kind, color: p.color } : { kind, value, color: p.color };
      });
      saveFormat(controller, { ...rule, ranges: parsed, rule: { type: 'colorScale', points: scale } });
    }
    onDone();
  };

  const toggleStyle = (key: 'bold' | 'italic' | 'underline' | 'strike') => setStyle((s) => ({ ...s, [key]: s[key] ? undefined : true }));
  const setPoint = (i: number, patch: Partial<PointDraft>) => setPoints((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const pointLabels = [tf.minpoint, tf.midpoint, tf.maxpoint];
  const kindLabels: Record<PointDraft['kind'], string> = {
    min: tf.pointMin,
    max: tf.pointMax,
    number: tf.pointNumber,
    percent: tf.pointPercent,
    percentile: tf.pointPercentile,
    none: tf.pointNone,
  };
  const kindsFor = (i: number): PointDraft['kind'][] => {
    if (i === 1) return ['none', 'number', 'percent', 'percentile'];
    return [i === 0 ? 'min' : 'max', 'number', 'percent', 'percentile'];
  };

  return (
    <div className="flex flex-col gap-4">
      <Field label={tf.applyTo}>
        <Input className="h-8 font-mono text-sm" value={ranges} onChange={(e) => setRanges(e.target.value)} aria-label={tf.applyTo} />
      </Field>
      <Tabs value={mode} onValueChange={(v) => setMode(v as 'condition' | 'colorScale')}>
        <TabsList className="w-full">
          <TabsTrigger value="condition" className="flex-1">
            {tf.single}
          </TabsTrigger>
          <TabsTrigger value="colorScale" className="flex-1">
            {tf.scale}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {mode === 'condition' ? (
        <>
          <Field label={tf.when}>
            <ConditionFields draft={draft} onChange={setDraft} allowNone={false} />
          </Field>
          <Field label={tf.style}>
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  ['bold', Bold],
                  ['italic', Italic],
                  ['underline', Underline],
                  ['strike', Strikethrough],
                ] as const
              ).map(([key, Icon]) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded p-1.5 hover:bg-accent [&_svg]:size-4 ${style[key] ? 'bg-accent' : ''}`}
                  aria-pressed={!!style[key]}
                  aria-label={t.weldsheets.toolbar[key === 'strike' ? 'strikethrough' : key]}
                  onClick={() => toggleStyle(key)}
                >
                  <Icon />
                </button>
              ))}
              <ColorSelect label={tf.textColor} value={style.color} none={tf.noColor} onChange={(color) => setStyle((s) => ({ ...s, color }))} />
              <ColorSelect label={tf.fillColor} value={style.fill} none={tf.noColor} onChange={(fill) => setStyle((s) => ({ ...s, fill }))} />
            </div>
            <StyledSample style={style} className="mt-1 h-8 text-sm" />
          </Field>
        </>
      ) : (
        <>
          {points.map((p, i) => (
            <Field key={pointLabels[i]} label={pointLabels[i]!}>
              <div className="flex items-center gap-2">
                <Select value={p.kind} onValueChange={(kind) => setPoint(i, { kind: kind as PointDraft['kind'] })}>
                  <SelectTrigger className="h-8 w-36 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {kindsFor(i).map((k) => (
                      <SelectItem key={k} value={k}>
                        {kindLabels[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {p.kind !== 'none' && p.kind !== 'min' && p.kind !== 'max' && (
                  <Input className="h-8 w-16 text-sm" value={p.value} onChange={(e) => setPoint(i, { value: e.target.value })} aria-label={kindLabels[p.kind]} />
                )}
                {p.kind !== 'none' && <ColorSelect label="" value={p.color} onChange={(color) => setPoint(i, { color: color ?? p.color })} />}
              </div>
            </Field>
          ))}
          <span
            className="h-6 rounded border"
            style={{ background: `linear-gradient(to right, ${points.filter((p) => p.kind !== 'none').map((p) => p.color).join(', ')})` }}
            aria-label={tf.preview}
          />
        </>
      )}
      <div className="flex items-center gap-2">
        {existing && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => {
              removeFormat(controller, rule.id);
              onDone();
            }}
          >
            <Trash2 />
            {tf.remove}
          </Button>
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" size="sm" onClick={onDone}>
            {tf.cancel}
          </Button>
          <Button size="sm" onClick={save}>
            {tf.done}
          </Button>
        </div>
      </div>
    </div>
  );
}
