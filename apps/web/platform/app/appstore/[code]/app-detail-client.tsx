/**
 * An app's page in the App Store, laid out like Attio's app pages: a framed
 * 12-column page with a breadcrumb row, the header (icon, name, tagline,
 * install), a sticky sidebar with the facts beside the overview, and the
 * other apps of the same category at the bottom.
 */

import { useState, type ReactNode } from 'react';
import { Link } from '@/lib/router';
import { useBetaAppCodes, useInstallApp, useUninstallApp, type AvailableApp } from '@/hooks/queries/use-settings-queries';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import {
  ArrowRight,
  BadgeCheck,
  Calculator,
  CheckCircle,
  CheckSquare,
  ChevronLeft,
  FileText,
  Globe,
  Headphones,
  Info,
  Layers,
  Loader2,
  Mail,
  MessageSquare,
  Server,
  TrendingUp,
  type LucideIcon,
} from 'lucide-react';
import { getAppLogo, getAppLucideIcon } from '@/lib/apps/app-registry';
import { BetaBadge } from '@/components/layout/beta-badge';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { cn } from '@/lib/utils';
import { getTranslations } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n/provider';
import { useAppLicence } from '@/components/partner/use-app-licence';
import { isNotLicensedError } from '@/lib/partner/api-errors';
import { AppAccessControls } from '../app-access-controls';
import { getConsolidatedCategory } from '../app-categories';
import { useAppAccessGate } from '../use-app-access-gate';
import { AppGallery } from './app-gallery';

/** Small caps over the breadcrumb, the version and the other apps. */
const OVERLINE = 'text-xs leading-[14px] font-semibold uppercase tracking-[0.06em] text-muted-foreground';
const SECTION_TITLE = 'relative mb-5 text-2xl leading-[30px] font-semibold tracking-[-0.01em] text-foreground [&:not(:first-child)]:mt-12';
const PROSE = 'max-w-prose text-base leading-[22px] font-normal tracking-[-0.01em] text-foreground';
const LIST = 'mt-1.5 list-[square] pl-3.5 marker:text-muted-foreground';
const LIST_ITEM = 'pt-1 pb-1.5 pl-1.5 first:pt-1.5';
const SIDEBAR_TITLE = 'truncate text-base leading-[22px] font-semibold text-foreground';
const SIDEBAR_ROW = 'flex items-center text-sm leading-5 font-medium text-muted-foreground';
const BUTTON = 'h-9 rounded-[10px] px-3 text-sm font-medium';
const PRIMARY_BUTTON = cn(BUTTON, 'border border-foreground bg-foreground text-background hover:bg-foreground/90');

interface AppContent {
  overview: string | null;
  features: string[];
  howItWorks: { title: string; description: string }[];
  version: string;
  releasedAt: string | null;
}

