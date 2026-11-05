import { useState } from 'react';
import { toast } from 'sonner';
import {
  tabRoleOf,
  type ProjectTabRole,
  type ProjectTabSettings,
} from '@weldsuite/app-api-client/schemas/project-tabs';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { useProject } from '@/hooks/queries/use-projects-queries';
import { useProjectTabSettings, useUpdateProjectTabSettings } from '@/hooks/queries/use-project-tab-settings';
import { useProjectTabDefs, type ProjectTabDef } from '@/app/weldflow/hooks/use-project-tabs';

/** The member fields this section reads (the settings page's member rows). */
export interface TabsSectionMember {
  userId: string;
  role: string;
  isActive: boolean;
  user?: { name: string; email: string; avatar?: string };
}

interface TabsSectionProps {
  projectId: string;
  isAdmin: boolean;
  members: TabsSectionMember[];
}

const without = (list: string[], id: string) => list.filter((item) => item !== id);

/** Members and viewers: the people the role defaults and own selections apply to. */
function restrictableMembers(members: TabsSectionMember[], projectManagerId: string | null | undefined) {
  return members.filter((member) => {
    const role = member.role.toLowerCase();
    return member.isActive && (role === 'member' || role === 'viewer') && member.userId !== projectManagerId;
  });
}

