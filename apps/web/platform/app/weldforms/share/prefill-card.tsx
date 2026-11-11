import { useMemo, useState } from 'react';
import { Copy } from 'lucide-react';
import { fieldsOf } from '@weldsuite/forms-engine';
import type { FormDetail } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { useI18n } from '@/lib/i18n/provider';
import { buildPrefillUrl, cleanHidden, type HiddenFieldValue } from './embed-snippet';
import { KeyValueRows } from './key-value-rows';
import { useCopy } from './use-copy';

/** Names the form knows: its questions' references and its hidden fields. */
export function knownNames(form: FormDetail): string[] {
  const refs = fieldsOf(form.definition).map((field) => field.ref);
  const hidden = form.definition.hidden.map((h) => h.name);
  return [...new Set([...hidden, ...refs])];
}

export function PrefillCard({ form, shareable }: Readonly<{ form: FormDetail; shareable: boolean }>) {
  const { t } = useI18n();
  const ts = t.weldformsResults.share.prefill;
  const copy = useCopy();
  const [rows, setRows] = useState<HiddenFieldValue[]>([]);
  const suggestions = useMemo(() => knownNames(form), [form]);

  const url = shareable && form.publicUrl && cleanHidden(rows).length > 0 ? buildPrefillUrl(form.publicUrl, rows) : null;

  return (
    <SectionCard title={ts.title} description={ts.description}>
      <div className="space-y-4">
        <KeyValueRows
          rows={rows}
          onChange={setRows}
          suggestions={suggestions}
          labels={{
            name: ts.name,
            value: ts.value,
            namePlaceholder: ts.namePlaceholder,
            valuePlaceholder: ts.valuePlaceholder,
            add: ts.add,
            remove: ts.removeRow,
            suggestions: ts.suggestionsLabel,
          }}
        />
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{ts.result}</p>
          {url ? (
            <div className="flex items-start gap-2">
              <code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 p-2 text-xs">{url}</code>
              <Button type="button" variant="outline" size="icon" aria-label={t.weldformsResults.common.copy} onClick={() => void copy(url)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{ts.none}</p>
          )}
        </div>
      </div>
    </SectionCard>
  );
}