interface AppDetailClientProps {
  app: AvailableApp;
  canManage?: boolean;
  content: AppContent;
  /** The other apps of the same category, for the row at the bottom. */
  otherApps?: AvailableApp[];
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

/** The app's logo on a rounded tile (30% corners) with a hairline inside, as Attio draws app icons. */
function AppIcon({ code, size }: Readonly<{ code: string; size: 'lg' | 'md' | 'sm' }>) {
  const logoPath = getAppLogo(code, 'light');
  const Icon = getAppLucideIcon(code);
  const box = { lg: 'size-[84px]', md: 'size-10', sm: 'size-[18px]' }[size];
  const glyph = { lg: 'size-[42px]', md: 'size-5', sm: 'size-2.5' }[size];
  return (
    <div className={cn('relative flex shrink-0 items-center justify-center overflow-hidden rounded-[30%] bg-white dark:bg-background', box)}>
      {logoPath ? <img src={logoPath} alt="" className={cn(glyph, 'object-contain')} /> : <Icon className={glyph} />}
      <span aria-hidden className="absolute inset-0 rounded-[inherit] shadow-[inset_0_0_0_1px] shadow-black/10 dark:shadow-white/10" />
    </div>
  );
}


/** One of the other apps: icon, name and maker, the tagline under it, an arrow on hover. */
function OtherAppCard({ app, byLabel }: Readonly<{ app: AvailableApp; byLabel: string }>) {
  return (
    <Link href={`/appstore/${app.code}`} className="group relative flex flex-col gap-3.5 overflow-hidden rounded-2xl border border-border p-5">
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-muted opacity-0 transition-opacity duration-300 ease-in-out group-hover:opacity-80" />
      <div className="relative flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <AppIcon code={app.code} size="md" />
          <div className="flex min-w-0 flex-col">
            <h4 className="truncate text-base leading-[22px] font-semibold text-foreground">{app.name}</h4>
            <p className="truncate text-sm leading-5 font-medium text-muted-foreground">{byLabel}</p>
          </div>
        </div>
        <ArrowRight aria-hidden className="size-3.5 shrink-0 -translate-x-0.5 text-foreground opacity-0 transition-[opacity,translate] duration-300 group-hover:translate-x-0 group-hover:opacity-100" />
      </div>
      <p className="relative line-clamp-2 text-sm leading-5 font-medium text-muted-foreground">{app.description}</p>
    </Link>
  );
}

export function AppDetailClient({ app: initialApp, canManage = false, content, otherApps = [] }: Readonly<AppDetailClientProps>) {
  const { data: betaAppCodes } = useBetaAppCodes();
  const t = getTranslations('navigation');
  const { t: allT, format } = useI18n();
  const licence = useAppLicence();
  const [app, setApp] = useState(initialApp);
  const [isLoading, setIsLoading] = useState(false);
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);
  const [assignToAllMembers, setAssignToAllMembers] = useState(false);

  const installApp = useInstallApp();
  const uninstallApp = useUninstallApp();

  // Apps that are on request only: the catalog says so, the access request has the live state.
  const { status: accessStatus, view: accessView, needsAccess } = useAppAccessGate(app);

  const overview = content.overview || t.appstore.defaultOverview;
  const installLabel = app.isInstalled ? t.appstore.uninstall : t.appstore.install;
  const CategoryIcon = getCategoryIcon(app.category);
  const categoryLabel: Record<string, string> = {
    Customers: t.appstore.categoryCustomers,
    Communication: t.appstore.categoryCommunication,
    Work: t.appstore.categoryWork,
    Storage: t.appstore.categoryStorage,
    Finance: t.appstore.categoryFinance,
  };
  const group = getConsolidatedCategory(app.category, app.code);
  const resources = [
    app.websiteUrl ? { label: t.appstore.resourceWebsite, href: app.websiteUrl, icon: Globe } : null,
    app.documentationUrl ? { label: t.appstore.resourceDocumentation, href: app.documentationUrl, icon: FileText } : null,
    app.contactUrl ? { label: app.contactUrl.replace(/^mailto:/i, ''), href: app.contactUrl, icon: Mail } : null,
  ].filter((r): r is { label: string; href: string; icon: typeof Globe } => r !== null);

