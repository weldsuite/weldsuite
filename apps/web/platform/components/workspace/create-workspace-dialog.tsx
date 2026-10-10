
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useOrganizationList } from '@clerk/clerk-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { Loader2, Database, Shield, Sparkles, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { MultiSelect, type MultiSelectOption } from '@weldsuite/ui/components/multi-select';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import type { PartnerTerritoryErrorDetails } from '@weldsuite/app-api-client/schemas/partners';
import { TerritoryScreen } from '@/components/partner/territory-screen';
import { COUNTRIES } from '@/lib/constants/countries';
import { territoryErrorDetails } from '@/lib/partner/api-errors';
import { detectUserCountry } from '@/app/onboarding/types';
import { useDatabaseStatus, useCreateWorkspace, useFinalizeOnboarding, useAvailableApps } from '@/hooks/use-onboarding';
import { getAppIcon, getAppShortName, isHiddenFromOnboarding } from '@/lib/apps/app-registry';
import { LucideDynamicIcon } from '@/components/lucide-dynamic-icon';
import { setPendingOrganization } from '@/lib/pending-organization';

/** Apps pre-selected when the dialog opens. Mirrors the backend default set. */
const DEFAULT_SELECTED_APPS = ['crm', 'projects', 'task', 'mail', 'helpdesk'];

type ProvisioningStepStatus = 'pending' | 'in_progress' | 'completed';

interface ProvisioningStep {
  id: string;
  label: string;
  status: ProvisioningStepStatus;
}

const STEP_ROW_CLASSES: Record<ProvisioningStepStatus, string> = {
  completed: 'bg-green-50 border-green-200 dark:bg-green-950/30 dark:border-green-800',
  in_progress: 'bg-muted/50 border-border',
  pending: 'bg-background border-border/50',
};

const STEP_ICON_CLASSES: Record<ProvisioningStepStatus, string> = {
  completed: 'text-green-600 dark:text-green-400',
  in_progress: 'text-muted-foreground',
  pending: 'text-muted-foreground/40',
};

const STEP_LABEL_CLASSES: Record<ProvisioningStepStatus, string> = {
  completed: 'text-green-700 dark:text-green-300 font-medium',
  in_progress: 'text-foreground font-medium',
  pending: 'text-muted-foreground/60',
};

function ProvisioningStepIcon({ step }: Readonly<{ step: ProvisioningStep }>) {
  if (step.status === 'completed') return <CheckCircle2 className="h-4 w-4" />;
  if (step.status === 'in_progress') return <Loader2 className="h-4 w-4 animate-spin" />;
  if (step.id === 'database') return <Database className="h-4 w-4" />;
  if (step.id === 'security') return <Shield className="h-4 w-4" />;
  return <Sparkles className="h-4 w-4" />;
}

