/**
 * A read-only value with a copy button (a SIP host, a username, the password).
 */

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { getTranslations } from '@/lib/i18n';

export interface CopyFieldProps {
  label: string;
  value: string;
  /** A value shown once (the password): set in bold. */
  emphasis?: boolean;
  testId?: string;
}

export function CopyField({ label, value, emphasis = false, testId }: Readonly<CopyFieldProps>) {
  const t = getTranslations('deskSipTrunks').details;
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(t.copied);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t.copyFailed);
    }
  };

  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code
          className={`min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-1.5 font-mono text-sm ${emphasis ? 'font-semibold' : ''}`}
          data-testid={testId}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void copy()}
          aria-label={t.copyLabel.replace('{label}', label)}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          <span className="ml-1.5">{t.copy}</span>
        </Button>
      </div>
    </div>
  );
}