  async function handleInstall() {
    try {
      setIsLoading(true);
      await installApp.mutateAsync({ appCode: app.code, assignToAllMembers });
      setApp((prev) => ({ ...prev, isInstalled: true }));
      toast.success(t.appstore.installSuccess.replace('{name}', app.name));
    } catch (error) {
      console.error('Failed to install app:', error);
      // A licence refusal is explained by the global toast (with the partner's name).
      if (!isNotLicensedError(error)) {
        toast.error(error instanceof Error ? error.message : t.appstore.installError);
      }
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

  const onInstallClick = () => {
    if (app.isInstalled) setShowUninstallDialog(true);
    else void handleInstall();
  };

  // Install or uninstall: black when it adds the app, outline when it takes it away (and in the sidebar).
  const installButton = (outline: boolean) => (
    <Button
      variant={outline ? 'outline' : 'default'}
      disabled={isLoading}
      className={outline ? cn(BUTTON, app.isInstalled && 'hover:text-destructive') : PRIMARY_BUTTON}
      onClick={onInstallClick}
    >
      {isLoading ? <Loader2 className="size-4 animate-spin" /> : installLabel}
    </Button>
  );

  let installControls: ReactNode = null;
  let sidebarAction: ReactNode = null;
  if (!app.isInstalled && licence.managed && licence.isUnlicensed(app.code)) {
    // Not in the partner's licence for this workspace: ask the partner instead.
    installControls = (
      <div className="flex flex-col items-start gap-2">
        <p className="max-w-80 text-sm text-muted-foreground">
          {format(allT.partner.appStore.notLicensedHint, { partner: licence.managed.partner.name })}
        </p>
        <Button className={PRIMARY_BUTTON} onClick={() => licence.askPartner(app)}>
          {format(allT.partner.appStore.askPartner, { partner: licence.managed.partner.name })}
        </Button>
      </div>
    );
  } else if (needsAccess) {
    installControls = (
      <AppAccessControls
        app={app}
        status={accessStatus}
        view={accessView}
        canManage={canManage}
        onRequested={() => setApp((prev) => ({ ...prev, accessStatus: 'requested' }))}
      />
    );
  } else if (canManage) {
    // Uninstalling lives in the sidebar only; the header offers the install.
    if (!app.isInstalled) {
      installControls = (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          {installButton(false)}
          <div className="flex items-center gap-2">
            <Checkbox
              id="assign-to-all"
              checked={assignToAllMembers}
              onCheckedChange={(checked) => setAssignToAllMembers(checked === true)}
              disabled={isLoading}
            />
            <label htmlFor="assign-to-all" className="cursor-pointer text-sm text-foreground select-none">
              {t.appstore.assignToAllMembers}
            </label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="size-3.5 shrink-0 cursor-help text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-56 text-xs">
                  {t.appstore.assignToAllMembersTooltip}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      );
    }
    sidebarAction = installButton(true);
  } else if (app.isInstalled) {
    installControls = (
      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
        <CheckCircle className="size-4" />
        {t.appstore.installed}
      </span>
    );
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto">
        <div className="min-h-full px-6">
          <div className="mx-auto min-h-full max-w-[1392px] border-x border-border">
            <article>
              {/* Breadcrumb and version; the back chevron sits in the first column, so the crumb lines up with the title */}
              <div className="relative grid h-28 grid-cols-12 items-end pb-5">
                <Button variant="ghost" size="icon" className="col-1 row-1 mr-2 -mb-2 size-[30px] justify-self-end text-muted-foreground" asChild>
                  <Link href="/appstore" aria-label={t.appstore.back} title={t.appstore.back}>
                    <ChevronLeft className="!size-[18px]" />
                  </Link>
                </Button>
                <p className={cn(OVERLINE, 'col-[2/-3] row-1 truncate')}>
                  <Link href="/appstore" className="transition-colors hover:text-foreground">
                    {t.appstore.apps}
                  </Link>
                  {' / '}
                  <span className="text-foreground/80">{app.name}</span>
                </p>
                <p className={cn(OVERLINE, 'col-[-2] row-1 justify-self-center whitespace-nowrap max-lg:col-[-3] max-lg:justify-self-end')}>
                  [V{content.version}]
                </p>
              </div>

              {/* Icon, name, tagline, install */}
              <header className="relative grid grid-cols-12 pt-12 pb-20">
                <div className="col-[2/-2] flex gap-5 lg:col-[2/-3]">
                  <AppIcon code={app.code} size="lg" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-3">
                      <h1 className="text-[32px] leading-[36px] font-semibold tracking-[-0.015em] text-foreground lg:text-[40px] lg:leading-[44px]">
                        {app.name}
                      </h1>
                      {betaAppCodes?.has(app.code) && <BetaBadge variant="inline" />}
                    </div>
                    <p className={cn('pt-3 text-xl leading-[26px] font-medium tracking-[-0.01em] text-foreground', installControls && 'pb-7')}>{app.description}</p>
                    {installControls}
                  </div>
                </div>
              </header>

              {/* Facts on the left, the overview on the right: a line above them and down the sidebar's edge */}
              <div className="relative flex flex-col border-t border-border lg:grid lg:grid-cols-12">
                <aside className="relative bg-muted/40 lg:col-[1/4] lg:border-r lg:border-border">
                  <div className="sticky top-0 grid grid-cols-12 py-16 lg:py-[88px]">
                    <div className="col-[2/-2] flex flex-col items-start gap-x-4 gap-y-6 sm:max-lg:grid sm:max-lg:grid-cols-2 lg:col-[3/-3]">
                      {app.verified && (
                        <div className="flex w-fit items-center gap-1.5 rounded-[10px] border border-border py-1 pr-2.5 pl-2 text-sm leading-5 font-medium text-muted-foreground">
                          {/* Lucide's badge-check, filled: the check is cut out in the page colour. */}
                          <BadgeCheck aria-hidden className="size-4 shrink-0 fill-emerald-500 text-background" />
                          {t.appstore.officialApp}
                        </div>
                      )}
                      {app.provider && (
                        <div className="flex min-w-0 flex-col gap-1.5">
                          <h3 className={SIDEBAR_TITLE}>{t.appstore.builtBy}</h3>
                          <div className="-ml-0.5 flex items-center gap-1.5">
                            {/* The brand mark in its own blue, small on a bordered rounded square. */}
                            <div className="flex size-5 shrink-0 items-center justify-center rounded-[7px] border border-border bg-background">
                              <img src="/assets/images/weldsuite/icon.svg" alt="" className="size-2.5" />
                            </div>
                            <p className="truncate text-sm leading-5 font-medium text-muted-foreground">{app.provider}</p>
                          </div>
                        </div>
                      )}
                      <div className="flex min-w-0 flex-col gap-1.5">
                        <h3 className={SIDEBAR_TITLE}>{t.appstore.category}</h3>
                        <div className={SIDEBAR_ROW}>
                          <CategoryIcon aria-hidden className="size-3.5 shrink-0" />
                          <span className="ml-2 truncate">{app.category}</span>
                        </div>
                      </div>
                      {resources.length > 0 && (
                        <div className="flex min-w-0 flex-col gap-1.5 max-lg:col-span-full">
                          <h3 className={SIDEBAR_TITLE}>{t.appstore.resources}</h3>
                          <div className="flex flex-col gap-2">
                            {resources.map(({ label, href, icon: Icon }) => (
                              <a key={label} href={href} target="_blank" rel="noreferrer noopener" className={cn(SIDEBAR_ROW, 'w-full transition-colors hover:text-foreground')}>
                                <Icon aria-hidden className="size-3.5 shrink-0" />
                                <span className="ml-2 truncate">{label}</span>
                              </a>
                            ))}
                          </div>
                        </div>
                      )}
                      {sidebarAction}
                    </div>
                  </div>
                </aside>

                <div className="overflow-x-hidden py-20 lg:col-start-4 lg:col-end-13">
                  <div className="grid grid-cols-12">
                    <div className="col-[2/-2]">
                      <div className="mb-[72px]">
                        <AppGallery app={app} largeIcon={<AppIcon code={app.code} size="lg" />} smallIcon={<AppIcon code={app.code} size="md" />} />
                      </div>
                      <h2 className={SECTION_TITLE}>{t.appstore.overview}</h2>
                      <div className={PROSE}>
                        <p>{overview}</p>
                      </div>
                      {content.howItWorks.length > 0 && (
                        <>
                          <h2 className={SECTION_TITLE}>{t.appstore.howItWorks}</h2>
                          {/* Plain text like the overview: each step as a sentence, "Title. Description." */}
                          <div className={PROSE}>
                            <p>{content.howItWorks.map((step) => `${step.title.replace(/[.:]$/, '')}. ${step.description}`).join(' ')}</p>
                          </div>
                        </>
                      )}
                      {content.features.length > 0 && (
                        <>
                          <h2 className={SECTION_TITLE}>{t.appstore.features}</h2>
                          <ul className={cn(PROSE, LIST)}>
                            {content.features.map((feature) => (
                              <li key={feature} className={LIST_ITEM}>
                                {feature}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </article>

            {otherApps.length > 0 && (
              <aside className="relative grid grid-cols-12 gap-y-10 border-t border-border py-20 max-lg:py-16">
                <h3 className={cn(OVERLINE, 'col-[2/-2]')}>{format(t.appstore.otherApps, { category: categoryLabel[group] ?? group })}</h3>
                <div className="col-[2/-2] grid gap-3 md:grid-cols-2 lg:grid-cols-3 lg:gap-4">
                  {otherApps.map((other) => (
                    <OtherAppCard key={other.code} app={other} byLabel={format(t.appstore.byProvider, { provider: other.provider })} />
                  ))}
                </div>
              </aside>
            )}
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
