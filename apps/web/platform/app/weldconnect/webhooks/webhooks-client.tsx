
import { useState } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Label } from '@weldsuite/ui/components/label';
import {
  Webhook,
  Plus,
  Copy,
  Trash2,
  RefreshCw,
  Eye,
  EyeOff,
  CheckCircle,
  XCircle,
  Activity,
  Globe,
  Lock,
  RotateCw,
  ExternalLink,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCreateWebhook, useDeleteWebhook, useRotateWebhookSecret } from '@/hooks/queries/use-automation-queries';
import { Link } from '@/lib/router';

// The workflow-webhooks endpoint returns a loosely-typed record (no shared
// schema yet); this describes the fields the list view actually reads.
export interface WebhookView {
  id: string;
  name: string;
  isEnabled: boolean;
  workflowName?: string;
  createdAt: string;
  url: string;
  secret: string;
  totalCalls?: number;
  successfulCalls?: number;
  failedCalls?: number;
  lastCalledAt?: string | null;
}

interface WebhooksClientProps {
  webhooks: WebhookView[];
}

export function WebhooksClient({ webhooks: initialWebhooks }: WebhooksClientProps) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.weldconnect.breadcrumbs.task, href: '/weldconnect' },
    { label: t.weldconnect.breadcrumbs.webhooks },
  ]);

  const createWebhookMutation = useCreateWebhook();
  const deleteWebhookMutation = useDeleteWebhook();
  const rotateSecretMutation = useRotateWebhookSecret();
  const isPending = createWebhookMutation.isPending || deleteWebhookMutation.isPending || rotateSecretMutation.isPending;

  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newWebhookName, setNewWebhookName] = useState('');
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});

  const handleCreateWebhook = () => {
    if (!newWebhookName.trim()) {
      toast.error(t.weldconnect.webhooks.dialogs.nameRequired);
      return;
    }

    createWebhookMutation.mutate({ name: newWebhookName, workflowId: '' }, {
      onSuccess: () => {
        setShowCreateDialog(false);
        setNewWebhookName('');
        toast.success(t.weldconnect.webhooks.toasts.created);
      },
      onError: () => {
        toast.error(t.weldconnect.webhooks.toasts.createFailed);
      },
    });
  };

  const handleDeleteWebhook = (webhookId: string) => {
    if (!confirm(t.weldconnect.webhooks.confirms.delete)) {
      return;
    }

    deleteWebhookMutation.mutate(webhookId, {
      onSuccess: () => {
        toast.success(t.weldconnect.webhooks.toasts.deleted);
      },
      onError: () => {
        toast.error(t.weldconnect.webhooks.toasts.deleteFailed);
      },
    });
  };

  const handleRotateSecret = (webhookId: string, webhookName: string) => {
    if (!confirm(t.weldconnect.webhooks.confirms.rotateSecret.replace('{name}', webhookName))) {
      return;
    }

    rotateSecretMutation.mutate(webhookId, {
      onSuccess: () => {
        toast.success(t.weldconnect.webhooks.toasts.secretRotated);
      },
      onError: () => {
        toast.error(t.weldconnect.webhooks.toasts.secretRotateFailed);
      },
    });
  };

  const handleCopyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success(t.weldconnect.webhooks.toasts.urlCopied);
  };

  const handleCopySecret = (secret: string) => {
    navigator.clipboard.writeText(secret);
    toast.success(t.weldconnect.webhooks.toasts.secretCopied);
  };

  const toggleSecretVisibility = (webhookId: string) => {
    setShowSecret((prev) => ({ ...prev, [webhookId]: !prev[webhookId] }));
  };

  const activeWebhooks = initialWebhooks.filter((w) => w.isEnabled);
  const totalCalls = initialWebhooks.reduce((sum, w) => sum + (w.totalCalls || 0), 0);
  const successfulCalls = initialWebhooks.reduce((sum, w) => sum + (w.successfulCalls || 0), 0);
  const successRate = totalCalls > 0 ? Math.round((successfulCalls / totalCalls) * 100) : 0;

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 md:p-8 max-w-[1600px] space-y-6 md:space-y-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{t.weldconnect.webhooks.title}</h1>
          <p className="text-muted-foreground mt-1 md:mt-2 text-sm md:text-base">
            {t.weldconnect.webhooks.subtitle}
          </p>
        </div>
        <Button
          data-testid="page-header-action-create-webhook"
          onClick={() => setShowCreateDialog(true)}
          disabled={isPending}
          className="h-8 text-xs md:text-sm px-2 md:px-3"
        >
          <Plus className="h-4 w-4 mr-1 md:mr-2" />
          <span className="hidden sm:inline">{t.weldconnect.webhooks.createWebhook}</span>
          <span className="sm:hidden">{t.weldconnect.webhooks.add}</span>
        </Button>
      </div>

      {/* Stats */}
      <div className="grid gap-3 md:gap-4 grid-cols-2 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.webhooks.stats.totalWebhooks}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{initialWebhooks.length}</div>
            <p className="text-xs text-muted-foreground">
              {t.weldconnect.webhooks.stats.active.replace('{count}', String(activeWebhooks.length))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.webhooks.stats.totalCalls}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalCalls.toLocaleString()}</div>
            <p className="text-xs text-muted-foreground">{t.weldconnect.webhooks.stats.allTime}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.webhooks.stats.successRate}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{successRate}%</div>
            <p className="text-xs text-muted-foreground">
              {t.weldconnect.webhooks.stats.successful.replace('{count}', successfulCalls.toLocaleString())}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>{t.weldconnect.webhooks.stats.failedCalls}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {(totalCalls - successfulCalls).toLocaleString()}
            </div>
            <p className="text-xs text-muted-foreground">{t.weldconnect.webhooks.stats.allTime}</p>
          </CardContent>
        </Card>
      </div>

      {/* Webhooks List */}
      {initialWebhooks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Webhook className="h-12 w-12 text-muted-foreground/30 mb-4" />
            <h3 className="text-lg font-semibold mb-2">{t.weldconnect.webhooks.noWebhooks}</h3>
            <p className="text-sm text-muted-foreground mb-4 text-center max-w-md">
              {t.weldconnect.webhooks.noWebhooksDescription}
            </p>
            <Button onClick={() => setShowCreateDialog(true)} disabled={isPending}>
              <Plus className="h-4 w-4 mr-0.5" />
              {t.weldconnect.webhooks.createWebhook}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {initialWebhooks.map((webhook) => (
            <Card key={webhook.id} className="hover:shadow-md transition-shadow">
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-lg">{webhook.name}</CardTitle>
                      {webhook.isEnabled ? (
                        <Badge variant="default" className="bg-green-500">
                          <CheckCircle className="h-3 w-3 mr-1" />
                          {t.weldconnect.webhooks.statuses.active}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <XCircle className="h-3 w-3 mr-1" />
                          {t.weldconnect.webhooks.statuses.disabled}
                        </Badge>
                      )}
                      {webhook.workflowName && (
                        <Badge variant="outline" className="text-xs">
                          → {webhook.workflowName}
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="mt-1">
                      {t.weldconnect.webhooks.fields.createdAt} {new Date(webhook.createdAt).toLocaleDateString()}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-1">
                    <Link href={`/weldconnect/webhooks/${webhook.id}`}>
                      <Button variant="ghost" size="icon" title={t.weldconnect.webhooks.actions.viewDetails}>
                        <ExternalLink className="h-4 w-4" />
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDeleteWebhook(webhook.id)}
                      disabled={isPending}
                      title={t.weldconnect.webhooks.actions.delete}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 md:space-y-4 px-4 md:px-6">
                {/* URL */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-xs md:text-sm">
                    <Globe className="h-3.5 w-3.5 md:h-4 md:w-4" />
                    {t.weldconnect.webhooks.fields.url}
                  </Label>
                  <div className="flex gap-2">
                    <Input value={webhook.url} readOnly className="font-mono text-[10px] md:text-xs" />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleCopyUrl(webhook.url)}
                      title={t.weldconnect.webhooks.actions.copyUrl}
                      className="flex-shrink-0 h-8 w-8 md:h-9 md:w-9"
                    >
                      <Copy className="h-3.5 w-3.5 md:h-4 md:w-4" />
                    </Button>
                  </div>
                </div>

                {/* Secret */}
                <div className="space-y-2">
                  <Label className="flex items-center gap-2 text-xs md:text-sm">
                    <Lock className="h-3.5 w-3.5 md:h-4 md:w-4" />
                    {t.weldconnect.webhooks.webhookSecretLabel}
                  </Label>
                  <div className="flex gap-1 md:gap-2">
                    <Input
                      value={showSecret[webhook.id] ? webhook.secret : '••••••••••••••••'}
                      readOnly
                      className="font-mono text-[10px] md:text-xs"
                      type={showSecret[webhook.id] ? 'text' : 'password'}
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => toggleSecretVisibility(webhook.id)}
                      title={showSecret[webhook.id] ? t.weldconnect.webhooks.actions.hideSecret : t.weldconnect.webhooks.actions.showSecret}
                      className="flex-shrink-0 h-8 w-8 md:h-9 md:w-9"
                    >
                      {showSecret[webhook.id] ? (
                        <EyeOff className="h-3.5 w-3.5 md:h-4 md:w-4" />
                      ) : (
                        <Eye className="h-3.5 w-3.5 md:h-4 md:w-4" />
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleCopySecret(webhook.secret)}
                      title={t.weldconnect.webhooks.actions.copySecret}
                      className="flex-shrink-0 h-8 w-8 md:h-9 md:w-9"
                    >
                      <Copy className="h-3.5 w-3.5 md:h-4 md:w-4" />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      onClick={() => handleRotateSecret(webhook.id, webhook.name)}
                      disabled={isPending}
                      title={t.weldconnect.webhooks.actions.rotateSecret}
                      className="flex-shrink-0 h-8 w-8 md:h-9 md:w-9"
                    >
                      <RotateCw className="h-3.5 w-3.5 md:h-4 md:w-4" />
                    </Button>
                  </div>
                  <p className="text-[10px] md:text-xs text-muted-foreground">
                    {t.weldconnect.webhooks.secretValidationHint}
                  </p>
                </div>

                {/* Stats */}
                <div className="flex flex-wrap items-center gap-3 md:gap-6 pt-2 border-t">
                  <div className="flex items-center gap-1.5 md:gap-2">
                    <Activity className="h-3.5 w-3.5 md:h-4 md:w-4 text-muted-foreground" />
                    <div className="text-xs md:text-sm">
                      <span className="font-medium">{webhook.totalCalls || 0}</span>
                      <span className="text-muted-foreground"> {t.weldconnect.webhooks.stats.allTime}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 md:gap-2">
                    <CheckCircle className="h-3.5 w-3.5 md:h-4 md:w-4 text-green-500" />
                    <div className="text-xs md:text-sm">
                      <span className="font-medium">{webhook.successfulCalls || 0}</span>
                      <span className="text-muted-foreground hidden sm:inline"> {t.weldconnect.webhookDetail.stats.successful.toLowerCase()}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 md:gap-2">
                    <XCircle className="h-3.5 w-3.5 md:h-4 md:w-4 text-red-500" />
                    <div className="text-xs md:text-sm">
                      <span className="font-medium">{webhook.failedCalls || 0}</span>
                      <span className="text-muted-foreground hidden sm:inline"> {t.weldconnect.webhookDetail.stats.failed.toLowerCase()}</span>
                    </div>
                  </div>
                  {webhook.lastCalledAt && (
                    <div className="text-[10px] md:text-sm text-muted-foreground ml-auto">
                      {t.weldconnect.webhooks.stats.last}{new Date(webhook.lastCalledAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create Webhook Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.weldconnect.webhooks.dialogs.createTitle}</DialogTitle>
            <DialogDescription>
              {t.weldconnect.webhooks.dialogs.createDescription}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t.weldconnect.webhooks.dialogs.nameLabel}</Label>
              <Input
                id="name"
                placeholder={t.weldconnect.webhooks.dialogs.namePlaceholder}
                value={newWebhookName}
                onChange={(e) => setNewWebhookName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !isPending) {
                    handleCreateWebhook();
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)} disabled={isPending}>
              {t.weldconnect.webhooks.dialogs.cancel}
            </Button>
            <Button onClick={handleCreateWebhook} disabled={isPending}>
              {isPending ? (
                <>
                  <RefreshCw className="h-4 w-4 mr-0.5 animate-spin" />
                  {t.weldconnect.webhooks.dialogs.creating}
                </>
              ) : (
                <>
                  <Plus className="h-4 w-4 mr-0.5" />
                  {t.weldconnect.webhooks.dialogs.create}
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Usage Guide */}
      <Card>
        <CardHeader className="px-4 md:px-6">
          <CardTitle className="text-lg md:text-xl">{t.weldconnect.webhooks.usageGuide.title}</CardTitle>
          <CardDescription className="text-xs md:text-sm">
            {t.weldconnect.webhooks.usageGuide.description}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 md:space-y-4 px-4 md:px-6">
          <div className="space-y-3">
            <div className="flex gap-2 md:gap-3">
              <div className="flex h-5 w-5 md:h-6 md:w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] md:text-xs font-bold flex-shrink-0">
                1
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-sm md:text-base">{t.weldconnect.webhooks.usageGuide.step1Title}</h4>
                <p className="text-xs md:text-sm text-muted-foreground">
                  {t.weldconnect.webhooks.usageGuide.step1Desc}
                </p>
              </div>
            </div>
            <div className="flex gap-2 md:gap-3">
              <div className="flex h-5 w-5 md:h-6 md:w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] md:text-xs font-bold flex-shrink-0">
                2
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-sm md:text-base">{t.weldconnect.webhooks.usageGuide.step2Title}</h4>
                <p className="text-xs md:text-sm text-muted-foreground">
                  {t.weldconnect.webhooks.usageGuide.step2Desc}
                </p>
              </div>
            </div>
            <div className="flex gap-2 md:gap-3">
              <div className="flex h-5 w-5 md:h-6 md:w-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] md:text-xs font-bold flex-shrink-0">
                3
              </div>
              <div className="flex-1">
                <h4 className="font-semibold text-sm md:text-base">{t.weldconnect.webhooks.usageGuide.step3Title}</h4>
                <p className="text-xs md:text-sm text-muted-foreground">
                  {t.weldconnect.webhooks.usageGuide.step3Desc}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
      </div>
    </div>
  );
}
