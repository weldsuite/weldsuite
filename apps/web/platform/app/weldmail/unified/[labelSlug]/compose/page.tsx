
import { useState, useEffect } from 'react';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { mailApi } from '../../../lib/api-client';
import type { Mail } from '@/lib/api/types/apps/mail.types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import ComposePage from '../../../[accountId]/[labelSlug]/compose/page';

export default function UnifiedComposePage() {
  const { t } = useI18n();
  const params = useParams();
  const labelSlug = params?.labelSlug as string;
  const [accounts, setAccounts] = useState<Mail.EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');

  useEffect(() => {
    mailApi.accounts.list().then((result) => {
      if (result.success && result.data) {
        setAccounts(result.data);
        if (result.data.length === 1) {
          setSelectedAccountId(result.data[0].id);
        }
      }
      setLoading(false);
    });
  }, []);

  if (loading) return <PageLoader fullScreen={false} />;

  if (selectedAccountId) {
    return (
      <ComposePage
        accountId={selectedAccountId}
        labelSlug={labelSlug}
        returnUrl={`/weldmail/unified/${labelSlug}`}
      />
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <p className="text-sm text-muted-foreground">{t.mail.unifiedCompose.selectAccountToCompose}</p>
      <Select onValueChange={setSelectedAccountId}>
        <SelectTrigger className="w-[300px]">
          <SelectValue placeholder={t.mail.unifiedCompose.chooseAccount} />
        </SelectTrigger>
        <SelectContent>
          {accounts.map((acc) => (
            <SelectItem key={acc.id} value={acc.id}>
              {acc.displayName || acc.email}
              {acc.displayName && <span className="ml-2 text-muted-foreground">{acc.email}</span>}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
