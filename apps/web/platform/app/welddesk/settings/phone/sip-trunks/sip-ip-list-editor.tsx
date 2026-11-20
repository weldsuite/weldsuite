/**
 * The public IP addresses of a phone system, one row each (address and an
 * optional port), as the wizard and the manage dialog edit them.
 */

import { Plus, X } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { getTranslations } from '@/lib/i18n';
import { MAX_IPS, type SipFormError, type SipIpRow } from './sip-trunk-form';

export interface SipIpListEditorProps {
  rows: SipIpRow[];
  onChange: (rows: SipIpRow[]) => void;
  errors: readonly SipFormError[];
  disabled?: boolean;
}

export function SipIpListEditor({ rows, onChange, errors, disabled }: Readonly<SipIpListEditorProps>) {
  const t = getTranslations('deskSipTrunks').wizard;
  const update = (index: number, patch: Partial<SipIpRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const rowError = (index: number): string | null => {
    for (const error of errors) {
      if (error.kind === 'ip' && error.index === index) return t.errors.ipInvalid.replace('{ip}', error.ip);
      if (error.kind === 'port' && error.index === index) return t.errors.portInvalid;
    }
    return null;
  };

  return (
    <div className="space-y-2" data-testid="sip-ip-list">
      {rows.map((row, index) => {
        const message = rowError(index);
        return (
          // Rows have no identity of their own: their position is it.
          <div key={index} className="space-y-1">
            <div className="flex items-center gap-2">
              <Input
                value={row.ip}
                onChange={(e) => update(index, { ip: e.target.value })}
                placeholder={t.one.ipPlaceholder}
                aria-label={t.one.ipAddresses}
                inputMode="decimal"
                disabled={disabled}
                className="font-mono"
              />
              <Input
                value={row.port}
                onChange={(e) => update(index, { port: e.target.value })}
                placeholder={t.one.portPlaceholder}
                aria-label={t.one.portPlaceholder}
                inputMode="numeric"
                disabled={disabled}
                className="w-24 font-mono"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t.one.removeIp}
                disabled={disabled || rows.length <= 1}
                onClick={() => onChange(rows.filter((_, i) => i !== index))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {message && <InlineError>{message}</InlineError>}
          </div>
        );
      })}
      {errors.some((e) => e.kind === 'ipRequired') && <InlineError>{t.errors.ipRequired}</InlineError>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || rows.length >= MAX_IPS}
        onClick={() => onChange([...rows, { ip: '', port: '' }])}
      >
        <Plus className="mr-1.5 h-4 w-4" />
        {t.one.addIp}
      </Button>
    </div>
  );
}
