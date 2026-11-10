/**
 * The numbers of one phone system: add, remove, and verify for outbound
 * caller id (a number is not offered as caller id until it is verified).
 */

import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { DeskSipTrunkNumber } from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { getTranslations } from '@/lib/i18n';
import {
  sipTrunkErrorCode,
  useAddDeskSipTrunkNumber,
  useRemoveDeskSipTrunkNumber,
} from '@/hooks/queries/use-desk-sip-trunk-queries';
import { SipNumberVerification } from './sip-number-verification';

export interface SipTrunkNumbersProps {
  trunkId: string;
  numbers: readonly DeskSipTrunkNumber[];
  canEdit: boolean;
}

export function SipTrunkNumbers({ trunkId, numbers, canEdit }: Readonly<SipTrunkNumbersProps>) {
  const t = getTranslations('deskSipTrunks').numbers;
  const [phoneNumber, setPhoneNumber] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<DeskSipTrunkNumber | null>(null);
  const add = useAddDeskSipTrunkNumber();
  const remove = useRemoveDeskSipTrunkNumber();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await add.mutateAsync({
        trunkId,
        input: { phoneNumber: phoneNumber.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) },
      });
      toast.success(t.added);
      setPhoneNumber('');
      setDisplayName('');
    } catch (err) {
      const code = sipTrunkErrorCode(err);
      setError(
        code === 'number_taken' ? t.errors.numberTaken : code === 'invalid_number' ? t.errors.invalidNumber : t.addFailed,
      );
    }
  };

  const removeNumber = async (number: DeskSipTrunkNumber) => {
    try {
      await remove.mutateAsync({ trunkId, numberId: number.id });
      toast.success(t.removed);
    } catch {
      toast.error(t.removeFailed);
    }
  };

  return (
    <div className="space-y-3" data-testid="sip-trunk-numbers">
      {numbers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.empty}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {numbers.map((number) => (
            <li key={number.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="sip-trunk-number">
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono font-medium">{number.phoneNumber}</span>
                  {number.displayName && <span className="text-sm text-muted-foreground">{number.displayName}</span>}
                </div>
                {number.callerIdVerifiedAt ? (
                  <SoftBadge tone="success">{t.verified}</SoftBadge>
                ) : (
                  <p className="text-xs text-muted-foreground">{t.notVerified}</p>
                )}
              </div>
              {canEdit && (
                <div className="flex gap-2">
                  {!number.callerIdVerifiedAt && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t.verifyFor.replace('{number}', number.phoneNumber)}
                      onClick={() => setVerifying(number)}
                    >
                      {t.verify}
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t.removeFor.replace('{number}', number.phoneNumber)}
                    disabled={remove.isPending}
                    onClick={() => void removeNumber(number)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <form onSubmit={(e) => void submit(e)} className="space-y-2">
          <div className="flex flex-wrap items-start gap-2">
            <Input
              value={phoneNumber}
              onChange={(e) => setPhoneNumber(e.target.value)}
              placeholder={t.phoneNumberPlaceholder}
              aria-label={t.phoneNumber}
              className="w-48 font-mono"
            />
            <Input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t.displayName}
              aria-label={t.displayName}
              className="w-48"
            />
            <Button type="submit" variant="outline" disabled={add.isPending || phoneNumber.trim() === ''}>
              {add.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {add.isPending ? t.adding : t.add}
            </Button>
          </div>
          {error && <InlineError>{error}</InlineError>}
        </form>
      )}

      <SipNumberVerification
        open={verifying !== null}
        onOpenChange={(open) => !open && setVerifying(null)}
        trunkId={trunkId}
        number={verifying}
      />
    </div>
  );
}
