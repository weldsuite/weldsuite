/**
 * The gallery's spec editor: the JSON of the visual being designed, checked
 * against the same schema the AI's tool calls go through, plus a few
 * controls for chart specs that rewrite the JSON.
 */

import { useMemo } from 'react';
import { CheckCircle2, Copy, RotateCcw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { CHART_KINDS, chatVisualSchema, type ChatVisual } from '@weldsuite/app-api-client/schemas/chat-visuals';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { getTranslations } from '@/lib/i18n';

export type SpecResult = { ok: true; visual: ChatVisual } | { ok: false; errors: string[] };

/** Parse and validate the editor's text. */
export function readSpec(text: string): SpecResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)] };
  }
  const parsed = chatVisualSchema.safeParse(json);
  if (parsed.success) return { ok: true, visual: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`),
  };
}

export function specText(visual: ChatVisual): string {
  return JSON.stringify(visual, null, 2);
}

interface SpecEditorProps {
  text: string;
  onChange: (text: string) => void;
  onReset: () => void;
}

export function SpecEditor({ text, onChange, onReset }: Readonly<SpecEditorProps>) {
  const t = getTranslations('common').ai.visuals.gallery;
  const result = useMemo(() => readSpec(text), [text]);
  const chart = result.ok && result.visual.type === 'chart' ? result.visual : null;

  const update = (patch: Record<string, unknown>) => {
    if (!result.ok) return;
    const next = { ...result.visual, ...patch } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete next[key];
    onChange(JSON.stringify(next, null, 2));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t.copied);
    } catch {
      // Clipboard refused (no focus or no permission): nothing to undo.
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t.spec}</p>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={onReset}>
            <RotateCcw className="size-3.5" />
            {t.reset}
          </Button>
          <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => void copy()}>
            <Copy className="size-3.5" />
            {t.copy}
          </Button>
        </div>
      </div>

      {chart && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border p-3">
          <div className="col-span-2 space-y-1.5">
            <Label className="text-xs">{t.controls.kind}</Label>
            <Select value={chart.kind} onValueChange={(kind) => update({ kind })}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHART_KINDS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t.kinds[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Label className="flex items-center gap-2 text-xs">
            <Switch checked={chart.stacked === true} onCheckedChange={(on) => update({ stacked: on || undefined })} />
            {t.controls.stacked}
          </Label>
          <Label className="flex items-center gap-2 text-xs">
            <Switch
              checked={chart.horizontal === true}
              disabled={chart.kind !== 'bar'}
              onCheckedChange={(on) => update({ horizontal: on || undefined })}
            />
            {t.controls.horizontal}
          </Label>
        </div>
      )}

      <Textarea
        value={text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        className="min-h-[320px] flex-1 resize-y font-mono text-xs leading-relaxed"
        aria-label={t.spec}
      />

      {result.ok ? (
        <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="size-3.5" />
          {t.valid}
        </p>
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <p className="mb-1 flex items-center gap-1.5 font-medium">
            <TriangleAlert className="size-3.5" />
            {t.invalid}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 font-mono">
            {result.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
