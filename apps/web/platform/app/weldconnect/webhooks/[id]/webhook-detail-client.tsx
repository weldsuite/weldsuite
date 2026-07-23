
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useRouter, Link } from '@/lib/router';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import { Label } from '@weldsuite/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  ArrowLeft,
  Copy,
  Eye,
  EyeOff,
  Trash2,
  RotateCw,
  Globe,
  Lock,
  CheckCircle,
  XCircle,
  Activity,
  Calendar,
  Code,
  RefreshCw,
  PlayCircle,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDeleteWebhook, useRotateWebhookSecret } from '@/hooks/queries/use-automation-queries';

interface WebhookDetailClientProps {
  webhook: any;
  initialEvents: any[];
}

const getStatusBadge = (status: string, labels: Record<string, string>) => {
  switch (status) {
    case 'success':
      return <Badge className="bg-green-500">{labels.success}</Badge>;
    case 'failed':
      return <Badge variant="destructive">{labels.failed}</Badge>;
    case 'pending':
      return <Badge className="bg-yellow-500">{labels.pending}</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
};

const formatDate = (date: string | Date) => {
  return new Date(date).toLocaleString();
};

export function WebhookDetailClient({ webhook, initialEvents }: WebhookDetailClientProps) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.webhooks, href: '/weldconnect/webhooks' },
    { label: webhook.name },
  ]);

  const router = useRouter();
  const deleteWebhookMutation = useDeleteWebhook();
  const rotateSecretMutation = useRotateWebhookSecret();
  const isPending = deleteWebhookMutation.isPending || rotateSecretMutation.isPending;
  const [showSecret, setShowSecret] = useState(false);
  const [selectedEvent, setSelectedEvent] = useState<any>(null);

  const handleDelete = () => {
    if (!confirm(t.weldconnect.webhookDetail.confirms.delete)) {
      return;
    }

    deleteWebhookMutation.mutate(webhook.id, {
      onSuccess: () => {
        toast.success(t.weldconnect.webhookDetail.toasts.deleted);
        router.push('/weldconnect/webhooks');
      },
      onError: () => {
        toast.error(t.weldconnect.webhookDetail.toasts.deleteFailed);
      },
    });
  };

  const handleRotateSecret = () => {
    if (!confirm(t.weldconnect.webhookDetail.confirms.rotateSecret)) {
      return;
    }

    rotateSecretMutation.mutate(webhook.id, {
      onSuccess: () => {
        toast.success(t.weldconnect.webhookDetail.toasts.secretRotated);
      },
      onError: () => {
        toast.error(t.weldconnect.webhookDetail.toasts.secretRotateFailed);
      },
    });
  };

  const handleCopyUrl = () => {
    navigator.clipboard.writeText(webhook.url);
    toast.success(t.weldconnect.webhookDetail.toasts.urlCopied);
  };

  const handleCopySecret = () => {
    navigator.clipboard.writeText(webhook.secret);
    toast.success(t.weldconnect.webhookDetail.toasts.secretCopied);
  };

  const handleCopyCurl = () => {
    const curlCommand = `curl -X POST ${webhook.url} \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Signature: ${webhook.secret}" \\
  -d '{"test": true}'`;
    navigator.clipboard.writeText(curlCommand);
    toast.success(t.weldconnect.webhookDetail.toasts.curlCopied);
  };

  const successRate = webhook.totalCalls > 0
    ? Math.round((webhook.successfulCalls / webhook.totalCalls) * 100)
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
                <h1 className="text-3xl font-bold tracking-tight">{webhook.name}</h1>
                {webhook.isEnabled ? (
                  <Badge className="bg-green-500">
                    <CheckCircle className="h-3 w-3 mr-1" />
                    {t.weldconnect.webhooks.statuses.active}
                  </Badge>
                ) : (
                  <Badge variant="secondary">
                    <XCircle className="h-3 w-3 mr-1" />
                    {t.weldconnect.webhooks.statuses.disabled}
                  </Badge>
                )}
              </div>
              <p className="text-muted-foreground mt-2">
                {webhook.workflowName ? (
                  <>
                    {t.weldconnect.webhookDetail.triggersWorkflow.replace('{name}', '')}
                    <Link href={`/weldconnect/workflows/${webhook.workflowId}`} className="hover:underline">{webhook.workflowName}</Link>
                  </>
                ) : (
                  t.weldconnect.webhookDetail.notConnected
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={handleRotateSecret}
              disabled={isPending}
            >
              <RotateCw className="h-4 w-4 mr-0.5" />
              {t.weldconnect.webhookDetail.rotateSecretButton}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={isPending}
            >
              <Trash2 className="h-4 w-4 mr-0.5 text-red-600 dark:text-red-400" />
              {t.weldconnect.webhookDetail.deleteButton}
            </Button>
          </div>
        </div>

        {/* Stats Cards */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Activity className="h-4 w-4" />
                {t.weldconnect.webhookDetail.stats.totalCalls}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{webhook.totalCalls || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <CheckCircle className="h-4 w-4" />
                {t.weldconnect.webhookDetail.stats.successful}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">{webhook.successfulCalls || 0}</div>
              <p className="text-xs text-muted-foreground">{t.weldconnect.webhookDetail.stats.successRate.replace('{rate}', String(successRate))}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <XCircle className="h-4 w-4" />
                {t.weldconnect.webhookDetail.stats.failed}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-red-600">{webhook.failedCalls || 0}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription className="flex items-center gap-2">
                <Calendar className="h-4 w-4" />
                {t.weldconnect.webhookDetail.stats.lastCalled}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="text-sm font-medium">
                {webhook.lastCalledAt ? formatDate(webhook.lastCalledAt) : t.weldconnect.webhookDetail.stats.never}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Configuration */}
        <Card>
          <CardHeader>
            <CardTitle>{t.weldconnect.webhookDetail.config.title}</CardTitle>
            <CardDescription>{t.weldconnect.webhookDetail.config.description}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* URL */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Globe className="h-4 w-4" />
                {t.weldconnect.webhooks.fields.url}
              </Label>
              <div className="flex gap-2">
                <Input value={webhook.url} readOnly className="font-mono text-xs" />
                <Button variant="outline" size="icon" onClick={handleCopyUrl}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t.weldconnect.webhookDetail.config.urlHint}
              </p>
            </div>

            {/* Secret */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Lock className="h-4 w-4" />
                {t.weldconnect.webhooks.webhookSecretLabel}
              </Label>
              <div className="flex gap-2">
                <Input
                  value={showSecret ? webhook.secret : '••••••••••••••••'}
                  readOnly
                  className="font-mono text-xs"
                  type={showSecret ? 'text' : 'password'}
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowSecret(!showSecret)}
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button variant="outline" size="icon" onClick={handleCopySecret}>
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t.weldconnect.webhookDetail.config.secretHint}
              </p>
            </div>

            {/* Example Request */}
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Code className="h-4 w-4" />
                {t.weldconnect.webhookDetail.config.exampleCurl}
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
                <pre className="text-xs overflow-auto">
{`curl -X POST ${webhook.url} \\
  -H "Content-Type: application/json" \\
  -H "X-Webhook-Signature: ${showSecret ? webhook.secret : '••••••••••••••••'}" \\
  -d '{"test": true}'`}
                </pre>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Events */}
        <Tabs defaultValue="events" className="space-y-6">
          <TabsList>
            <TabsTrigger value="events">{t.weldconnect.webhookDetail.tabEvents.replace('{count}', String(initialEvents.length))}</TabsTrigger>
            <TabsTrigger value="details">{t.weldconnect.webhookDetail.tabDetails}</TabsTrigger>
          </TabsList>

          {/* Events Tab */}
          <TabsContent value="events" className="space-y-4">
            {initialEvents.length > 0 ? (
              <div className="space-y-4">
                {initialEvents.map((event: any) => (
                  <Card
                    key={event.id}
                    className={`hover:shadow-md transition-shadow cursor-pointer ${
                      selectedEvent?.id === event.id ? 'ring-2 ring-primary' : ''
                    }`}
                    onClick={() => setSelectedEvent(event)}
                  >
                    <CardHeader>
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              {event.status === 'success' ? (
                                <CheckCircle className="h-5 w-5 text-green-500" />
                              ) : event.status === 'failed' ? (
                                <XCircle className="h-5 w-5 text-red-500" />
                              ) : (
                                <Activity className="h-5 w-5 text-yellow-500" />
                              )}
                              <CardTitle className="text-base">{t.weldconnect.webhookDetail.events.webhookEvent}</CardTitle>
                              {getStatusBadge(event.status, t.weldconnect.webhookDetail.eventStatuses)}
                            </div>
                            <CardDescription className="mt-1">
                              {formatDate(event.createdAt)}
                            </CardDescription>
                          </div>
                        </div>
                        {event.executionId && (
                          <Link href={`/weldconnect/executions/${event.executionId}`}>
                            <Button variant="ghost" size="sm">
                              <ExternalLink className="h-4 w-4 mr-0.5" />
                              {t.weldconnect.webhookDetail.events.viewExecution}
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
                  <h3 className="text-lg font-semibold mb-2">{t.weldconnect.webhookDetail.events.noEvents}</h3>
                  <p className="text-sm text-muted-foreground text-center max-w-md mb-4">
                    {t.weldconnect.webhookDetail.events.noEventsDescription}
                  </p>
                  <Button variant="outline" onClick={handleCopyCurl}>
                    <Copy className="h-4 w-4 mr-0.5" />
                    {t.weldconnect.webhookDetail.events.noEventsCta}
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Selected Event Detail */}
            {selectedEvent && (
              <Card className="border-primary">
                <CardHeader>
                  <CardTitle>{t.weldconnect.webhookDetail.events.eventDetails}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div>
                    <h4 className="text-sm font-semibold mb-2">{t.weldconnect.webhookDetail.events.payload}</h4>
                    <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-64">
                      {JSON.stringify(selectedEvent.payload, null, 2)}
                    </pre>
                  </div>
                  {selectedEvent.headers && (
                    <div>
                      <h4 className="text-sm font-semibold mb-2">{t.weldconnect.webhookDetail.events.headers}</h4>
                      <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-64">
                        {JSON.stringify(selectedEvent.headers, null, 2)}
                      </pre>
                    </div>
                  )}
                  {selectedEvent.response && (
                    <div>
                      <h4 className="text-sm font-semibold mb-2">{t.weldconnect.webhookDetail.events.response}</h4>
                      <pre className="bg-muted p-4 rounded-lg text-xs overflow-auto max-h-64">
                        {JSON.stringify(selectedEvent.response, null, 2)}
                      </pre>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* Details Tab */}
          <TabsContent value="details">
            <Card>
              <CardHeader>
                <CardTitle>{t.weldconnect.webhookDetail.info.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">{t.weldconnect.webhookDetail.info.webhookId}</label>
                    <p className="text-sm mt-1 font-mono">{webhook.id}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">{t.weldconnect.webhookDetail.info.status}</label>
                    <p className="text-sm mt-1">
                      {webhook.isEnabled ? (
                        <Badge className="bg-green-500">{t.weldconnect.webhooks.statuses.active}</Badge>
                      ) : (
                        <Badge variant="secondary">{t.weldconnect.webhooks.statuses.disabled}</Badge>
                      )}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">{t.weldconnect.webhookDetail.info.createdAt}</label>
                    <p className="text-sm mt-1">{formatDate(webhook.createdAt)}</p>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-muted-foreground">{t.weldconnect.webhookDetail.info.updatedAt}</label>
                    <p className="text-sm mt-1">{formatDate(webhook.updatedAt)}</p>
                  </div>
                  {webhook.workflowId && (
                    <div className="col-span-2">
                      <label className="text-sm font-medium text-muted-foreground">{t.weldconnect.webhookDetail.info.connectedWorkflow}</label>
                      <p className="text-sm mt-1">
                        <Link href={`/weldconnect/workflows/${webhook.workflowId}`} className="text-primary hover:underline">
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
    </div>
  );
}
