
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter, useParams } from '@/lib/router';
import { useBlocker } from '@tanstack/react-router';
import { Loader2, ChevronLeft } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Separator } from '@weldsuite/ui/components/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { buildAppPermissionCatalog, hasPermission, normalizeAppCode, toAppScopedKeys } from '@weldsuite/permissions';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { RoleDetail, InstallableApp } from '@/lib/api/types/rbac.types';
import { AppIcon } from '@/components/app-icon';
import { usePermissions } from '@weldsuite/permissions/react';
import { cn } from '@/lib/utils';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';
import {
  PermissionMatrixTable,
  PermissionSectionNav,
  SectionIcon,
  WORKSPACE_SECTION_ID,
  extraActionLabel,
  filterSections,
  usePermissionSections,
  type MatrixObject,
  type MatrixPermission,
  type PermissionSection,
} from '@/components/settings/app-permission-matrix';

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function RoleDetailPage() {
  const t = useTranslations();
  const router = useRouter();
  const params = useParams();
  const roleId = params.roleId as string;

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [role, setRole] = React.useState<RoleDetail | null>(null);
  const [installableApps, setInstallableApps] = React.useState<InstallableApp[]>([]);

  // Form state. Grants are held in the per-app format: a role saved before
  // the per-app migration (`companies:read`) is shown granted in every app
  // that has the object, and is saved back app-qualified.
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [initialGrants, setInitialGrants] = React.useState<Set<string>>(new Set());
  const [grantedPermissions, setGrantedPermissions] = React.useState<Set<string>>(new Set());
  const [grantedApps, setGrantedApps] = React.useState<Set<string>>(new Set());
  const [search, setSearch] = React.useState('');
  const [selectedSectionId, setSelectedSectionId] = React.useState(WORKSPACE_SECTION_ID);
  const { getClient } = useAppApiClient();
  const { can, isOwner } = usePermissions();
  const canManageRoles = can('roles:update') || isOwner;

  const loadData = React.useCallback(async () => {
    try {
      const client = await getClient();
      const [roleResult, appsResult] = await Promise.all([
        client.get<{ data?: RoleDetail }>(`/roles/${roleId}`),
        client.get<{ data?: InstallableApp[] }>('/roles/installable-apps'),
      ]);

      if (roleResult.data) {
        const grants = new Set(toAppScopedKeys(roleResult.data.permissions));
        setRole(roleResult.data);
        setName(roleResult.data.name);
        setDescription(roleResult.data.description || '');
        setInitialGrants(grants);
        setGrantedPermissions(new Set(grants));
        setGrantedApps(new Set(roleResult.data.apps || []));
      } else {
        toast.error(t('sweep.settings.roleDetail.loadFailed'));
        router.push('/settings/roles');
        return;
      }

      if (appsResult.data) {
        setInstallableApps(appsResult.data);
      }
    } catch (error) {
      console.error('Failed to load role:', error);
      toast.error(t('sweep.settings.roleDetail.loadFailed'));
      router.push('/settings/roles');
    } finally {
      setLoading(false);
    }
  }, [roleId, router, getClient, t]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSave = async () => {
    if (!role?.canModify) return;

    setSaving(true);
    try {
      const client = await getClient();
      // Single PUT updates name, description, permissions and app grants
      // together. app-api throws on non-2xx, so reaching the toast is success.
      await client.put<{ data?: RoleDetail }>(`/roles/${roleId}`, {
        name: name.trim(),
        description: description.trim() || undefined,
        permissions: Array.from(grantedPermissions),
        apps: Array.from(grantedApps),
      });

      toast.success(t('sweep.settings.roleDetail.updated'));
      loadData();
    } catch (error) {
      console.error('Failed to save role:', error);
      toast.error(error instanceof Error ? error.message : t('sweep.settings.roleDetail.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // -------------------------------------------------------------------------
  // Sections (Workspace + one per installed app)
  // -------------------------------------------------------------------------

  const installedCodes = React.useMemo(() => installableApps.map((a) => a.appCode), [installableApps]);
  const sections = usePermissionSections(installedCodes);
  const visibleSections = React.useMemo(() => filterSections(sections, search), [sections, search]);
  const selectedSection =
    visibleSections.find((s) => s.id === selectedSectionId) ?? visibleSections[0] ?? null;

  /** The installable (platform) app code behind a section, if the app can be granted. */
  const installableFor = React.useCallback(
    (section: PermissionSection) =>
      section.app ? installableApps.find((a) => (normalizeAppCode(a.appCode) ?? a.appCode) === section.app) : undefined,
    [installableApps],
  );

  /** Installed apps without a permission matrix: only their access switch. */
  const appsWithoutSection = React.useMemo(() => {
    const withSection = new Set(sections.map((s) => s.app).filter(Boolean));
    return installableApps.filter((a) => !withSection.has(normalizeAppCode(a.appCode) ?? a.appCode));
  }, [installableApps, sections]);

  // Wildcard grants (`weldcrm:*`, `*:read`) cover keys without listing them;
  // such cells show as granted, with the covering pattern in their title.
  const wildcardGrants = React.useMemo(
    () => [...grantedPermissions].filter((k) => k.includes('*')),
    [grantedPermissions],
  );
  const coveringPattern = (key: string) =>
    grantedPermissions.has(key) ? undefined : wildcardGrants.find((p) => hasPermission([p], key));
  const isGranted = (key: string) => grantedPermissions.has(key) || coveringPattern(key) !== undefined;

  /** Every key the editor can grant, across all apps (installed or not). */
  const allCatalogKeys = React.useMemo(() => {
    const catalog = buildAppPermissionCatalog();
    return [...catalog.apps.flatMap((a) => a.objects), ...catalog.workspace].flatMap((o) =>
      o.permissions.map((p) => p.key),
    );
  }, []);

  /**
   * Remove `keys` from a grant set. A wildcard covering any of them is first
   * split into the individual catalog keys it grants, so the rest of what it
   * covered stays granted and the removal actually takes effect.
   */
  const withoutKeys = React.useCallback(
    (grants: Set<string>, keys: string[]): Set<string> => {
      const next = new Set(grants);
      for (const pattern of grants) {
        if (!pattern.includes('*') || !keys.some((k) => hasPermission([pattern], k))) continue;
        next.delete(pattern);
        for (const k of allCatalogKeys) if (hasPermission([pattern], k)) next.add(k);
      }
      for (const k of keys) next.delete(k);
      return next;
    },
    [allCatalogKeys],
  );

  const setKeys = (keys: string[], grant: boolean) => {
    setGrantedPermissions((prev) => {
      if (!grant) return withoutKeys(prev, keys);
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  };

  const togglePermission = (key: string) => setKeys([key], !isGranted(key));

  const toggleApp = (appCode: string) => {
    const next = new Set(grantedApps);
    if (next.has(appCode)) next.delete(appCode);
    else next.add(appCode);
    setGrantedApps(next);
  };

  const grantReadOnly = (section: PermissionSection) => {
    const all = section.objects.flatMap((o) => o.all);
    setGrantedPermissions((prev) => {
      const next = withoutKeys(prev, all.filter((p) => p.action !== 'read').map((p) => p.key));
      for (const p of all) if (p.action === 'read') next.add(p.key);
      return next;
    });
  };

  /** Mirror another app's grants for the objects both apps expose. */
  const copyFromApp = (section: PermissionSection, sourceApp: string) => {
    if (!section.app) return;
    setGrantedPermissions((prev) => {
      const sourceGrants = [...prev];
      const grant: string[] = [];
      const revoke: string[] = [];
      for (const object of section.objects) {
        for (const p of object.all) {
          const source = `${sourceApp}:${object.object}:${p.action}`;
          (hasPermission(sourceGrants, source) ? grant : revoke).push(p.key);
        }
      }
      const next = withoutKeys(prev, revoke);
      for (const k of grant) next.add(k);
      return next;
    });
  };

  /** Apps sharing at least one object with the section — valid "copy from" sources. */
  const copySources = (section: PermissionSection) => {
    const objects = new Set(section.objects.map((o) => o.object));
    return sections.filter(
      (s) => s.app && s.id !== section.id && s.objects.some((o) => objects.has(o.object)),
    );
  };

  const hasChanges = React.useMemo(() => {
    if (!role) return false;
    return (
      name !== role.name ||
      description !== (role.description || '') ||
      !areSetsEqual(grantedPermissions, initialGrants) ||
      !areSetsEqual(grantedApps, new Set(role.apps || []))
    );
  }, [role, name, description, grantedPermissions, initialGrants, grantedApps]);

  const { proceed, reset, status } = useBlocker({
    shouldBlockFn: () => hasChanges && !saving,
    withResolver: true,
    enableBeforeUnload: hasChanges,
  });
  const blocked = status === 'blocked';

  const handleSaveAndProceed = async () => {
    await handleSave();
    proceed?.();
  };

  if (loading) return <PageLoader fullScreen={false} />;
  if (!role) return null;

  const editable = canManageRoles && role.canModify;

  const linkButton = (label: string, onClick: () => void) => (
    <Button
      type="button"
      variant="ghost"
      className="h-auto px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors whitespace-nowrap"
      onClick={onClick}
    >
      {label}
    </Button>
  );

  const renderCheckbox = (perm: MatrixPermission, ariaLabel: string) => {
    const pattern = coveringPattern(perm.key);
    return (
      <Checkbox
        checked={isGranted(perm.key)}
        onCheckedChange={() => togglePermission(perm.key)}
        disabled={!editable}
        className="h-3.5 w-3.5"
        aria-label={ariaLabel}
        title={pattern ? t('sweep.settings.appPermissions.grantedByPattern', { pattern }) : perm.description ?? perm.label}
      />
    );
  };

  const rowAction = (object: MatrixObject) => {
    if (!editable || object.all.length === 0) return null;
    const keys = object.all.map((p) => p.key);
    const allGranted = keys.every(isGranted);
    return linkButton(
      allGranted ? t('sweep.settings.roleDetail.revokeAll') : t('sweep.settings.roleDetail.grantAll'),
      () => setKeys(keys, !allGranted),
    );
  };

  const sectionBadge = (section: PermissionSection) =>
    `${section.keys.filter(isGranted).length}/${section.keys.length}`;

  const selectedInstallable = selectedSection ? installableFor(selectedSection) : undefined;
  const sources = selectedSection?.app ? copySources(selectedSection) : [];

  return (
    <div className="space-y-8">
      {/* Back Link */}
      <Button
        type="button"
        variant="ghost"
        onClick={() => router.push('/settings/roles')}
        className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4 mr-1" />
        {t('sweep.settings.roleDetail.back')}
      </Button>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{role.name}</h1>
            {role.isSystemRole && (
              <Badge variant="outline" className="text-xs rounded-sm border-0 bg-muted text-muted-foreground">
                {t('settings.roles.system')}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {t('sweep.settings.roleDetail.summary', {
              memberCount: role.memberCount,
              permissionCount: grantedPermissions.size,
              appCount: grantedApps.size,
            })}
          </p>
        </div>
        {editable && (
          <Button onClick={handleSave} disabled={saving || !hasChanges} size="sm" className="shadow-none">
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('sweep.settings.roleDetail.saveChanges')}
          </Button>
        )}
      </div>

      {/* Role info */}
      {editable && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="name">{t('sweep.settings.roleDetail.nameLabel')}</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="description">{t('sweep.settings.roleDetail.descriptionLabel')}</Label>
            <Input id="description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('sweep.settings.roleDetail.optionalPlaceholder')} />
          </div>
        </div>
      )}

      <Separator />

      {/* Permissions — one matrix per app */}
      <div>
        <div className="flex items-center justify-between gap-4 mb-1">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('sweep.settings.roleDetail.permissionsTitle')}</h2>
          <ExpandingSearchInput value={search} onChange={setSearch} placeholder={t('sweep.settings.roleDetail.searchPermissionsPlaceholder')} />
        </div>
        <p className="text-xs text-muted-foreground mb-4">{t('sweep.settings.appPermissions.intro')}</p>

        {visibleSections.length === 0 || !selectedSection ? (
          <p className="text-sm text-muted-foreground">{t('sweep.settings.roleDetail.noPermissionsMatch', { query: search })}</p>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
            <PermissionSectionNav
              sections={visibleSections}
              selectedId={selectedSection.id}
              onSelect={setSelectedSectionId}
              badge={sectionBadge}
            />

            <div className="min-w-0 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <SectionIcon section={selectedSection} className="h-4 w-4 shrink-0" />
                  {selectedSection.label}
                </h3>
                {editable && selectedSection.keys.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1">
                    {linkButton(t('sweep.settings.roleDetail.grantAll'), () => setKeys(selectedSection.keys, true))}
                    {linkButton(t('sweep.settings.appPermissions.readOnly'), () => grantReadOnly(selectedSection))}
                    {linkButton(t('sweep.settings.roleDetail.revokeAll'), () => setKeys(selectedSection.keys, false))}
                    {sources.length > 0 && (
                      <Select value="" onValueChange={(app) => copyFromApp(selectedSection, app)}>
                        <SelectTrigger className="h-7 w-auto gap-1 border-0 px-1.5 text-[11px] text-muted-foreground shadow-none hover:text-foreground">
                          <SelectValue placeholder={t('sweep.settings.appPermissions.copyFrom')} />
                        </SelectTrigger>
                        <SelectContent>
                          {sources.map((s) => (
                            <SelectItem key={s.id} value={s.app ?? s.id}>
                              {t('sweep.settings.appPermissions.copyFromApp', { app: s.label })}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {selectedSection.app
                  ? t('sweep.settings.appPermissions.appDescription', { app: selectedSection.label })
                  : t('sweep.settings.appPermissions.workspaceDescription')}
              </p>

              {/* Opening the app — members with this role get it without per-user assignment. */}
              {selectedInstallable && (
                <label
                  className={cn(
                    'flex items-center gap-3 rounded-md border border-border/70 px-3 py-2.5',
                    editable ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default',
                  )}
                >
                  <Checkbox
                    checked={grantedApps.has(selectedInstallable.appCode)}
                    onCheckedChange={() => editable && toggleApp(selectedInstallable.appCode)}
                    disabled={!editable}
                    className="h-4 w-4"
                  />
                  <span className="text-sm">
                    {t('sweep.settings.appPermissions.canOpenApp', { app: selectedSection.label })}
                  </span>
                </label>
              )}

              <PermissionMatrixTable
                objects={selectedSection.objects}
                rowAction={rowAction}
                renderCell={(perm, object, actionLabel) =>
                  renderCheckbox(
                    perm,
                    t('sweep.settings.roleDetail.actionObjectLabel', { action: actionLabel, object: object.objectName }),
                  )
                }
                renderExtra={(perm, object) => (
                  <label className={cn('flex items-center gap-1.5 text-sm', editable ? 'cursor-pointer' : 'cursor-default')}>
                    {renderCheckbox(perm, `${extraActionLabel(perm.action)} ${object.objectName}`)}
                    <span className="text-muted-foreground">{extraActionLabel(perm.action)}</span>
                  </label>
                )}
              />
            </div>
          </div>
        )}
      </div>

      {/* Installed apps without a permission matrix — access switch only. */}
      {appsWithoutSection.length > 0 && (
        <>
          <Separator />
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground">{t('sweep.settings.appPermissions.otherApps')}</h2>
            <p className="text-xs text-muted-foreground mt-1">{t('sweep.settings.roleDetail.appsDescription')}</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {appsWithoutSection.map((app) => {
                const checked = grantedApps.has(app.appCode);
                return (
                  <label
                    key={app.appCode}
                    className={cn(
                      'flex items-center gap-3 rounded-md border border-border/70 px-3 py-2.5 transition-colors',
                      editable ? 'cursor-pointer hover:bg-muted/40' : 'cursor-default',
                      checked && 'bg-muted/30',
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => editable && toggleApp(app.appCode)}
                      disabled={!editable}
                      className="h-4 w-4"
                      aria-label={t('sweep.settings.roleDetail.grantAppLabel', { name: app.appName })}
                    />
                    <AppIcon icon={app.appCode} className="h-5 w-5 shrink-0" />
                    <span className="text-sm font-medium">{app.appName}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </>
      )}

      <Dialog
        open={blocked}
        onOpenChange={(open) => {
          if (!open && reset) reset();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('sweep.settings.roleDetail.unsavedChangesTitle')}</DialogTitle>
            <DialogDescription>
              {t('sweep.settings.roleDetail.unsavedChangesDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => proceed?.()}
              disabled={saving}
            >
              {t('sweep.settings.roleDetail.discard')}
            </Button>
            <Button
              type="button"
              onClick={handleSaveAndProceed}
              disabled={saving || !editable}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  {t('sweep.settings.roleDetail.savingEllipsis')}
                </>
              ) : (
                t('sweep.settings.roleDetail.saveChanges')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function areSetsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
