/**
 * A code snippet with a copy button: the script tag and the npm commands on
 * the install page. The snippet scrolls sideways instead of wrapping, so it
 * stays pasteable exactly as shown.
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';

interface CopyBlockProps {
  title: string;
  description?: string;
  value: string;
}

export function CopyBlock({ title, description, value }: Readonly<CopyBlockProps>) {
  const { t, format } = useI18n();
  const ti = t.weldpanel.install;
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(ti.copyFailed);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={titleId} className="text-sm font-medium">
            {title}
          </h3>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void copy()} aria-label={format(ti.copyLabel, { label: title })}>
          {copied ? <Check className="text-emerald-600" /> : <Copy />}
          {copied ? ti.copied : ti.copy}
        </Button>
      </div>
      {/* A focusable, selectable region, so the snippet can be read and selected without a mouse. */}
      <pre
        role="region"
        tabIndex={0}
        aria-labelledby={titleId}
        className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[13px] leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <code>{value}</code>
      </pre>
    </div>
  );
}
