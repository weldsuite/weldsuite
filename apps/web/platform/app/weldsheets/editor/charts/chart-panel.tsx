import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { chartSourceOf, type Chart, type ChartSource } from '@weldsuite/sheets-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { CHART_VARIANTS, parseDataRange, rangeLabel, removeChart, saveChart, variantOf, withRange, withVariant, type ChartVariant } from '../model/charts';
import type { SheetController } from '../model/sheet-controller';
import { ColorSelect, CommitInput, Field } from '../rules/fields';
import { RulePanel } from '../rules/panel';

type Legend = NonNullable<Chart['legend']>;
const LEGENDS: Legend[] = ['bottom', 'top', 'right', 'none'];

/** The chart editor: what the picked chart shows and how. Every change is saved as it is made. */
export function ChartPanel({ controller }: { controller: SheetController }) {
  const { t } = useI18n();
  const tc = t.weldsheets.charts;
  const chart = controller.chart;
  const close = () => controller.openPanel(null);
  return (
    <RulePanel title={tc.editor} closeLabel={tc.close} onClose={close}>
      {chart ? <ChartForm controller={controller} chart={chart} /> : <p className="text-sm text-muted-foreground">{tc.pickChart}</p>}
    </RulePanel>
  );
}

function ChartForm({ controller, chart }: { controller: SheetController; chart: Chart }) {
  const { t } = useI18n();
  const tc = t.weldsheets.charts;
  const save = (next: Chart) => saveChart(controller, next);
  const source = chartSourceOf(controller.engine, controller.activeSheetId, chart);
  const data = controller.chartData(chart);
  const pie = chart.type === 'pie' || chart.type === 'doughnut';
  // The category axis is the vertical one in a bar chart.
  const categoryAxis = chart.type === 'bar' ? tc.yAxisTitle : tc.xAxisTitle;
  const valueAxis = chart.type === 'bar' ? tc.xAxisTitle : tc.yAxisTitle;

  const setRange = (text: string) => {
    const at = parseDataRange(controller, text);
    if (!at) {
      toast.error(tc.rangeInvalid);
      return;
    }
    save(withRange(controller, chart, at, source ?? { seriesIn: 'columns', headers: true, labels: true }));
  };

  const setSource = (change: Partial<ChartSource>) => {
    if (source) save(withRange(controller, chart, source, { ...source, ...change }));
  };

  const setText = (key: 'title' | 'xTitle' | 'yTitle', text: string) => {
    const next: Chart = { ...chart };
    if (text.trim()) next[key] = text.trim();
    else delete next[key];
    save(next);
  };

  const setColor = (i: number, color: string | undefined) => {
    const series = chart.series.map((s, k) => {
      if (k !== i) return s;
      const next = { ...s };
      if (color) next.color = color;
      else delete next.color;
      return next;
    });
    save({ ...chart, series });
  };

  const byCols = source?.seriesIn !== 'rows';
  return (
    <div className="flex flex-col gap-4">
      <Field label={tc.type}>
        <Select value={variantOf(chart)} onValueChange={(v) => save(withVariant(chart, v as ChartVariant))}>
          <SelectTrigger className="h-8 w-full text-sm" aria-label={tc.type}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHART_VARIANTS.map((v) => (
              <SelectItem key={v} value={v}>
                {tc.types[v]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label={tc.dataRange}>
        <CommitInput label={tc.dataRange} value={source ? rangeLabel(controller, source) : ''} placeholder={tc.customSeries} onCommit={setRange} mono />
      </Field>
      {source && (
        <div className="flex flex-col gap-2">
          <CheckRow label={tc.switchRowsColumns} checked={!byCols} onChange={(on) => setSource({ seriesIn: on ? 'rows' : 'columns' })} />
          <CheckRow label={byCols ? tc.headersInRow : tc.headersInColumn} checked={source.headers} onChange={(headers) => setSource({ headers })} />
          <CheckRow label={byCols ? tc.labelsInColumn : tc.labelsInRow} checked={source.labels} onChange={(labels) => setSource({ labels })} />
        </div>
      )}

      {!pie && data.series.length > 0 && (
        <Field label={tc.series}>
          <ul className="flex flex-col gap-1.5">
            {data.series.map((s, i) => (
              <li key={`${i}:${s.name}`} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm">{s.name}</span>
                <ColorSelect label={tc.color} value={s.color} onChange={(color) => setColor(i, color)} none={tc.automatic} />
              </li>
            ))}
          </ul>
        </Field>
      )}

      <Field label={tc.title}>
        <CommitInput label={tc.title} value={chart.title ?? ''} onCommit={(text) => setText('title', text)} />
      </Field>
      {!pie && (
        <>
          <Field label={categoryAxis}>
            <CommitInput label={categoryAxis} value={chart.xTitle ?? ''} onCommit={(text) => setText('xTitle', text)} />
          </Field>
          <Field label={valueAxis}>
            <CommitInput label={valueAxis} value={chart.yTitle ?? ''} onCommit={(text) => setText('yTitle', text)} />
          </Field>
        </>
      )}
      <Field label={tc.legend}>
        <Select value={chart.legend ?? 'bottom'} onValueChange={(legend) => save({ ...chart, legend: legend as Legend })}>
          <SelectTrigger className="h-8 w-full text-sm" aria-label={tc.legend}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEGENDS.map((l) => (
              <SelectItem key={l} value={l}>
                {tc.legends[l]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Button variant="outline" size="sm" className="self-start" onClick={() => removeChart(controller, chart.id)}>
        <Trash2 />
        {tc.delete}
      </Button>
    </div>
  );
}

function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} />
      {label}
    </label>
  );
}