function ProvisioningStepRow({ step, doneLabel }: Readonly<{ step: ProvisioningStep; doneLabel: string }>) {
  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${STEP_ROW_CLASSES[step.status]}`}>
      <div className={`flex-shrink-0 ${STEP_ICON_CLASSES[step.status]}`}>
        <ProvisioningStepIcon step={step} />
      </div>
      <span className={`flex-1 text-sm ${STEP_LABEL_CLASSES[step.status]}`}>{step.label}</span>
      {step.status === 'completed' && (
        <span className="text-xs text-green-600 dark:text-green-400 font-medium">{doneLabel}</span>
      )}
    </div>
  );
}

interface CreateWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateWorkspaceDialog({ open, onOpenChange }: Readonly<CreateWorkspaceDialogProps>) {
  const t = useTranslations();
  const [workspaceName, setWorkspaceName] = React.useState('');
  // Where the company is based. Decides whether a partner provides WeldSuite
  // there (then the server answers 409 PARTNER_TERRITORY instead of creating).
  const [country, setCountry] = React.useState(() => {
    const detected = detectUserCountry();
    return COUNTRIES.some((c) => c.code === detected) ? detected : '';
  });
  const [territory, setTerritory] = React.useState<PartnerTerritoryErrorDetails | null>(null);
  const [selectedApps, setSelectedApps] = React.useState<string[]>([]);
  const didInitApps = React.useRef(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [isProvisioning, setIsProvisioning] = React.useState(false);
  const [provisioningPollCount, setProvisioningPollCount] = React.useState(0);
  const finalizationTriggered = React.useRef(false);
  const createdOrgIdRef = React.useRef<string | null>(null);

  const { setActive, userMemberships } = useOrganizationList({
    userMemberships: true,
  });

  /** Drop persisted query cache so the reload fetches a fresh workspace list. */
  const clearCacheAndRedirect = React.useCallback(() => {
    try { window.localStorage.removeItem('weldsuite:query-cache'); } catch { /* storage unavailable (private mode / quota) — non-fatal */ }
    window.location.href = '/';
  }, []);

  const createWorkspaceMutation = useCreateWorkspace();
  const finalizeMutation = useFinalizeOnboarding();
  const { data: dbStatus } = useDatabaseStatus(isProvisioning);
  const { data: availableApps, isLoading: isLoadingApps } = useAvailableApps();

  // Apps the user can pick from (same filter as the onboarding wizard).
  const visibleApps = React.useMemo(
    () => (availableApps || []).filter((app) => !isHiddenFromOnboarding(app.code)),
    [availableApps],
  );

  // Map available apps to multi-select options (icon + short name).
  const appOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      visibleApps.map((app) => {
        const iconPath = getAppIcon(app.code);
        return {
          value: app.code,
          label: getAppShortName(app.code, app.name),
          icon: iconPath ? (
            <img src={iconPath} alt="" className="size-4" />
          ) : (
            <LucideDynamicIcon name={app.icon} className="size-4" />
          ),
        };
      }),
    [visibleApps],
  );

  // Pre-select the default set once apps have loaded.
  React.useEffect(() => {
    if (didInitApps.current || visibleApps.length === 0) return;
    didInitApps.current = true;
    const availableCodes = new Set(visibleApps.map((app) => app.code));
    setSelectedApps(DEFAULT_SELECTED_APPS.filter((code) => availableCodes.has(code)));
  }, [visibleApps]);

  const [provisioningSteps, setProvisioningSteps] = React.useState<ProvisioningStep[]>([
    { id: 'database', label: t('sweep.shared.creatingYourDatabase'), status: 'in_progress' },
    { id: 'security', label: t('sweep.shared.settingUpSecurity'), status: 'pending' },
    { id: 'features', label: t('sweep.shared.enablingFeatures'), status: 'pending' },
  ]);

  // Poll counter for visual step progression
  React.useEffect(() => {
    if (!isProvisioning || provisioningPollCount >= 90) return;
    const timer = setTimeout(() => setProvisioningPollCount((c) => c + 1), 2000);
    return () => clearTimeout(timer);
  }, [isProvisioning, provisioningPollCount]);

  // Simulate step progression based on poll count
  React.useEffect(() => {
    if (!isProvisioning) return;
    setProvisioningSteps((prev) =>
      prev.map((step) => {
        if (step.id === 'database') {
          return { ...step, status: provisioningPollCount > 5 ? 'completed' : 'in_progress' };
        }
        if (step.id === 'security') {
          if (provisioningPollCount > 10) return { ...step, status: 'completed' };
          if (provisioningPollCount > 5) return { ...step, status: 'in_progress' };
          return { ...step, status: 'pending' };
        }
        if (step.id === 'features') {
          if (provisioningPollCount > 10) return { ...step, status: 'in_progress' };
          return { ...step, status: 'pending' };
        }
        return step;
      }),
    );
  }, [isProvisioning, provisioningPollCount]);

  // Handle finalization when DB is ready
  React.useEffect(() => {
    if (!dbStatus?.provisioned || !dbStatus?.migrated || finalizationTriggered.current) return;
    finalizationTriggered.current = true;

    void (async () => {
      try {
        await finalizeMutation.mutateAsync();
      } catch (err) {
        console.error('[Workspace] Error finalizing:', err);
      }

      setProvisioningSteps((prev) =>
        prev.map((step) => ({ ...step, status: 'completed' as const })),
      );

      // Re-assert the new workspace as the active org so the post-reload `/`
      // sees the right orgId (Clerk's session may have drifted during the
      // provisioning wait).
      if (createdOrgIdRef.current && setActive) {
        try {
          await setActive({ organization: createdOrgIdRef.current });
        } catch (err) {
          console.error('[Workspace] Error re-activating org before redirect:', err);
        }
      }

      clearCacheAndRedirect();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbStatus?.provisioned, dbStatus?.migrated]);

  const handleCreate = async () => {
    if (!workspaceName.trim()) {
      toast.error(t('sweep.shared.pleaseEnterAWorkspaceName'));
      return;
    }

    if (selectedApps.length === 0) {
      toast.error(t('sweep.shared.pleaseSelectAtLeastOneApp'));
      return;
    }

    setIsCreating(true);

    try {
      // Create + provision server-side via the same path as the onboarding wizard
      // (workspace-worker /api/onboard). This installs the selected apps and skips
      // sample data — no client-side org creation, no racy webhook/retry triggers.
      const result = await createWorkspaceMutation.mutateAsync({
        name: workspaceName.trim(),
        selectedApps,
        ...(country ? { country } : {}),
      });

      if (!result?.success || !result.organizationId) {
        throw new Error(t('sweep.shared.failedToCreateWorkspace'));
      }

      createdOrgIdRef.current = result.organizationId;
      // Survive the post-create reload even if Clerk's session still has the
      // previous org (or none). The app shell activates this id on boot.
      setPendingOrganization(result.organizationId);

      // The org was created via the backend, so Clerk's client membership list
      // is stale until we refetch. setActive is more likely to persist when
      // the new membership is already in that list.
      try {
        await userMemberships?.revalidate?.();
      } catch {
        // Best-effort — setActive below may still succeed, and the pending
        // org stash covers the reload either way.
      }

      // Auto-select the new workspace as the active org right away.
      if (setActive) {
        try {
          await setActive({ organization: result.organizationId });
        } catch (err) {
          console.error('[Workspace] Error activating new org (continuing):', err);
        }
      }

      // Instant path: the workspace was provisioned from a warm pre-migrated
      // database slot and is fully usable — skip the provisioning screen and
      // land in the new workspace immediately.
      if (result.ready) {
        try {
          await finalizeMutation.mutateAsync();
        } catch (finalizeErr) {
          console.error('[Workspace] Error finalizing (continuing):', finalizeErr);
        }
        clearCacheAndRedirect();
        return;
      }

      // Slow path (no warm slot available): switch to the provisioning state
      // and poll database-status until the workflow finishes.
      setIsCreating(false);
      setIsProvisioning(true);
      setProvisioningPollCount(0);
      finalizationTriggered.current = false;
      setProvisioningSteps([
        { id: 'database', label: 'Creating your database', status: 'in_progress' },
        { id: 'security', label: 'Setting up security', status: 'pending' },
        { id: 'features', label: 'Enabling features', status: 'pending' },
      ]);
      // Provisioning was already triggered server-side by /api/onboard; the
      // effect below polls database-status and finalizes once it's ready.
    } catch (error: unknown) {
      // A partner serves this country: no workspace was created. Show who to
      // contact instead of an error.
      const territoryDetails = territoryErrorDetails(error);
      if (territoryDetails) {
        setTerritory(territoryDetails);
        setIsCreating(false);
        return;
      }
      const clerkError = error as { errors?: Array<{ longMessage?: string; message?: string }>; message?: string };
      const errorMessage = clerkError?.errors?.[0]?.longMessage || clerkError?.errors?.[0]?.message || clerkError?.message || t('sweep.shared.failedToCreateWorkspace');
      console.error('Failed to create workspace:', error);
      toast.error(errorMessage);
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    if (!isCreating && !isProvisioning) {
      setWorkspaceName('');
      setTerritory(null);
      onOpenChange(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className={territory ? 'max-h-[92vh] overflow-y-auto sm:max-w-lg' : 'sm:max-w-[425px]'} onInteractOutside={(e) => { if (isProvisioning) e.preventDefault(); }}>
        {territory ? (
          <>
            <DialogHeader className="sr-only">
              <DialogTitle>{t('sweep.shared.createNewWorkspace')}</DialogTitle>
              <DialogDescription>{t('sweep.shared.createNewWorkspaceDescription')}</DialogDescription>
            </DialogHeader>
            <TerritoryScreen
              details={territory}
              defaultCompany={workspaceName.trim()}
              selectedApps={selectedApps}
              onBack={() => setTerritory(null)}
              onClose={handleClose}
            />
          </>
        ) : isProvisioning ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('sweep.shared.settingUpYourWorkspace')}</DialogTitle>
              <DialogDescription>
                {t('sweep.shared.usuallyTakesLessThanAMinute')}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2 py-4">
              {provisioningSteps.map((step) => (
                <ProvisioningStepRow key={step.id} step={step} doneLabel={t('sweep.shared.done')} />
              ))}
              {provisioningPollCount >= 90 && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-center dark:bg-amber-950/30 dark:border-amber-800">
                  <p className="text-sm text-amber-700 dark:text-amber-300">
                    {t('sweep.shared.takingLongerThanExpectedBefore')}{' '}
                    <Button
                      variant="ghost"
                      onClick={() => window.location.reload()}
                      className="font-medium underline hover:no-underline"
                    >
                      {t('sweep.shared.refreshThePage')}
                    </Button>{' '}
                    {t('sweep.shared.takingLongerThanExpectedAfter')}
                  </p>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t('sweep.shared.createNewWorkspace')}</DialogTitle>
              <DialogDescription>
                {t('sweep.shared.createNewWorkspaceDescription')}
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="workspace-name">{t('sweep.shared.workspaceName')}</Label>
                <Input
                  id="workspace-name"
                  placeholder={t('sweep.shared.workspaceNamePlaceholderExample')}
                  value={workspaceName}
                  onChange={(e) => setWorkspaceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && workspaceName.trim() && !isCreating) {
                      void handleCreate();
                    }
                  }}
                  disabled={isCreating}
                  autoFocus
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="workspace-country">{t('partner.createWorkspace.country')}</Label>
                <Select value={country || undefined} onValueChange={setCountry} disabled={isCreating}>
                  <SelectTrigger id="workspace-country">
                    <SelectValue placeholder={t('partner.createWorkspace.countryPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    {COUNTRIES.map((c) => (
                      <SelectItem key={c.code} value={c.code}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground -mt-1">{t('partner.createWorkspace.countryHint')}</p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="workspace-apps">{t('sweep.shared.apps')}</Label>
                <p className="text-xs text-muted-foreground -mt-1">
                  {t('sweep.shared.chooseWhichAppsToEnable')}
                </p>
                <MultiSelect
                  id="workspace-apps"
                  aria-label={t('sweep.shared.apps')}
                  options={appOptions}
                  value={selectedApps}
                  onChange={setSelectedApps}
                  disabled={isCreating || isLoadingApps}
                  placeholder={isLoadingApps ? t('sweep.shared.loadingAppsEllipsis') : t('sweep.shared.selectApps')}
                  searchPlaceholder={t('sweep.shared.searchAppsPlaceholder')}
                  emptyText={t('sweep.shared.noAppsFound')}
                  maxDisplay={6}
                  modal
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleClose} disabled={isCreating}>
                {t('sweep.shared.cancel')}
              </Button>
              <Button
                onClick={handleCreate}
                disabled={!workspaceName.trim() || selectedApps.length === 0 || isCreating}
              >
                {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('sweep.shared.createWorkspace')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
