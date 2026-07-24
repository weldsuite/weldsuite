
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { RoleDetail, PermissionCatalog, Permission, ObjectPermissions, InstallableApp } from '@/lib/api/types/rbac.types';
import { AppIcon } from '@/components/app-icon';
import { usePermissions } from '@weldsuite/permissions/react';
import { cn } from '@/lib/utils';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';
import {
  STANDARD_ACTIONS,
  getActionLabels,
  COMING_SOON_CATEGORIES,
  CategoryIcon,
  ComingSoonBadge,
  categoryFor,
  groupByCategory,
  type StandardAction,
  type CategoryRow,
  type CategoryGroup,
} from '@/components/settings/permission-categories';

// ---------------------------------------------------------------------------
// Row type — pre-computed per object
// ---------------------------------------------------------------------------

type Row = CategoryRow<Permission>;

function buildRows(catalog: PermissionCatalog): Row[] {
  return catalog.objects.map((obj: ObjectPermissions) => {
    const perAction: Row['perAction'] = {};
    const extras: Permission[] = [];
    for (const p of obj.permissions) {
      if ((STANDARD_ACTIONS as readonly string[]).includes(p.action)) {
        perAction[p.action as StandardAction] = p;
      } else {
        extras.push(p);
      }
    }
    return {
      object: obj.object,
      objectName: obj.objectName,
      category: categoryFor(obj.object),
      perAction,
      extras,
      allPerms: obj.permissions,
    };
  });
}

