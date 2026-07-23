
import { useState } from 'react';
import { useSearchParams } from '@/lib/router';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Button } from '@weldsuite/ui/components/button';
import { ArrowLeft } from 'lucide-react';
import { Link, useRouter } from '@/lib/router';
import { TicketTypeSelectorInline } from '@/components/welddesk/ticket-type-selector';
import { DynamicTicketForm } from '@/components/welddesk/dynamic-ticket-form';
import type { TicketTypeConfig } from '@/hooks/queries/use-helpdesk-queries';
import { useI18n } from '@/lib/i18n/provider';

export default function NewTicketPage() {
  const { t } = useI18n();
  const ti = t.helpdesk.inbox;
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedType, setSelectedType] = useState<TicketTypeConfig | null>(null);

  const prefillData = {
    subject: searchParams.get('subject') || undefined,
    customerEmail: searchParams.get('email') || undefined,
    customerName: searchParams.get('name') || undefined,
    description: searchParams.get('description') || undefined,
  };

  const handleSuccess = () => {
    router.push('/welddesk/tickets');
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="outline" size="sm" asChild>
          <Link href="/welddesk/tickets">
            <ArrowLeft className="h-4 w-4 mr-1" />
            {ti.backToTickets}
          </Link>
        </Button>
      </div>

      {!selectedType ? (
        <Card>
          <CardHeader>
            <CardTitle>{ti.createNewTicket}</CardTitle>
            <CardDescription>{ti.selectTicketTypeToGetStarted}</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <TicketTypeSelectorInline onSelect={setSelectedType} />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{ti.createNewTicket}</CardTitle>
            <CardDescription>
              {ti.createNewTicketDescription}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DynamicTicketForm
              ticketType={selectedType}
              onBack={() => setSelectedType(null)}
              onSuccess={handleSuccess}
              prefillData={prefillData}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
