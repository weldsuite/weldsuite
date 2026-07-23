
import { Link } from '@/lib/router';
import { Mail, Settings } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyStateIllustration } from '@/components/entity-list';
import { useAppApiClient } from '@/lib/api/use-app-api';
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '@/lib/i18n/provider';

interface HelpdeskEmailAddress {
  id: string;
  email: string;
  accountId: string;
  isActive: boolean;
}

export default function EmailInboxPage() {
  const { t } = useI18n();
  const ip = t.helpdesk.inboxPages;
  const { getClient } = useAppApiClient();

  const { data: addresses } = useQuery({
    queryKey: ['helpdesk', 'email', 'addresses'],
    queryFn: async () => {
      const client = await getClient();
      const res = await client.get<{ data: HelpdeskEmailAddress[] }>('/helpdesk-email/addresses');
      return res.data || [];
    },
    staleTime: 5 * 60 * 1000,
  });

  const activeAddresses = (addresses || []).filter(a => a.isActive);
  const hasConnectedEmail = activeAddresses.length > 0;

  // Still loading or has connected emails â€” show "no conversation selected"
  if (addresses === undefined || hasConnectedEmail) {
    return (
      <div className="h-full flex-1 flex flex-col items-center justify-center text-center px-6 bg-white dark:bg-background/30">
        <EmptyStateIllustration>
          <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="20" y="35" width="80" height="55" rx="4" className="fill-white dark:fill-white/[0.03]" />
            <rect x="20" y="35" width="80" height="55" rx="4" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" />
            <path d="M20 90L52 65" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" />
            <path d="M100 90L68 65" className="stroke-gray-100 dark:stroke-white/10" strokeWidth="1" />
            <path d="M20.5 38C20.5 36.3 21.8 35 23.5 35H96.5C98.2 35 99.5 36.3 99.5 38L60 64Z" className="fill-gray-50 dark:fill-white/[0.06]" />
            <path d="M20 35L60 64L100 35" className="stroke-gray-200 dark:stroke-white/15" strokeWidth="1" fill="none" />
          </svg>
        </EmptyStateIllustration>
        <h3 className="text-[15px] font-semibold text-foreground mb-1.5">{ip.noEmailSelectedTitle}</h3>
        <p className="text-sm text-muted-foreground max-w-[320px] leading-relaxed">{ip.noEmailSelectedDesc}</p>
      </div>
    );
  }

  // No email connected â€” show setup prompt
  return (
    <div className="bg-white dark:bg-background/30 flex flex-col h-full overflow-hidden flex-1 items-center justify-center">
      <Card className="w-full max-w-md border-dashed">
        <CardHeader className="text-center pb-2">
          <div className="w-12 h-12 rounded-full bg-blue-500 flex items-center justify-center mx-auto mb-2">
            <Mail className="h-6 w-6 text-white" />
          </div>
          <CardTitle className="text-lg">{ip.connectEmailTitle}</CardTitle>
          <CardDescription>
            {ip.connectEmailDesc}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-gray-50 dark:bg-background rounded-lg p-3">
            <p className="text-xs font-medium text-gray-700 dark:text-muted-foreground mb-2">{ip.howItWorksLabel}</p>
            <ol className="text-xs text-gray-600 dark:text-muted-foreground space-y-1.5 list-decimal list-inside">
              <li>{ip.howItWorksStep1}</li>
              <li>{ip.howItWorksStep2}</li>
              <li>{ip.howItWorksStep3}</li>
              <li>{ip.howItWorksStep4}</li>
            </ol>
          </div>
          <Button asChild className="w-full">
            <Link href="/welddesk/settings/integrations/email">
              <Settings className="h-4 w-4 mr-2" />
              {ip.setUpEmail}
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
