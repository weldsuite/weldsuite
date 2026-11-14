/**
 * Integrations tab: WeldCRM, WeldDesk and WeldFlow actions that run on every
 * response (with field mapping and a test run), plus pointers to WeldConnect and
 * webhooks, which already have the form response events.
 */

import { useParams } from '@tanstack/react-router';
import { ShieldOff, Webhook, Workflow } from 'lucide-react';
import type { FormDetail, FormIntegrationKind } from '@weldsuite/app-api-client/schemas/weldforms';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { useFormIntegrations } from '@/hooks/queries/use-weldforms-results-queries';
import { FormGate, FormTabFrame } from '../results/form-gate';
import { CrmCard } from './crm-card';
import { DeskCard } from './desk-card';
import { FlowCard } from './flow-card';

export default function IntegrationsTabPage() {
  const { formId = '' } = useParams({ strict: false });
  return <FormGate formId={formId}>{(form) => <IntegrationsContent key={form.id} form={form} />}</FormGate>;
}

function IntegrationsContent({ form }: Readonly<{ form: FormDetail }>) {
  const { t } = useI18n();
  const ti = t.weldformsResults.integrations;
  const query = useFormIntegrations(form.id);

  if (!form.permissions.edit) {
    return (
      <FormTabFrame>
        <EmptyState icon={ShieldOff} title={ti.noAccessTitle} description={ti.noAccessDescription} />
      </FormTabFrame>
    );
  }
  if (query.isLoading) return <PageLoader fullScreen={false} />;
  if (query.error || !query.data) {
    return (
      <FormTabFrame>
        <ErrorState message={t.weldformsResults.common.loadFailed} onRetry={() => void query.refetch()} />
      </FormTabFrame>
    );
  }

  const byKind = (kind: FormIntegrationKind) => query.data.find((integration) => integration.kind === kind) ?? null;
  const crm = byKind('crm');
  const desk = byKind('desk');
  const flow = byKind('flow');

  return (
    <FormTabFrame>
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{ti.title}</h2>
        <p className="text-sm text-muted-foreground">{ti.description}</p>
      </div>

      {/* Keyed by what was saved, so the form state restarts from the saved config after a save. */}
      <CrmCard key={`crm-${crm?.id}-${crm?.updatedAt}`} form={form} integration={crm} />
      <DeskCard key={`desk-${desk?.id}-${desk?.updatedAt}`} form={form} integration={desk} />
      <FlowCard key={`flow-${flow?.id}-${flow?.updatedAt}`} form={form} integration={flow} />

      <div className="grid gap-4 md:grid-cols-2">
        <LinkCard icon={Workflow} title={ti.connect.title} description={ti.connect.description} href="/weldconnect" action={ti.connect.open} />
        <LinkCard icon={Webhook} title={ti.webhooks.title} description={ti.webhooks.description} href="/settings/webhooks" action={ti.webhooks.open} />
      </div>
    </FormTabFrame>
  );
}

function LinkCard({
  icon: Icon,
  title,
  description,
  href,
  action,
}: Readonly<{ icon: React.ComponentType<{ className?: string }>; title: string; description: string; href: string; action: string }>) {
  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <Link href={href}>{action}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
