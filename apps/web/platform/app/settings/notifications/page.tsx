
import * as React from 'react';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import {
  Bell,
  BellOff,
  Volume2,
  VolumeX,
  Mail,
  Smartphone,
  Monitor,
  Headphones,
  Users,
  FolderKanban,
  Package,
  Workflow,
  CalendarClock,
  MessageSquare,
  type LucideIcon,
} from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { useI18n } from '@/lib/i18n/provider';
import { PageLoader } from '@/components/page-loader';
import { AppIcon } from '@/components/app-icon';
import { toast } from 'sonner';
import { Switch } from '@weldsuite/ui/components/switch';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useNotificationPreferences,
  useUpdateGlobalNotificationSettings,
  useUpdateNotificationPreferences,
  useUpdateModulePreferences,
} from '@/hooks/queries/use-notifications-queries';
import {
  useTaskDigestSettings,
  useUpdateTaskDigestSettings,
} from '@/hooks/queries/use-task-digest-queries';

// Module definitions
const NOTIFICATION_MODULES = [
  { key: 'helpdesk', label: 'Helpdesk', icon: Headphones, appCode: 'welddesk' },
  { key: 'crm', label: 'CRM', icon: Users, appCode: 'weldcrm' },
  { key: 'mail', label: 'Mail', icon: Mail, appCode: 'weldmail' },
  { key: 'projects', label: 'Projects', icon: FolderKanban, appCode: 'weldflow' },
  { key: 'parcel', label: 'Parcel', icon: Package, appCode: 'parcel' },
  { key: 'task', label: 'Workflows', icon: Workflow, appCode: 'weldconnect' },
  { key: 'weldchat', label: 'WeldChat', icon: MessageSquare, appCode: 'weldchat' },
  { key: 'digest', label: 'Daily Digest', icon: CalendarClock, appCode: 'weldcalendar' },
] as const;

interface ModuleChannelPreferences {
  enabled: boolean;
  inApp: boolean;
  email: boolean;
  push: boolean;
  desktop: boolean;
}

interface ChannelRow {
  id: string;
  label: string;
  icon: LucideIcon;
  checked: boolean;
  onChange: (v: boolean) => void;
}

interface ModuleRow {
  key: string;
  label: string;
  icon: LucideIcon;
  appCode: string;
  enabled: boolean;
}

// Hour options for digest send time
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => ({
  value: String(i),
  label: `${i.toString().padStart(2, '0')}:00`,
}));