export function TabsSection({ projectId, isAdmin, members }: Readonly<TabsSectionProps>) {
  const { t } = useI18n();
  const copy = t.projects.settings;
  const tabDefs = useProjectTabDefs();
  const { settings, isLoading } = useProjectTabSettings(projectId);
  const { data: projectData } = useProject(projectId);
  const mutation = useUpdateProjectTabSettings(projectId);
  const [editing, setEditing] = useState<TabsSectionMember | null>(null);

  if (isLoading) return <PageLoader fullScreen={false} />;

  const save = (next: ProjectTabSettings) =>
    mutation.mutate(next, { onError: () => toast.error(copy.tabsSaveFailed) });

  const enabledTabs = tabDefs.filter((tab) => !settings.hidden.includes(tab.id));
  const visibleCount = (hidden: string[]) => enabledTabs.filter((tab) => !hidden.includes(tab.id)).length;

  const setProjectTab = (id: string, on: boolean) =>
    save({ ...settings, hidden: on ? without(settings.hidden, id) : [...settings.hidden, id] });

  const setRoleTab = (role: ProjectTabRole, id: string, visible: boolean) => {
    const current = settings.roles[role];
    save({
      ...settings,
      roles: { ...settings.roles, [role]: visible ? without(current, id) : [...current, id] },
    });
  };

  const setMemberTabs = (userId: string, hidden: string[] | null) => {
    const others = settings.members.filter((entry) => entry.userId !== userId);
    save({ ...settings, members: hidden ? [...others, { userId, hidden }] : others });
  };

  const people = restrictableMembers(members, projectData?.data?.projectManagerId);
  const roleLabel = (role: string) =>
    tabRoleOf(role) === 'viewer' ? t.projects.members.viewerRole : t.projects.members.memberRole;

  return (
    <div className="max-w-2xl space-y-10">
      <InfoBanner variant="neutral">{copy.tabsNotice}</InfoBanner>
      {!isAdmin && <InfoBanner variant="info">{copy.tabsAdminOnly}</InfoBanner>}

      <SettingsSection title={copy.tabsProjectTitle} description={copy.tabsProjectDesc}>
        <div className="divide-y rounded-lg border">
          {tabDefs.map((tab) => {
            const on = !settings.hidden.includes(tab.id);
            const lastOne = on && enabledTabs.length <= 1;
            return (
              <div key={tab.id} className="flex items-center justify-between gap-4 px-3 py-2">
                <TabName tab={tab} note={tab.id === 'settings' ? copy.tabsAlwaysForAdmins : undefined} />
                <Switch
                  checked={on}
                  disabled={!isAdmin || lastOne}
                  onCheckedChange={(checked) => setProjectTab(tab.id, checked)}
                  aria-label={tab.name}
                />
              </div>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection title={copy.tabsRolesTitle} description={copy.tabsRolesDesc}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{copy.tabsColumnTab}</TableHead>
              <TableHead className="w-28 text-center">{copy.tabsColumnMembers}</TableHead>
              <TableHead className="w-28 text-center">{copy.tabsColumnViewers}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {enabledTabs.map((tab) => (
              <TableRow key={tab.id}>
                <TableCell className="py-1.5">
                  <TabName tab={tab} />
                </TableCell>
                {(['member', 'viewer'] as const).map((role) => {
                  const visible = !settings.roles[role].includes(tab.id);
                  const lastOne = visible && visibleCount(settings.roles[role]) <= 1;
                  return (
                    <TableCell key={role} className="py-1.5 text-center">
                      <Checkbox
                        checked={visible}
                        disabled={!isAdmin || lastOne}
                        onCheckedChange={(checked) => setRoleTab(role, tab.id, checked === true)}
                        aria-label={`${tab.name}: ${role === 'member' ? copy.tabsColumnMembers : copy.tabsColumnViewers}`}
                      />
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </SettingsSection>

      {isAdmin && (
        <SettingsSection title={copy.tabsMembersTitle} description={copy.tabsMembersDesc}>
          {people.length === 0 ? (
            <EmptyText>{copy.tabsMembersEmpty}</EmptyText>
          ) : (
            <div className="divide-y rounded-lg border">
              {people.map((member) => {
                const own = settings.members.find((entry) => entry.userId === member.userId);
                const name = member.user?.name || member.user?.email || t.projects.members.unknown;
                return (
                  <div key={member.userId} className="flex items-center justify-between gap-4 px-3 py-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Avatar className="h-6 w-6">
                        {member.user?.avatar && <AvatarImage src={member.user.avatar} alt={name} />}
                        <AvatarFallback className="text-xs">{name[0]?.toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          {name} <span className="font-normal text-muted-foreground">· {roleLabel(member.role)}</span>
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {own
                            ? copy.tabsOwnSelection
                                .replace('{count}', String(visibleCount(own.hidden)))
                                .replace('{total}', String(enabledTabs.length))
                            : copy.tabsFollowsRole}
                        </p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" className="shrink-0" onClick={() => setEditing(member)}>
                      {copy.tabsChoose}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </SettingsSection>
      )}

      {editing && (
        <MemberTabsDialog
          member={editing}
          tabs={enabledTabs}
          initialHidden={
            settings.members.find((entry) => entry.userId === editing.userId)?.hidden ??
            settings.roles[tabRoleOf(editing.role)]
          }
          hasOwn={settings.members.some((entry) => entry.userId === editing.userId)}
          onSave={(hidden) => setMemberTabs(editing.userId, hidden)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function TabName({ tab, note }: Readonly<{ tab: ProjectTabDef; note?: string }>) {
  const Icon = tab.icon;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="truncate text-sm">{tab.name}</span>
      {note && <span className="truncate text-xs text-muted-foreground">· {note}</span>}
    </div>
  );
}

/** Pick one member's own tabs, or hand them back to the default of their role. */
function MemberTabsDialog({
  member,
  tabs,
  initialHidden,
  hasOwn,
  onSave,
  onClose,
}: Readonly<{
  member: TabsSectionMember;
  tabs: ProjectTabDef[];
  initialHidden: string[];
  hasOwn: boolean;
  /** The member's hidden tabs, or null to follow the role's default again. */
  onSave: (hidden: string[] | null) => void;
  onClose: () => void;
}>) {
  const { t } = useI18n();
  const copy = t.projects.settings;
  const name = member.user?.name || member.user?.email || t.projects.members.unknown;
  const [hidden, setHidden] = useState<string[]>(initialHidden);
  const visible = tabs.filter((tab) => !hidden.includes(tab.id)).length;

  const finish = (next: string[] | null) => {
    onSave(next);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.tabsDialogTitle.replace('{name}', name)}</DialogTitle>
          <DialogDescription>{copy.tabsDialogDesc.replace('{name}', name)}</DialogDescription>
        </DialogHeader>
        <div className="max-h-[50vh] space-y-1 overflow-y-auto py-1">
          {tabs.map((tab) => {
            const checked = !hidden.includes(tab.id);
            const Icon = tab.icon;
            return (
              <label
                key={tab.id}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent"
              >
                <Checkbox
                  checked={checked}
                  disabled={checked && visible <= 1}
                  onCheckedChange={(next) =>
                    setHidden((current) => (next === true ? without(current, tab.id) : [...current, tab.id]))
                  }
                />
                <Icon className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">{tab.name}</span>
              </label>
            );
          })}
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          {hasOwn ? (
            <Button variant="ghost" onClick={() => finish(null)}>
              {copy.tabsUseRoleDefault}
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t.common.actions.cancel}
            </Button>
            <Button onClick={() => finish(hidden.filter((id) => tabs.some((tab) => tab.id === id)))} disabled={visible === 0}>
              {t.common.actions.save}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
