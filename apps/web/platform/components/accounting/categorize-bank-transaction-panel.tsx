import { useMemo, useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { BookmarkPlus } from 'lucide-react';
import type { Account } from '@/lib/api/domains/weldbooks';

const CATEGORY_TYPES = new Set(['revenue', 'expense', 'equity']);

export function ledgerCategoryAccounts(accounts: Account[]): Account[] {
  return accounts
    .filter((a) => a.isActive !== false && CATEGORY_TYPES.has(a.type))
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
}

interface CategorizeBankTransactionPanelProps {
  accounts: Account[];
  pending?: boolean;
  errorMessage?: string | null;
  labels: {
    title: string;
    hint: string;
    accountLabel: string;
    accountPlaceholder: string;
    button: string;
    examples: string;
  };
  onCategorize: (categoryAccountId: string) => void;
}

export function CategorizeBankTransactionPanel({
  accounts,
  pending,
  errorMessage,
  labels,
  onCategorize,
}: CategorizeBankTransactionPanelProps) {
  const [categoryAccountId, setCategoryAccountId] = useState('');
  const options = useMemo(() => ledgerCategoryAccounts(accounts), [accounts]);

  return (
    <div className="space-y-3 border-t pt-3">
      <div>
        <p className="text-sm font-medium">{labels.title}</p>
        <p className="text-xs text-muted-foreground mt-1">{labels.hint}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="categorize-account">{labels.accountLabel}</Label>
        <Select value={categoryAccountId} onValueChange={setCategoryAccountId}>
          <SelectTrigger id="categorize-account" data-testid="categorize-account">
            <SelectValue placeholder={labels.accountPlaceholder} />
          </SelectTrigger>
          <SelectContent>
            {options.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.code} — {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{labels.examples}</p>
      </div>
      {errorMessage ? (
        <p className="text-sm text-destructive" data-testid="categorize-error">{errorMessage}</p>
      ) : null}
      <Button
        size="sm"
        data-testid="categorize-transaction"
        onClick={() => onCategorize(categoryAccountId)}
        disabled={!categoryAccountId || pending}
      >
        <BookmarkPlus className="h-4 w-4 mr-1" />
        {labels.button}
      </Button>
    </div>
  );
}
