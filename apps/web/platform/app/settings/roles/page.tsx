
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import { Plus, EllipsisVertical, Pencil, Trash2, Crown, Search, Eye } from 'lucide-react';
import { PageLoader } from '@/components/page-loader';
import { Button } from '@weldsuite/ui/components/button';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Badge } from '@weldsuite/ui/components/badge';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Role } from '@/lib/api/types/rbac.types';
import { CreateRoleDialog } from '@/components/settings/create-role-dialog';
import { usePermissions } from '@weldsuite/permissions/react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ExpandingSearchInput } from '@/components/settings/expanding-search-input';

export default function RolesSettingsPage() {
  const t = useTranslations();
  const router = useRouter();
  const [loading, setLoading] = React.useState(true);
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [showCreateDialog, setShowCreateDialog] = React.useState(false);
  const [deletingRole, setDeletingRole] = React.useState<Role | null>(null);
  // Roles are read and written entirely via app-api.
  const { getClient: getAppClient } = useAppApiClient();
  const { can, isOwner } = usePermissions();

  const canManageRoles = can('roles:update') || isOwner;

  const [activeFilters, setActiveFilters] = React.useState<ActiveFilter[]>([]);
  const [searchQuery, setSearchQuery] = React.useState('');

  const filterConfigs: FilterConfig[] = React.useMemo(() => [
    {
      field: 'kind',
      label: t('sweep.settings.roles.kind'),
      filterType: 'select',
      options: [
        { value: 'system', label: t('settings.roles.system') },
        { value: 'custom', label: t('sweep.settings.roles.custom') },
      ],
    },
  ], [t]);

  const filterRoles = React.useCallback((list: Role[]) => {
    const q = searchQuery.trim().toLowerCase();
    return list.filter((r) => {
      for (const f of activeFilters) {
        if (!f.value) continue;
        if (f.field === 'kind') {
          if (f.value === 'system' && !r.isSystemRole) return false;
          if (f.value === 'custom' && r.isSystemRole) return false;
        }
      }
      if (q) {
        const haystack = [r.name, r.description].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [activeFilters, searchQuery]);

  const loadRoles = React.useCallback(async () => {
    try {
      const client = await getAppClient();
      const result = await client.get<{ data?: Role[] }>('/roles');
      if (result.data) {
        setRoles(result.data);
      }
    } catch (error) {
      console.error('Failed to load roles:', error);
      toast.error(t('sweep.settings.roles.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [getAppClient, t]);

  React.useEffect(() => {
    loadRoles();
  }, [loadRoles]);

  const handleDeleteRole = async () => {
    if (!deletingRole) return;
    try {
      // app-api DELETE /api/roles/:roleId (was api-worker
      // /settings/roles/:roleId). Replies 204; failures throw.
      const client = await getAppClient();
      await client.delete<void>(`/roles/${deletingRole.id}`);
      toast.success(t('sweep.settings.roles.deleted'));
      loadRoles();
    } catch (error) {
      console.error('Failed to delete role:', error);
      toast.error(t('sweep.settings.roles.deleteFailed'));
    } finally {
      setDeletingRole(null);
    }
  };

  if (loading) {
    return <PageLoader fullScreen={false} />;
  }

  const systemRoles = filterRoles(roles.filter((r) => r.isSystemRole));
  const customRoles = filterRoles(roles.filter((r) => !r.isSystemRole));
  const visibleCount = systemRoles.length + customRoles.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('settings.roles.title')}</h1>
        <p className="text-muted-foreground">
          {t('settings.roles.description')}
        </p>
      </div>

      <div className="space-y-3">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <FilterPills
              filters={activeFilters}
              filterConfigs={filterConfigs}
              maxFilters={5}
              onFiltersChange={setActiveFilters}
            />
          </div>

          <div className="flex items-center gap-2">
            <ExpandingSearchInput value={searchQuery} onChange={setSearchQuery} placeholder={t('sweep.settings.roles.searchPlaceholder')} />
            {canManageRoles && (
              <Button
                size="sm"
                className="h-8"
                onClick={() => setShowCreateDialog(true)}
                data-testid="settings-roles-create-btn"
              >
                <Plus className="h-4 w-4 mr-0.5" />
                {t('settings.roles.createRole')}
              </Button>
            )}
          </div>
        </div>

      {/* Roles table */}
      <div className="border rounded-lg overflow-hidden">
        <Table>
          <TableHeader className="[&_tr]:border-border/70">
            <TableRow>
              <TableHead className="text-[13.5px]">{t('sweep.settings.roles.table.role')}</TableHead>
              <TableHead className="text-[13.5px]">{t('sweep.settings.roles.table.description')}</TableHead>
              <TableHead className="text-right text-[13.5px]">{t('sweep.settings.roles.table.members')}</TableHead>
              <TableHead className="w-12 text-[13.5px]" />
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {systemRoles.map((role) => (
              <TableRow
                key={role.id}
                className="group h-10 cursor-pointer hover:bg-muted/50"
                onClick={() => router.push(`/settings/roles/${role.id}`)}
              >
                <TableCell className="py-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{role.name}</span>
                    {role.name === 'Owner' && (
                      <Crown className="h-3.5 w-3.5 text-amber-500" />
                    )}
                    <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-secondary text-secondary-foreground">
                      {t('settings.roles.system')}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="py-2 text-muted-foreground">
                  {role.description || '—'}
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">
                  {role.memberCount}
                </TableCell>
                <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                      >
                        <EllipsisVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => router.push(`/settings/roles/${role.id}`)}>
                        <Eye className="mr-0.5 h-4 w-4" />
                        {t('sweep.settings.roles.view')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
            {customRoles.map((role) => (
              <TableRow
                key={role.id}
                className="group h-10 cursor-pointer hover:bg-muted/50"
                onClick={() => router.push(`/settings/roles/${role.id}`)}
              >
                <TableCell className="py-2">
                  <span className="font-medium">{role.name}</span>
                </TableCell>
                <TableCell className="py-2 text-muted-foreground">
                  {role.description || '—'}
                </TableCell>
                <TableCell className="py-2 text-right tabular-nums">
                  {role.memberCount}
                </TableCell>
                <TableCell className="py-2" onClick={(e) => e.stopPropagation()}>
                  {canManageRoles && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                        >
                          <EllipsisVertical className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => router.push(`/settings/roles/${role.id}`)}>
                          <Pencil className="mr-0.5 h-4 w-4" />
                          {t('sweep.settings.roles.edit')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => setDeletingRole(role)}
                        >
                          <Trash2 className="mr-0.5 h-4 w-4" />
                          {t('sweep.settings.roles.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {visibleCount === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  {t('sweep.settings.roles.noneFound')}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      </div>

      {/* Dialogs */}
      <CreateRoleDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        roles={roles}
        onRoleCreated={() => {
          setShowCreateDialog(false);
          loadRoles();
        }}
      />
      <ConfirmDialog
        open={!!deletingRole}
        onOpenChange={(open) => { if (!open) setDeletingRole(null); }}
        title={t('sweep.settings.roles.deleteRoleTitle')}
        description={t('sweep.settings.roles.deleteRoleDescription', { name: deletingRole?.name })}
        confirmLabel={t('sweep.settings.roles.delete')}
        variant="destructive"
        onConfirm={handleDeleteRole}
      />
    </div>
  );
}
