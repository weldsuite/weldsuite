
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter, Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { useState } from 'react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Label } from '@weldsuite/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  ArrowLeft,
  Copy,
  Trash2,
  Globe,
  Lock,
  CheckCircle,
  XCircle,
  Activity,
  Calendar,
  Code,
  ExternalLink,
  Info,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useDeleteWebhook } from '@/hooks/queries/use-automation-queries';
import type { WebhookView } from '../webhooks-client';
import { buildWebhookCurl, deriveWebhookStatus, eventStatusTone, webhookDisplayName, type EventTone } from '../webhook-utils';
import { WebhookStatusBadge } from '../webhook-status-badge';
import { copyText } from '@/lib/clipboard';

export type WebhookDetail = WebhookView;

/** One call to the webhook: the workflow run it started. */
export interface WebhookEvent {
  id: string;
  status: string;
  createdAt: string;
  executionId?: string | null;
  error?: string | null;
}

interface WebhookDetailClientProps {
  webhook: WebhookDetail;
  initialEvents: WebhookEvent[];
}

const TONE_CLASSES: Record<EventTone, string> = {
  success: 'bg-green-500',
  failed: '',
  pending: 'bg-yellow-500',
  neutral: '',
};

function EventStatusBadge({ status, label }: Readonly<{ status: string; label: string }>) {
  const tone = eventStatusTone(status);
  if (tone === 'failed') return <Badge variant="destructive">{label}</Badge>;
  if (tone === 'neutral') return <Badge variant="outline">{label}</Badge>;
  return <Badge className={TONE_CLASSES[tone]}>{label}</Badge>;
}

function EventStatusIcon({ status }: Readonly<{ status: string }>) {
  const tone = eventStatusTone(status);
  if (tone === 'success') return <CheckCircle className="h-5 w-5 text-green-500" />;
  if (tone === 'failed') return <XCircle className="h-5 w-5 text-red-500" />;
  return <Activity className="h-5 w-5 text-yellow-500" />;
}

const formatDate = (date: string | Date) => new Date(date).toLocaleString();

