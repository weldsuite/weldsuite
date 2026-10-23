import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';

interface CopyFieldProps {
  label: string;
  value: string;
}

/** A read-only value (a DNS record, a URL for the identity provider) with a copy button. */
export function CopyField({ label, value }: Readonly<CopyFieldProps>) {
  const { t, format } = useI18n();
  const ts = t.settings.sso;
  const labelId = useId();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(ts.copyFailed);
    }
  };

  return (
    <div className="space-y-1.5">
      <span id={labelId} className="block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="flex items-stretch gap-2">
        {/* A focusable, selectable value that wraps instead of being cut off. */}
        <div
          role="textbox"
          aria-readonly="true"
          aria-labelledby={labelId}
          tabIndex={0}
          className="min-w-0 flex-1 select-all break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-[13px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {value}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-auto w-9 shrink-0 shadow-none"
          onClick={copy}
          aria-label={format(ts.copyLabel, { label })}
          title={copied ? ts.copied : ts.copy}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