function capitalizeWords(str: string): string {
  return str.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export default function RoleDetailPage() {
  const t = useTranslations();
  const ACTION_LABELS = React.useMemo(() => getActionLabels(t), [t]);
  const router = useRouter();
  const params = useParams();
  const roleId = params.roleId as string;

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [role, setRole] = React.useState<RoleDetail | null>(null);
  const [catalog, setCatalog] = React.useState<PermissionCatalog | null>(null);
  const [installableApps, setInstallableApps] = React.useState<InstallableApp[]>([]);

  // Form state
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [grantedPermissions, setGrantedPermissions] = React.useState<Set<string>>(new Set());
  const [grantedApps, setGrantedApps] = React.useState<Set<string>>(new Set());
  const [search, setSearch] = React.useState('');
  const { getClient } = useAppApiClient();
  const { can, isOwner } = usePermissions();
  const canManageRoles = can('roles:update') || isOwner;

  const loadData = React.useCallback(async () => {
    try {
      const client = await getClient();
      const [roleResult, catalogResult, appsResult] = await Promise.all([
        client.get<{ data?: RoleDetail }>(`/roles/${roleId}`),
        client.get<{ data?: PermissionCatalog }>('/roles/permission-catalog'),
        client.get<{ data?: InstallableApp[] }>('/roles/installable-apps'),
      ]);

      if (roleResult.data) {
        setRole(roleResult.data);
        setName(roleResult.data.name);
        setDescription(roleResult.data.description || '');
        setGrantedPermissions(new Set(roleResult.data.permissions));
        setGrantedApps(new Set(roleResult.data.apps || []));
      } else {
        toast.error(t('sweep.settings.roleDetail.loadFailed'));
        router.push('/settings/roles');
        return;
      }

      if (catalogResult.data) {
        setCatalog(catalogResult.data);
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

  const toggleApp = (appCode: string) => {
    const next = new Set(grantedApps);
    if (next.has(appCode)) next.delete(appCode);
    else next.add(appCode);
    setGrantedApps(next);
  };

  const togglePermission = (code: string) => {
    const next = new Set(grantedPermissions);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setGrantedPermissions(next);
  };

  const toggleAllInObject = (permissions: Permission[], grant: boolean) => {
    const next = new Set(grantedPermissions);
    permissions.forEach((p) => {
      if (grant) next.add(p.code);
      else next.delete(p.code);
    });
    setGrantedPermissions(next);
  };

  const isObjectFullyGranted = (permissions: Permission[]) =>
    permissions.length > 0 && permissions.every((p) => grantedPermissions.has(p.code));

  const rows = React.useMemo<Row[]>(() => {
    if (!catalog) return [];
    return buildRows(catalog);
  }, [catalog]);

  const groups = React.useMemo<CategoryGroup<Permission>[]>(() => groupByCategory(rows), [rows]);

  const filteredGroups = React.useMemo<CategoryGroup<Permission>[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((group) => ({
        ...group,
        rows: group.rows.filter(
          (row) =>
            row.objectName.toLowerCase().includes(q) ||
            row.object.toLowerCase().includes(q) ||
            group.category.toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.rows.length > 0);
  }, [groups, search]);

  const hasChanges = React.useMemo(() => {
    if (!role) return false;
    return (
      name !== role.name ||
      description !== (role.description || '') ||
      !areSetsEqual(grantedPermissions, new Set(role.permissions)) ||
      !areSetsEqual(grantedApps, new Set(role.apps || []))
    );
  }, [role, name, description, grantedPermissions, grantedApps]);

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

  const categoryAllPerms = (group: CategoryGroup<Permission>): Permission[] =>
    group.rows.flatMap((r) => r.allPerms);

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

      {/* Apps — members with this role get access to the selected apps
          automatically, without per-user app assignments. */}
      <div>
        <div className="mb-1">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('sweep.settings.roleDetail.appsTitle')}</h2>
          <p className="text-xs text-muted-foreground mt-1">
            {t('sweep.settings.roleDetail.appsDescription')}
          </p>
        </div>
        {installableApps.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">
            {t('sweep.settings.roleDetail.noAppsInstalled')}
          </p>
        ) : (
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {installableApps.map((app) => {
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
        )}
      </div>

      <Separator />

      {/* Permissions tables */}
      <div>
        <div className="flex items-center justify-between gap-4 mb-4">
          <h2 className="text-sm font-semibold text-muted-foreground">{t('sweep.settings.roleDetail.permissionsTitle')}</h2>
          <ExpandingSearchInput value={search} onChange={setSearch} placeholder={t('sweep.settings.roleDetail.searchPermissionsPlaceholder')} />
        </div>
        <div className="space-y-10">
          {filteredGroups.length === 0 && (
            <p className="text-sm text-muted-foreground">{t('sweep.settings.roleDetail.noPermissionsMatch', { query: search })}</p>
          )}
          {filteredGroups.map((group) => {
            const groupPerms = categoryAllPerms(group);
            const groupAllGranted = isObjectFullyGranted(groupPerms);
            const groupHasExtras = group.rows.some((r) => r.extras.length > 0);
            return (
              <div key={group.category} className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <h4 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                      <CategoryIcon category={group.category} className="h-4 w-4 shrink-0" />
                      <span>{group.category}</span>
                    </h4>
                    {COMING_SOON_CATEGORIES.has(group.category) && <ComingSoonBadge />}
                  </div>
                  {editable && groupPerms.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors whitespace-nowrap"
                      onClick={() => toggleAllInObject(groupPerms, !groupAllGranted)}
                    >
                      {groupAllGranted ? t('sweep.settings.roleDetail.revokeAll') : t('sweep.settings.roleDetail.grantAll')}
                    </Button>
                  )}
                </div>
                <div className="rounded-md border border-border/70 overflow-hidden">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader className="bg-background [&_tr]:border-border/70">
                        <TableRow>
                          <TableHead className="w-[220px] text-[13px]">{t('sweep.settings.roleDetail.object')}</TableHead>
                          {STANDARD_ACTIONS.map((action) => (
                            <TableHead key={action} className="w-[90px] text-center text-[13px]">
                              {ACTION_LABELS[action]}
                            </TableHead>
                          ))}
                          {groupHasExtras && (
                            <TableHead className="text-[13px]">{t('sweep.settings.roleDetail.other')}</TableHead>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody className="[&_tr]:border-border/70">
                        {group.rows.map((row) => {
                          const allGranted = isObjectFullyGranted(row.allPerms);
                          return (
                            <TableRow key={row.object} className="h-10 hover:bg-muted/30">
                              <TableCell className="py-2">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-sm font-medium">{row.objectName}</span>
                                  {editable && row.allPerms.length > 0 && (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="text-[11px] text-muted-foreground hover:text-foreground hover:underline underline-offset-2 transition-colors whitespace-nowrap"
                                      onClick={() => toggleAllInObject(row.allPerms, !allGranted)}
                                    >
                                      {allGranted ? t('sweep.settings.roleDetail.revokeAll') : t('sweep.settings.roleDetail.grantAll')}
                                    </Button>
                                  )}
                                </div>
                              </TableCell>

                              {STANDARD_ACTIONS.map((action) => {
                                const perm = row.perAction[action];
                                return (
                                  <TableCell key={action} className="py-2 px-3 text-center [&:has([role=checkbox])]:pr-3 [&:has([role=checkbox])]:pl-3">
                                    <div className="flex items-center justify-center">
                                      {perm ? (
                                        <Checkbox
                                          checked={grantedPermissions.has(perm.code)}
                                          onCheckedChange={() => togglePermission(perm.code)}
                                          disabled={!editable}
                                          className="h-3.5 w-3.5"
                                          aria-label={t('sweep.settings.roleDetail.actionObjectLabel', { action: ACTION_LABELS[action], object: row.objectName })}
                                        />
                                      ) : (
                                        <span className="text-muted-foreground/40 text-sm tabular-nums select-none">—</span>
                                      )}
                                    </div>
                                  </TableCell>
                                );
                              })}

                              {groupHasExtras && (
                                <TableCell className="py-2">
                                  {row.extras.length > 0 ? (
                                    <div className="flex flex-wrap gap-x-4 gap-y-1">
                                      {row.extras.map((perm) => (
                                        <label
                                          key={perm.code}
                                          className={cn(
                                            'flex items-center gap-1.5 text-sm',
                                            editable ? 'cursor-pointer' : 'cursor-default',
                                          )}
                                        >
                                          <Checkbox
                                            checked={grantedPermissions.has(perm.code)}
                                            onCheckedChange={() => togglePermission(perm.code)}
                                            disabled={!editable}
                                            className="h-3.5 w-3.5"
                                          />
                                          <span className="text-muted-foreground">
                                            {capitalizeWords(perm.action)}
                                          </span>
                                        </label>
                                      ))}
                                    </div>
                                  ) : null}
                                </TableCell>
                              )}
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

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