export function WebhookDetailClient({ webhook, initialEvents }: Readonly<WebhookDetailClientProps>) {
  const { t } = useI18n();
  const wd = t.weldconnect.webhookDetail;
  const displayName = webhookDisplayName(webhook);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.connect, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.webhooks, href: '/weldconnect/webhooks' },
    { label: displayName },
  ]);

  const router = useRouter();
  const deleteWebhookMutation = useDeleteWebhook();
  const statusLabels = t.weldconnect.executions.statuses as Record<string, string>;
  const editorHref = `/weldconnect/workflows/${webhook.workflowId}/edit`;
  const curl = buildWebhookCurl(webhook.externalUrl, webhook);

  const handleDelete = async () => {
    try {
      await deleteWebhookMutation.mutateAsync(webhook.id);
      toast.success(wd.toasts.deleted);
      router.push('/weldconnect/webhooks');
    } catch {
      toast.error(wd.toasts.deleteFailed);
    } finally {
      setConfirmingDelete(false);
    }
  };

  const handleCopyUrl = () => {
    copyText(webhook.externalUrl, () => toast.success(wd.toasts.urlCopied));
  };

  const handleCopyCurl = () => {
    copyText(curl, () => toast.success(wd.toasts.curlCopied));
  };

  const totalCalls = webhook.totalCalls ?? 0;
  const successRate = totalCalls > 0
    ? Math.round(((webhook.successfulCalls ?? 0) / totalCalls) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-8 max-w-[1600px] space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link href="/weldconnect/webhooks">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-3">
                <Globe className="h-8 w-8 text-primary" />
                <h1 className="text-3xl font-bold tracking-tight">{displayName}</h1>
                <WebhookStatusBadge status={deriveWebhookStatus(webhook)} />
              </div>
              <p className="text-muted-foreground mt-2">
                {webhook.workflowName ? (
                  <>
                    {wd.triggersWorkflow.replace('{name}', '')}
                    <Link href={editorHref} className="hover:underline">{webhook.workflowName}</Link>
                  </>
                ) : (
                  wd.notConnected
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => router.push(editorHref)}>
              <WorkflowIcon className="h-4 w-4 mr-0.5" />
              {wd.openInEditor}
            </Button>
            {!webhook.isManaged && (
              <Button
                variant="destructive"
                onClick={() => setConfirmingDelete(true)}
                disabled={deleteWebhookMutation.isPending}
              >
                <Trash2 className="h-4 w-4 mr-0.5" />
                {wd.deleteButton}
              </Button>
            )}
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <p>{webhook.isManaged ? wd.managedNotice : wd.legacyNotice}</p>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                {wd.stats.totalCalls}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{totalCalls}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4" />
                {wd.stats.successful}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{webhook.successfulCalls ?? 0}</div>
              <p className="text-xs text-muted-foreground">{wd.stats.successRate.replace('{rate}', String(successRate))}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <XCircle className="h-4 w-4" />
                {wd.stats.failed}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{webhook.failedCalls ?? 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {wd.stats.lastCalled}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-sm font-medium">
                {webhook.lastCalledAt ? formatDate(webhook.lastCalledAt) : wd.stats.never}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>{wd.config.title}</CardTitle>
            <CardDescription>{wd.config.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* URL */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t.weldconnect.webhooks.fields.url}
              </Label>
              <div className="flex gap-2">
                <Input value={webhook.externalUrl} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={handleCopyUrl}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{wd.config.urlHint}</p>
            </div>

            {/* Signature */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                {wd.signature.title}
              </Label>
              <p className="text-sm">
                {webhook.validateSignature
                  ? wd.signature.required.replace('{header}', webhook.signatureHeader || 'x-webhook-signature')
                  : wd.signature.notRequired}
              </p>
              {webhook.isManaged && (
                <p className="text-xs text-muted-foreground">{wd.signature.manageHint}</p>
              )}
            </div>

            {/* Example Request */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Code className="h-4 w-4" />
                {wd.config.exampleCurl}
              </Label>
              <div className="bg-muted p-4 rounded-lg relative">
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute top-2 right-2"
                  onClick={handleCopyCurl}
                >
                  <Copy className="h-4 w-4" />
                </Button>
                <pre className="text-xs overflow-auto">{curl}</pre>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Events */}
        <Tabs defaultValue="events" className="space-y-6">
          <TabsList>
            <TabsTrigger value="events">{wd.tabEvents.replace('{count}', String(initialEvents.length))}</TabsTrigger>
            <TabsTrigger value="details">{wd.tabDetails}</TabsTrigger>
          </TabsList>

          {/* Events Tab */}
          <TabsContent value="events" className="space-y-4">
            {initialEvents.length > 0 ? (
              <div className="space-y-4">
                {initialEvents.map((event) => (
                  <Card key={event.id}>
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="flex items-center gap-2">
                            <EventStatusIcon status={event.status} />
                            <CardTitle className="text-base">{wd.events.webhookEvent}</CardTitle>
                            <EventStatusBadge status={event.status} label={statusLabels[event.status] ?? event.status} />
                          </div>
                          <CardDescription className="mt-1">
                            {formatDate(event.createdAt)}
                          </CardDescription>
                        </div>
                        {event.executionId && (
                          <Link href={`/weldconnect/executions/${event.executionId}`}>
                            <Button variant="ghost" size="sm">
                              <ExternalLink className="h-4 w-4 mr-0.5" />
                              {wd.events.viewExecution}
                            </Button>
                          </Link>
                        )}
                      </div>
                    </CardHeader>
                    {event.error && (
                      <CardContent className="pt-0">
                        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-3 border border-red-200 dark:border-red-800">
                          <p className="text-sm text-red-700 dark:text-red-300">{event.error}</p>
                        </div>
                      </CardContent>
                    )}
                  </Card>
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="flex flex-col items-center justify-center py-12">
                  <Activity className="h-12 w-12 text-muted-foreground/30 mb-4" />
                  <h3 className="text-lg font-semibold mb-2">{wd.events.noEvents}</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-md mb-4">
                    {wd.events.noEventsDescription}
                  </p>
                  <Button variant="outline" onClick={handleCopyCurl}>
                    <Copy className="h-4 w-4 mr-0.5" />
                    {wd.events.noEventsCta}
                  </Button>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Details Tab */}
          <TabsContent value="details">
            <Card>
              <CardHeader>
                <CardTitle>{wd.info.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{wd.info.webhookId}</p>
                    <p className="text-sm mt-1 font-mono">{webhook.id}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{wd.info.status}</p>
                    <div className="text-sm mt-1">
                      {webhook.isEnabled ? (
                        <Badge className="bg-green-500">{t.weldconnect.webhooks.statuses.active}</Badge>
                      ) : (
                        <Badge variant="secondary">{t.weldconnect.webhooks.statuses.disabled}</Badge>
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{wd.info.createdAt}</p>
                    <p className="text-sm mt-1">{formatDate(webhook.createdAt)}</p>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">{wd.info.updatedAt}</p>
                    <p className="text-sm mt-1">{formatDate(webhook.updatedAt)}</p>
                  </div>
                  {webhook.workflowName && (
                    <div className="col-span-2">
                      <p className="text-sm font-medium text-muted-foreground">{wd.info.connectedWorkflow}</p>
                      <p className="text-sm mt-1">
                        <Link href={editorHref} className="text-primary hover:underline">
                          {webhook.workflowName}
                        </Link>
                      </p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>

      <ConfirmDialog
        open={confirmingDelete}
        onOpenChange={setConfirmingDelete}
        title={wd.confirms.deleteTitle}
        description={wd.confirms.delete}
        confirmLabel={wd.deleteButton}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