export default function NotificationsSettingsPage() {
  const { t } = useI18n();
  const ts = t.settings.notifications;
  const { can } = usePermissions();
  const isAdmin = can('team:update');

  const { data: preferences, isLoading: loading } = useNotificationPreferences();
  const globalMutation = useUpdateGlobalNotificationSettings();
  const prefsMutation = useUpdateNotificationPreferences();
  const moduleMutation = useUpdateModulePreferences();

  const { data: digestSettings, isLoading: digestLoading } = useTaskDigestSettings();
  const digestMutation = useUpdateTaskDigestSettings();

  const saving = globalMutation.isPending || prefsMutation.isPending || moduleMutation.isPending || digestMutation.isPending;

  const prefs = {
    doNotDisturb: preferences?.doNotDisturb ?? false,
    soundEnabled: preferences?.soundEnabled ?? true,
    defaultInApp: preferences?.defaultInApp ?? true,
    defaultEmail: preferences?.defaultEmail ?? false,
    defaultPush: preferences?.defaultPush ?? true,
    defaultDesktop: preferences?.defaultDesktop ?? true,
    modulePreferences: (preferences?.modulePreferences as Record<string, ModuleChannelPreferences>) ?? {},
  };

  const handleGlobalChange = async (key: 'doNotDisturb' | 'soundEnabled', value: boolean) => {
    try {
      await globalMutation.mutateAsync({ [key]: value });
    } catch {
      toast.error(ts.messages.updateFailed);
    }
  };

  const handleDefaultChange = async (key: string, value: boolean) => {
    const fullKey = `default${key.charAt(0).toUpperCase() + key.slice(1)}`;
    try {
      await prefsMutation.mutateAsync({ [fullKey]: value });
    } catch {
      toast.error(ts.messages.updateFailed);
    }
  };

  const handleModuleToggle = async (moduleKey: string, enabled: boolean) => {
    const currentPrefs = prefs.modulePreferences[moduleKey] ?? {
      enabled: true,
      inApp: prefs.defaultInApp,
      email: prefs.defaultEmail,
      push: prefs.defaultPush,
      desktop: prefs.defaultDesktop,
    };
    const newPrefs = { ...currentPrefs, enabled };

    try {
      await moduleMutation.mutateAsync({ module: moduleKey, prefs: newPrefs });
    } catch {
      toast.error(ts.messages.moduleFailed);
    }
  };

  const handleDigestUpdate = async (updates: Partial<{
    enabled: boolean;
    sendHour: number;
    taskTypes: { projectTasks: boolean; personalTasks: boolean };
    sections: { overdue: boolean; dueToday: boolean; dueThisWeek: boolean };
  }>) => {
    const current = {
      enabled: digestSettings?.enabled ?? true,
      sendHour: digestSettings?.sendHour ?? 8,
      taskTypes: digestSettings?.taskTypes ?? { projectTasks: true, personalTasks: true },
      sections: digestSettings?.sections ?? { overdue: true, dueToday: true, dueThisWeek: true },
    };
    try {
      await digestMutation.mutateAsync({ ...current, ...updates });
    } catch {
      toast.error(ts.messages.digestFailed);
    }
  };

  // Channel table data
  const channelData = React.useMemo<ChannelRow[]>(() => [
    { id: 'inApp', label: ts.channels.inApp, icon: Bell, checked: prefs.defaultInApp, onChange: (v) => handleDefaultChange('inApp', v) },
    { id: 'email', label: ts.channels.email, icon: Mail, checked: prefs.defaultEmail, onChange: (v) => handleDefaultChange('email', v) },
    { id: 'push', label: ts.channels.push, icon: Smartphone, checked: prefs.defaultPush, onChange: (v) => handleDefaultChange('push', v) },
    { id: 'desktop', label: ts.channels.desktop, icon: Monitor, checked: prefs.defaultDesktop, onChange: (v) => handleDefaultChange('desktop', v) },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleDefaultChange is a fresh closure every render; including it would defeat this memo's caching without changing behavior.
  ], [ts.channels.inApp, ts.channels.email, ts.channels.push, ts.channels.desktop, prefs.defaultInApp, prefs.defaultEmail, prefs.defaultPush, prefs.defaultDesktop]);

  const channelColumns = React.useMemo<ColumnDef<ChannelRow>[]>(() => [
    {
      id: 'channel',
      header: '',
      cell: ({ row }) => {
        const Icon = row.original.icon;
        return (
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium text-sm">{row.original.label}</span>
          </div>
        );
      },
    },
    {
      id: 'enabled',
      header: '',
      size: 60,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Switch
            checked={row.original.checked}
            onCheckedChange={row.original.onChange}
            disabled={saving || prefs.doNotDisturb}
          />
        </div>
      ),
    },
  ], [saving, prefs.doNotDisturb]);

  const channelTable = useReactTable({
    data: channelData,
    columns: channelColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  // Module table data
  const moduleData = React.useMemo<ModuleRow[]>(() => {
    const moduleLabels: Record<string, string> = {
      helpdesk: ts.modules.helpdesk,
      crm: ts.modules.crm,
      mail: ts.modules.mail,
      projects: ts.modules.projects,
      parcel: ts.modules.parcel,
      task: ts.modules.workflows,
      weldchat: ts.modules.weldchat,
      digest: ts.modules.dailyDigest,
    };
    const mp = preferences?.modulePreferences as Record<string, ModuleChannelPreferences> | undefined;
    return NOTIFICATION_MODULES.map((module) => ({
      key: module.key,
      label: moduleLabels[module.key] || module.label,
      icon: module.icon,
      appCode: module.appCode,
      enabled: mp?.[module.key]?.enabled ?? true,
    }));
  }, [
    ts.modules.helpdesk, ts.modules.crm, ts.modules.mail,
    ts.modules.projects, ts.modules.parcel, ts.modules.workflows, ts.modules.weldchat,
    ts.modules.dailyDigest, preferences?.modulePreferences,
  ]);

  const moduleColumns = React.useMemo<ColumnDef<ModuleRow>[]>(() => [
    {
      id: 'module',
      header: '',
      cell: ({ row }) => {
        return (
          <div className="flex items-center gap-2">
            <div className="flex h-4 w-4 shrink-0 items-center justify-center">
              <AppIcon icon={row.original.appCode} className="max-h-4 max-w-4 h-auto w-auto object-contain" />
            </div>
            <span className="font-medium text-sm">{row.original.label}</span>
          </div>
        );
      },
    },
    {
      id: 'enabled',
      header: '',
      size: 60,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <Switch
            checked={row.original.enabled}
            onCheckedChange={(v) => handleModuleToggle(row.original.key, v)}
            disabled={saving || prefs.doNotDisturb}
          />
        </div>
      ),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleModuleToggle is a fresh closure every render; including it would defeat this memo's caching without changing behavior.
  ], [saving, prefs.doNotDisturb]);

  const moduleTable = useReactTable({
    data: moduleData,
    columns: moduleColumns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (loading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <div className="space-y-8">
      {/* Page Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{ts.title}</h1>
        <p className="text-muted-foreground">{ts.description}</p>
      </div>

      {/* Global Settings */}
      <div>
        <h2 className="text-lg font-semibold">{ts.globalSettings}</h2>
        <p className="text-sm text-muted-foreground mt-0.5 mb-4">{ts.globalSettingsDescription}</p>
        <div className="overflow-hidden rounded-md border border-border/70">
          <Table>
            <TableBody className="[&_tr]:border-border/70">
              <TableRow>
                <TableCell className="h-[48px] py-0 px-3">
                  <div className="flex items-center gap-2">
                    {prefs.doNotDisturb ? (
                      <BellOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Bell className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="font-medium text-sm">{ts.doNotDisturb}</span>
                  </div>
                </TableCell>
                <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                  <div className="flex justify-end">
                    <Switch
                      checked={prefs.doNotDisturb}
                      onCheckedChange={(v) => handleGlobalChange('doNotDisturb', v)}
                      disabled={saving}
                    />
                  </div>
                </TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="h-[48px] py-0 px-3">
                  <div className="flex items-center gap-2">
                    {prefs.soundEnabled ? (
                      <Volume2 className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <VolumeX className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="font-medium text-sm">{ts.notificationSound}</span>
                  </div>
                </TableCell>
                <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                  <div className="flex justify-end">
                    <Switch
                      checked={prefs.soundEnabled}
                      onCheckedChange={(v) => handleGlobalChange('soundEnabled', v)}
                      disabled={saving}
                    />
                  </div>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Default Channels */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-muted-foreground">{ts.defaultChannels}</h4>
        <div className="overflow-hidden rounded-md border border-border/70">
          <Table>
            <TableBody className="[&_tr]:border-border/70">
              {channelTable.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="h-[48px] py-0 px-3" style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Module Notifications */}
      <div className="space-y-2">
        <h4 className="text-sm font-semibold text-muted-foreground">{ts.moduleNotifications}</h4>
        <div className="overflow-hidden rounded-md border border-border/70">
          <Table>
            <TableBody className="[&_tr]:border-border/70">
              {moduleTable.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="h-[48px] py-0 px-3" style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      {/* Admin: Daily Task Digest Configuration */}
      {isAdmin && (
        <>
          <div className="!mt-16">
            <h2 className="text-lg font-semibold">{ts.digest.title}</h2>
            <p className="text-sm text-muted-foreground mt-0.5 mb-4">
              {ts.digest.description}
            </p>
            <div className="space-y-4">
              {/* Enable/Disable */}
              <div className="overflow-hidden rounded-md border border-border/70">
                <Table>
                  <TableBody className="[&_tr]:border-border/70">
                    <TableRow>
                      <TableCell className="h-[48px] py-0 px-3">
                        <div className="flex items-center gap-2">
                          <CalendarClock className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium text-sm">{ts.digest.enable}</span>
                        </div>
                      </TableCell>
                      <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                        <div className="flex justify-end">
                          <Switch
                            checked={digestSettings?.enabled ?? false}
                            onCheckedChange={(v) => handleDigestUpdate({ enabled: v })}
                            disabled={saving || digestLoading}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>

              {/* Send Time */}
              {digestSettings?.enabled && (
                <>
                  <div className="flex items-center justify-between !mt-8">
                    <div>
                      <Label className="text-sm font-medium">{ts.digest.sendTime}</Label>
                      <p className="text-sm text-muted-foreground">{ts.digest.sendTimeDescription}</p>
                    </div>
                    <Select
                      value={String(digestSettings?.sendHour ?? 8)}
                      onValueChange={(v) => handleDigestUpdate({ sendHour: parseInt(v, 10) })}
                      disabled={saving}
                    >
                      <SelectTrigger className="w-[120px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {HOUR_OPTIONS.map((opt) => {
                          const isSelected = String(digestSettings?.sendHour ?? 8) === opt.value;
                          return (
                            <SelectItem
                              key={opt.value}
                              value={opt.value}
                              className={isSelected ? 'bg-accent text-accent-foreground' : ''}
                            >
                              {opt.label}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Task Types */}
                  <div className="!mt-8 space-y-2">
                    <h4 className="text-sm font-semibold text-muted-foreground">{ts.digest.taskTypes}</h4>
                    <div className="overflow-hidden rounded-md border border-border/70">
                      <Table>
                        <TableBody className="[&_tr]:border-border/70">
                          <TableRow>
                            <TableCell className="h-[48px] py-0 px-3">
                              <span className="font-medium text-sm">{ts.digest.projectTasks}</span>
                            </TableCell>
                            <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                              <div className="flex justify-end">
                                <Switch
                                  checked={digestSettings?.taskTypes?.projectTasks ?? true}
                                  onCheckedChange={(v) =>
                                    handleDigestUpdate({
                                      taskTypes: {
                                        projectTasks: v,
                                        personalTasks: digestSettings?.taskTypes?.personalTasks ?? true,
                                      },
                                    })
                                  }
                                  disabled={saving}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="h-[48px] py-0 px-3">
                              <span className="font-medium text-sm">{ts.digest.personalTasks}</span>
                            </TableCell>
                            <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                              <div className="flex justify-end">
                                <Switch
                                  checked={digestSettings?.taskTypes?.personalTasks ?? true}
                                  onCheckedChange={(v) =>
                                    handleDigestUpdate({
                                      taskTypes: {
                                        projectTasks: digestSettings?.taskTypes?.projectTasks ?? true,
                                        personalTasks: v,
                                      },
                                    })
                                  }
                                  disabled={saving}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </div>

                  {/* Sections */}
                  <div className="!mt-8 space-y-2">
                    <h4 className="text-sm font-semibold text-muted-foreground">{ts.digest.sections}</h4>
                    <div className="overflow-hidden rounded-md border border-border/70">
                      <Table>
                        <TableBody className="[&_tr]:border-border/70">
                          <TableRow>
                            <TableCell className="h-[48px] py-0 px-3">
                              <span className="font-medium text-sm">{ts.digest.overdue}</span>
                            </TableCell>
                            <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                              <div className="flex justify-end">
                                <Switch
                                  checked={digestSettings?.sections?.overdue ?? true}
                                  onCheckedChange={(v) =>
                                    handleDigestUpdate({
                                      sections: {
                                        overdue: v,
                                        dueToday: digestSettings?.sections?.dueToday ?? true,
                                        dueThisWeek: digestSettings?.sections?.dueThisWeek ?? true,
                                      },
                                    })
                                  }
                                  disabled={saving}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="h-[48px] py-0 px-3">
                              <span className="font-medium text-sm">{ts.digest.dueToday}</span>
                            </TableCell>
                            <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                              <div className="flex justify-end">
                                <Switch
                                  checked={digestSettings?.sections?.dueToday ?? true}
                                  onCheckedChange={(v) =>
                                    handleDigestUpdate({
                                      sections: {
                                        overdue: digestSettings?.sections?.overdue ?? true,
                                        dueToday: v,
                                        dueThisWeek: digestSettings?.sections?.dueThisWeek ?? true,
                                      },
                                    })
                                  }
                                  disabled={saving}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                          <TableRow>
                            <TableCell className="h-[48px] py-0 px-3">
                              <span className="font-medium text-sm">{ts.digest.dueThisWeek}</span>
                            </TableCell>
                            <TableCell className="h-[48px] py-0 px-3" style={{ width: 60 }}>
                              <div className="flex justify-end">
                                <Switch
                                  checked={digestSettings?.sections?.dueThisWeek ?? true}
                                  onCheckedChange={(v) =>
                                    handleDigestUpdate({
                                      sections: {
                                        overdue: digestSettings?.sections?.overdue ?? true,
                                        dueToday: digestSettings?.sections?.dueToday ?? true,
                                        dueThisWeek: v,
                                      },
                                    })
                                  }
                                  disabled={saving}
                                />
                              </div>
                            </TableCell>
                          </TableRow>
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
