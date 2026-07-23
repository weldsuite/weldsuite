
import React, { useState } from 'react';
import { useRouter } from '@/lib/router';
import { useInstallApp, useUninstallApp, type AvailableApp } from '@/hooks/queries/use-settings-queries';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { Loader2, Globe, FileText, Mail, CheckCircle, Calendar, ChevronLeft, TrendingUp, Headphones, MessageSquare, CheckSquare, Server, Calculator, Layers, Info, type LucideIcon } from 'lucide-react';
import { getAppLogo, getAppLucideIcon } from '@/lib/apps/app-registry';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';

function AppLogo({ code, className = 'h-7 w-7' }: { code: string; className?: string }) {
  const logoPath = getAppLogo(code, 'light');
  if (logoPath) {
    return <img src={logoPath} alt={code} className={cn(className, 'object-contain')} />;
  }
  const Icon = getAppLucideIcon(code);
  return <Icon className={className} />;
}

interface AppContent {
  overview: string | null;
  features: string[];
  version: string;
  releasedAt: string | null;
}

interface AppDetailClientProps {
  app: AvailableApp;
  canManage?: boolean;
  content: AppContent;
}


function getCategoryIcon(category: string): LucideIcon {
  const c = category.toLowerCase();
  if (c.includes('sales') || c.includes('marketing') || c.includes('crm') || c.includes('commerce') || c === 'customers') return TrendingUp;
  if (c.includes('customer support') || c.includes('helpdesk') || (c.includes('support') && !c.includes('chat'))) return Headphones;
  if (c.includes('communication') || c.includes('mail') || c.includes('chat') || c.includes('meet') || c.includes('email')) return MessageSquare;
  if (c.includes('productivity') || c.includes('project') || c.includes('task') || c.includes('calendar') || c === 'work') return CheckSquare;
  if (c.includes('infrastructure') || c.includes('host') || c.includes('storage') || c.includes('drive') || c.includes('domain')) return Server;
  if (c.includes('finance') || c.includes('accounting') || c.includes('books') || c.includes('billing')) return Calculator;
  return Layers;
}

function formatReleaseDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function AppDetailClient({ app: initialApp, canManage = false, content }: AppDetailClientProps) {
  const t = getTranslations('navigation');
  const router = useRouter();
  const [app, setApp] = useState(initialApp);
  const [isLoading, setIsLoading] = useState(false);
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);
  const [assignToAllMembers, setAssignToAllMembers] = useState(false);

  const installApp = useInstallApp();
  const uninstallApp = useUninstallApp();

  const overview = content.overview || t.appstore.defaultOverview;
  const releasedLabel = formatReleaseDate(content.releasedAt);
  const versionLabel = releasedLabel ? `${content.version} (${releasedLabel})` : content.version;
  const resources = [
    app.websiteUrl ? { label: t.appstore.resourceWebsite, href: app.websiteUrl, icon: Globe } : null,
    app.documentationUrl ? { label: t.appstore.resourceDocumentation, href: app.documentationUrl, icon: FileText } : null,
    app.contactUrl
      ? {
          label: app.contactUrl.replace(/^mailto:/i, ''),
          href: app.contactUrl,
          icon: Mail,
        }
      : null,
  ].filter((r): r is { label: string; href: string; icon: typeof Globe } => r !== null);

  async function handleInstall() {
    try {
      setIsLoading(true);
      await installApp.mutateAsync({ appCode: app.code, assignToAllMembers });
      setApp((prev) => ({ ...prev, isInstalled: true }));
      toast.success(t.appstore.installSuccess.replace('{name}', app.name));
    } catch (error) {
      console.error('Failed to install app:', error);
      toast.error(error instanceof Error ? error.message : t.appstore.installError);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleUninstall() {
    try {
      setIsLoading(true);
      setShowUninstallDialog(false);
      await uninstallApp.mutateAsync(app.code);
      setApp((prev) => ({ ...prev, isInstalled: false }));
      toast.success(t.appstore.uninstallSuccess.replace('{name}', app.name));
    } catch (error) {
      console.error('Failed to uninstall app:', error);
      toast.error(t.appstore.uninstallError);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* Back Link */}
          <Button
            type="button"
            variant="ghost"
            onClick={() => router.push('/appstore')}
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-8"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            {t.appstore.back}
          </Button>

          {/* Header */}
          <div className="flex items-start justify-between mb-8">
            <div className="flex items-start gap-4">
              {/* App Icon */}
              <div className="w-14 h-14 rounded-xl bg-white dark:bg-background border border-gray-200 dark:border-border flex items-center justify-center shrink-0">
                <AppLogo code={app.code} className="h-7 w-7" />
              </div>

              <div className="relative top-px">
                {/* App Name */}
                <div className="flex items-center gap-2 mb-0 leading-tight">
                  <h1 className="text-2xl font-semibold text-foreground leading-tight">{app.name}</h1>
                </div>

                {/* Tagline */}
                <p className="text-muted-foreground">
                  {app.description}
                </p>
              </div>
            </div>

            {/* Install Controls */}
            {canManage ? (
              <div className="flex flex-col items-end gap-3">
                {!app.isInstalled && (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="assign-to-all"
                      checked={assignToAllMembers}
                      onCheckedChange={(checked) => setAssignToAllMembers(checked === true)}
                      disabled={isLoading}
                    />
                    <label
                      htmlFor="assign-to-all"
                      className="text-sm text-foreground cursor-pointer select-none"
                    >
                      {t.appstore.assignToAllMembers}
                    </label>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help shrink-0" />
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-56 text-xs">
                          {t.appstore.assignToAllMembersTooltip}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                )}
                <Button
                  variant={app.isInstalled ? 'outline' : 'default'}
                  disabled={isLoading}
                  className={app.isInstalled ? 'hover:text-destructive' : ''}
                  onClick={() => {
                    if (app.isInstalled) {
                      setShowUninstallDialog(true);
                    } else {
                      handleInstall();
                    }
                  }}
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : app.isInstalled ? (
                    t.appstore.uninstall
                  ) : (
                    t.appstore.install
                  )}
                </Button>
              </div>
            ) : app.isInstalled ? (
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                <CheckCircle className="h-4 w-4" />
                {t.appstore.installed}
              </span>
            ) : null}
          </div>

          <hr className="border-border/70 mb-8" />

          {/* Two Column Layout */}
          <div className="flex gap-16">
            {/* Left Sidebar */}
            <div className="w-48 shrink-0">
              {/* Category */}
              <div className="mb-6">
                <p className="text-xs text-muted-foreground mb-2">{t.appstore.category}</p>
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = getCategoryIcon(app.category);
                    return <Icon className="w-4 h-4 text-muted-foreground" />;
                  })()}
                  <span className="text-sm text-foreground">{app.category}</span>
                </div>
              </div>

              {/* Built by */}
              {app.provider && (
                <div className="mb-6">
                  <p className="text-xs text-muted-foreground mb-2">{t.appstore.builtBy}</p>
                  <div className="flex items-center gap-2">
                    <img
                      src="/assets/images/weldsuite/logo-light.png"
                      alt="WeldSuite"
                      className="h-4 w-4 dark:hidden"
                    />
                    <img
                      src="/assets/images/weldsuite/logo-dark.png"
                      alt="WeldSuite"
                      className="h-4 w-4 hidden dark:block"
                    />
                    <span className="text-sm text-foreground">{app.provider}</span>
                  </div>
                </div>
              )}

              {/* Resources */}
              {resources.length > 0 && (
                <div className="mb-6">
                  <p className="text-xs text-muted-foreground mb-2">{t.appstore.resources}</p>
                  <div className="space-y-2">
                    {resources.map(({ label, href, icon: Icon }) => (
                      <a
                        key={label}
                        href={href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="flex items-center gap-2 text-sm text-foreground hover:text-primary transition-colors"
                      >
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        {label}
                      </a>
                    ))}
                  </div>
                </div>
              )}

            </div>

            {/* Main Content */}
            <div className="flex-1 min-w-0">
              {/* Overview Section */}
              <div className="mb-10">
                <h2 className="text-xl font-semibold text-foreground mb-4">{t.appstore.overview}</h2>
                <p className="text-muted-foreground leading-relaxed">
                  {overview}
                </p>
              </div>

            </div>
          </div>
        </div>
      </div>

      {/* Uninstall Confirmation Dialog */}
      <ConfirmDialog
        open={showUninstallDialog}
        onOpenChange={setShowUninstallDialog}
        title={t.appstore.uninstallTitle.replace('{name}', app.name)}
        description={t.appstore.uninstallDescription}
        confirmLabel={t.appstore.uninstall}
        onConfirm={handleUninstall}
      />
    </>
  );
}
