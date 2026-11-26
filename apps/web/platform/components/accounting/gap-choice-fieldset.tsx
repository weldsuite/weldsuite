/**
 * What happens to a gap between a bank transaction and the documents it is
 * matched to (edition feature `books-bank-links`): leave it (open, or as
 * credit for the contact) or book it to a ledger account. Shared by the
 * reconcile screen and the invoice/bill "Link bank transaction" dialog, which
 * pass their own wording.
 */
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { Account } from '@/lib/api/domains/weldbooks';
import type { GapChoice } from '@/lib/weldbooks/bank-link-math';

interface GapChoiceFieldsetProps {
  /** Prefix for the controls' ids. */
  idPrefix: string;
  legend: string;
  leaveLabel: string;
  accountChoiceLabel: string;
  choice: GapChoice;
  onChoiceChange: (choice: GapChoice) => void;
  accounts: Account[];
  accountId: string;
  onAccountChange: (accountId: string) => void;
  labels: { account: string; accountPlaceholder: string };
  /** Set while submitting refused the missing account; the id of the message that says so. */
  accountErrorId?: string;
}

export function GapChoiceFieldset({
  idPrefix,
  legend,
  leaveLabel,
  accountChoiceLabel,
  choice,
  onChoiceChange,
  accounts,
  accountId,
  onAccountChange,
  labels,
  accountErrorId,
}: Readonly<GapChoiceFieldsetProps>) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <RadioGroup value={choice} onValueChange={(value) => onChoiceChange(value as GapChoice)}>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-leave`} value="leave" />
          <Label htmlFor={`${idPrefix}-leave`} className="font-normal">
            {leaveLabel}
          </Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem id={`${idPrefix}-account`} value="account" />
          <Label htmlFor={`${idPrefix}-account`} className="font-normal">
            {accountChoiceLabel}
          </Label>
        </div>
      </RadioGroup>
      {choice === 'account' ? (
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-difference-account`}>{labels.account}</Label>
          <Select value={accountId} onValueChange={onAccountChange}>
            <SelectTrigger
              id={`${idPrefix}-difference-account`}
              className="w-full"
              aria-invalid={accountErrorId ? true : undefined}
              aria-describedby={accountErrorId}
            >
              <SelectValue placeholder={labels.accountPlaceholder} />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
    </fieldset>
  );
}
