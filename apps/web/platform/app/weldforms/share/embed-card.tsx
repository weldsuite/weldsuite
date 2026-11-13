import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import {
  DEFAULT_EMBED_CONFIG,
  EMBED_MODES,
  EMBED_SIZES,
  EMBED_TRIGGERS,
  buildEmbedSnippet,
  buildEmbedUrl,
  hasButton,
  hasSize,
  hasTrigger,
  portalOrigin,
  type EmbedConfig,
  type EmbedMode,
  type EmbedSize,
  type EmbedTrigger,
} from './embed-snippet';
import { KeyValueRows } from './key-value-rows';
import { knownNames } from './prefill-card';
import { useCopy } from './use-copy';

export function EmbedCard({ form, shareable }: Readonly<{ form: FormDetail; shareable: boolean }>) {
  const { t } = useI18n();
  const ts = t.weldformsResults.share.embed;
  const copy = useCopy();
  const [config, setConfig] = useState<EmbedConfig>(DEFAULT_EMBED_CONFIG);
  const patch = (next: Partial<EmbedConfig>) => setConfig((current) => ({ ...current, ...next }));

  const origin = portalOrigin(form.publicUrl);
  const publicId = form.publicId;
  const ready = shareable && origin !== null && publicId !== null;
  const snippet = ready ? buildEmbedSnippet(origin, publicId, config) : '';
  const previewUrl = ready ? buildEmbedUrl(origin, publicId, config) : null;
  const suggestions = useMemo(() => knownNames(form), [form]);

  const showButtonText = hasButton(config) || config.mode === 'popover';
  const hiddenLabels = t.weldformsResults.share.prefill;

  return (
    <SectionCard title={ts.title} description={ts.description}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="embed-mode">{ts.mode}</Label>
            <Select value={config.mode} onValueChange={(value) => patch({ mode: value as EmbedMode })}>
              <SelectTrigger id="embed-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EMBED_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {ts.modes[mode]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{ts.modeHints[config.mode]}</p>
          </div>

          {hasSize(config.mode) && (
            <div className="space-y-1.5">
              <Label htmlFor="embed-size">{ts.size}</Label>
              <Select value={config.size} onValueChange={(value) => patch({ size: value as EmbedSize })}>
                <SelectTrigger id="embed-size">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMBED_SIZES.map((size) => (
                    <SelectItem key={size} value={size}>
                      {ts.sizes[size]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {hasTrigger(config.mode) && (
            <div className="space-y-1.5">
              <Label htmlFor="embed-trigger">{ts.trigger}</Label>
              <Select value={config.trigger} onValueChange={(value) => patch({ trigger: value as EmbedTrigger })}>
                <SelectTrigger id="embed-trigger">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EMBED_TRIGGERS.map((trigger) => (
                    <SelectItem key={trigger} value={trigger}>
                      {ts.triggers[trigger]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {hasTrigger(config.mode) && config.trigger === 'scroll' && (
            <div className="space-y-1.5">
              <Label htmlFor="embed-scroll">{ts.scrollPercent}</Label>
              <Input
                id="embed-scroll"
                type="number"
                min={1}
                max={100}
                value={config.scrollPercent}
                onChange={(e) => patch({ scrollPercent: Number(e.target.value) })}
              />
            </div>
          )}

          {config.mode === 'inline' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="embed-auto-height">{ts.autoHeight}</Label>
                <Switch id="embed-auto-height" checked={config.autoHeight} onCheckedChange={(v) => patch({ autoHeight: v })} />
              </div>
              {!config.autoHeight && (
                <div className="space-y-1.5">
                  <Label htmlFor="embed-height">{ts.height}</Label>
                  <Input
                    id="embed-height"
                    type="number"
                    min={200}
                    value={config.height}
                    onChange={(e) => patch({ height: Number(e.target.value) })}
                  />
                </div>
              )}
            </div>
          )}

          {showButtonText && (
            <div className="space-y-1.5">
              <Label htmlFor="embed-button-text">{ts.buttonText}</Label>
              <Input
                id="embed-button-text"
                value={config.buttonText}
                maxLength={60}
                onChange={(e) => patch({ buttonText: e.target.value })}
              />
            </div>
          )}

          {showButtonText && (
            <div className="space-y-1.5">
              <Label htmlFor="embed-button-color">{ts.buttonColor}</Label>
              <Input
                id="embed-button-color"
                type="color"
                value={config.buttonColor}
                onChange={(e) => patch({ buttonColor: e.target.value })}
                className="h-9 w-16 cursor-pointer p-1"
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="embed-hide">{ts.hideAfterSubmit}</Label>
            <Switch id="embed-hide" checked={config.hideAfterSubmit} onCheckedChange={(v) => patch({ hideAfterSubmit: v })} />
          </div>

          <div className="space-y-2">
            <div>
              <p className="text-sm font-medium">{ts.hiddenTitle}</p>
              <p className="text-xs text-muted-foreground">{ts.hiddenDescription}</p>
            </div>
            <KeyValueRows
              rows={config.hidden}
              onChange={(hidden) => patch({ hidden })}
              suggestions={form.definition.hidden.map((h) => h.name).length > 0 ? form.definition.hidden.map((h) => h.name) : suggestions}
              labels={{
                name: hiddenLabels.name,
                value: hiddenLabels.value,
                namePlaceholder: hiddenLabels.namePlaceholder,
                valuePlaceholder: hiddenLabels.valuePlaceholder,
                add: hiddenLabels.add,
                remove: hiddenLabels.removeRow,
                suggestions: hiddenLabels.suggestionsLabel,
              }}
            />
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="space-y-2">
            <p className="text-sm font-medium">{ts.previewTitle}</p>
            {previewUrl ? (
              <div className="overflow-hidden rounded-lg border bg-background">
                <iframe
                  key={previewUrl}
                  src={previewUrl}
                  title={ts.previewFrameTitle}
                  className="h-[420px] w-full"
                  loading="lazy"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                />
              </div>
            ) : (
              <div className="flex h-[200px] items-center justify-center rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                {ts.previewUnavailable}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{ts.previewNote}</p>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{ts.snippetTitle}</p>
              <Button type="button" variant="outline" size="sm" disabled={!ready} onClick={() => void copy(snippet, ts.snippetCopied)}>
                <Copy className="mr-1.5 h-4 w-4" />
                {ts.snippetCopy}
              </Button>
            </div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/40 p-3 text-xs">
              <code>{snippet || ts.previewUnavailable}</code>
            </pre>
            <p className="text-xs text-muted-foreground">{ts.domainsHint}</p>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
