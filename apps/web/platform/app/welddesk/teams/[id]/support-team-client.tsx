
import { useState, useMemo, useCallback, useTransition } from 'react';
import { useRouter } from '@/lib/router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  EntityDetailPanel,
  type EntityField,
  type ActivityItem,
} from '@weldsuite/ui/components/entity-detail-panel';
import {
  EntityList,
  EmptyStateIllustration,
  type HeaderColumn,
  type FilterConfig,
  type GroupConfig,
  type ActiveFilter,
} from '@/components/entity-list';
import {
  EllipsisVertical,
  Users,
  MessageSquare,
  CheckCircle,
  Clock,
  Mail,
  Eye,
  Pencil,
  Trash2,
  Settings,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { memberFormSchema, type MemberFormValues } from '../hooks/use-member-form';
import { useCreateAgent } from '@/hooks/queries/use-helpdesk-queries';

interface TeamMember {
  id: string;
  name: string;
  email: string;
  avatar: string;
  role: string;
  activeTickets: number;
  resolvedToday: number;
  avgResponseTime: string;
  status: 'online' | 'away' | 'offline';
}

interface RecentFeedback {
  id: string;
  subject: string;
  customerName: string;
  status: string;
  priority: string;
  assignedTo: string;
  createdAt: string;
}

interface UserOption {
  id: string;
  email: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
}

interface SupportTeamClientProps {
  teamId: string;
  teamName: string;
  teamDescription: string;
  initialMembers: TeamMember[];
  initialFeedback: RecentFeedback[];
  users: UserOption[];
}

const statusConfigBase = {
  online: { color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950', dot: 'bg-green-500' },
  away: { color: 'text-yellow-600 dark:text-yellow-400', bg: 'bg-yellow-50 dark:bg-yellow-950', dot: 'bg-yellow-500' },
  offline: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary', dot: 'bg-gray-400' },
};

const roleConfigBase: Record<string, { color: string; bg: string }> = {
  admin: { color: 'text-purple-600 dark:text-purple-400', bg: 'bg-purple-50 dark:bg-purple-950' },
  'team lead': { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950' },
  agent: { color: 'text-gray-600 dark:text-muted-foreground', bg: 'bg-gray-100 dark:bg-secondary' },
  supervisor: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-50 dark:bg-orange-950' },
};

export function SupportTeamClient({
  teamId,
  teamName,
  teamDescription,
  initialMembers,
  initialFeedback,
  users,
}: SupportTeamClientProps) {
  // Description/feedback aren't rendered by this view yet; accepted for interface
  // parity with the page's data-loading contract.
  void teamDescription;
  void initialFeedback;
  const { t } = useI18n();
  const tm = t.helpdesk.teams;
  const router = useRouter();

  const statusConfig = useMemo(() => ({
    online: { ...statusConfigBase.online, label: tm.online },
    away: { ...statusConfigBase.away, label: tm.away },
    offline: { ...statusConfigBase.offline, label: tm.offline },
  }), [tm]);

  const roleConfig: Record<string, { label: string; color: string; bg: string }> = useMemo(() => ({
    admin: { ...roleConfigBase.admin, label: tm.admin },
    'team lead': { ...roleConfigBase['team lead'], label: tm.teamLead },
    agent: { ...roleConfigBase.agent, label: tm.agent },
    supervisor: { ...roleConfigBase.supervisor, label: tm.supervisor },
  }), [tm]);
  const members = initialMembers;
  const [selectedMember, setSelectedMember] = useState<TeamMember | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [isPending] = useTransition();
  const createAgentMutation = useCreateAgent();

  const form = useForm<MemberFormValues>({
    resolver: zodResolver(memberFormSchema),
    defaultValues: {
      userId: '',
      name: '',
      email: '',
      role: 'agent',
      status: 'active',
      availability: 'available',
      maxActiveTickets: '',
      skills: '',
      languages: '',
    },
  });

  const handleUserSelect = (userId: string) => {
    const user = users.find((u) => u.id === userId);
    if (user) {
      form.setValue('userId', user.id);
      form.setValue(
        'name',
        user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email
      );
      form.setValue('email', user.email);
    }
  };

  const onAddMember = (data: MemberFormValues) => {
    createAgentMutation.mutate(
      {
        userId: data.userId,
        name: data.name,
        email: data.email,
        role: data.role,
        departmentId: teamId,
        status: data.status,
        availability: data.availability,
        maxActiveTickets: data.maxActiveTickets ? parseInt(data.maxActiveTickets) : undefined,
        skills: data.skills ? data.skills.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        languages: data.languages ? data.languages.split(',').map((l) => l.trim()).filter(Boolean) : undefined,
      },
      {
        onSuccess: () => {
          toast.success(t.helpdesk.teamsPage.teamMemberAdded);
          setAddDialogOpen(false);
          form.reset();
        },
        onError: (error: Error) => {
          toast.error(t.helpdesk.teamsPage.failedToAddTeamMember, { description: error.message });
        },
      }
    );
  };

  const openAddDialog = () => {
    form.reset();
    setAddDialogOpen(true);
  };

  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tm.title, href: '/welddesk/teams' },
    { label: teamName },
  ]);

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'status',
      label: tm.status,
      options: [
        { value: 'online', label: tm.online },
        { value: 'away', label: tm.away },
        { value: 'offline', label: tm.offline },
      ],
    },
    {
      field: 'role',
      label: tm.role,
      options: [
        { value: 'admin', label: tm.admin },
        { value: 'team lead', label: tm.teamLead },
        { value: 'agent', label: tm.agent },
        { value: 'supervisor', label: tm.supervisor },
      ],
    },
  ], [tm]);

  // Group configs by status
  const groupConfigs: GroupConfig<TeamMember>[] = useMemo(() => [
    { id: 'online', label: tm.online, sortOrder: 1, filter: (m) => m.status === 'online' },
    { id: 'away', label: tm.away, sortOrder: 2, filter: (m) => m.status === 'away' },
    { id: 'offline', label: tm.offline, sortOrder: 3, filter: (m) => m.status === 'offline' },
  ], [tm]);

  // Apply filters
  const applyFilters = useCallback((items: TeamMember[], filters: ActiveFilter[]) => {
    let result = items;
    filters.forEach(filter => {
      if (!filter.operator || !filter.value) return;
      if (filter.field === 'status') {
        result = filter.operator === 'is'
          ? result.filter(m => m.status === filter.value)
          : result.filter(m => m.status !== filter.value);
      } else if (filter.field === 'role') {
        result = filter.operator === 'is'
          ? result.filter(m => m.role === filter.value)
          : result.filter(m => m.role !== filter.value);
      }
    });
    return result;
  }, []);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'member', header: tm.member, width: 'flex-1 min-w-[250px]' },
    { id: 'role', header: tm.role, width: 'w-[120px]' },
    { id: 'status', header: tm.status, width: 'w-[110px]' },
    { id: 'activeTickets', header: tm.activeTickets, width: 'w-[120px]' },
    { id: 'resolvedToday', header: tm.resolvedToday, width: 'w-[120px]' },
    { id: 'avgResponseTime', header: tm.avgResponse, width: 'w-[120px]' },
  ], [tm]);

  // Render row
  const renderRow = useCallback((member: TeamMember) => {
    const status = statusConfig[member.status] || statusConfig.offline;
    const role = roleConfig[member.role] || roleConfig.agent;

    return (
      <div
        key={member.id}
        onClick={() => setSelectedMember(member)}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Member */}
        <div className="flex-1 min-w-[250px] flex items-center gap-3">
          <div className="relative">
            <div className="w-8 h-8 rounded-lg bg-primary flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-medium text-primary-foreground">{member.avatar}</span>
            </div>
            <div className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white dark:border-background", status.dot)} />
          </div>
          <div className="min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
              {member.name}
            </span>
            <span className="text-xs text-gray-500 block truncate">{member.email}</span>
          </div>
        </div>

        {/* Role */}
        <div className="w-[120px]">
          <span className={cn("px-2 py-0.5 rounded text-[12px] font-medium capitalize", role.color, role.bg)}>
            {role.label}
          </span>
        </div>

        {/* Status */}
        <div className="w-[110px]">
          <span className={cn("px-2 py-0.5 rounded text-[12px] font-medium", status.color, status.bg)}>
            {status.label}
          </span>
        </div>

        {/* Active Tickets */}
        <div className="w-[120px] flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">{member.activeTickets}</span>
        </div>

        {/* Resolved Today */}
        <div className="w-[120px] flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">{member.resolvedToday}</span>
        </div>

        {/* Avg Response Time */}
        <div className="w-[120px] flex items-center gap-2">
          <Clock className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">{member.avgResponseTime}</span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSelectedMember(member)}>
                <Eye className="h-3.5 w-3.5 mr-2" />
                {tm.viewDetails}
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Pencil className="h-3.5 w-3.5 mr-2" />
                {tm.editMember}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-red-600">
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                {tm.remove}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [statusConfig, roleConfig, tm.viewDetails, tm.editMember, tm.remove]);

  // Member detail panel fields
  const getMemberFields = (member: TeamMember): EntityField[] => [
    {
      label: tm.email,
      value: (
        <div className="flex items-center gap-2">
          <Mail className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm">{member.email}</span>
        </div>
      ),
    },
    {
      label: tm.role,
      value: (() => {
        const role = roleConfig[member.role] || roleConfig.agent;
        return (
          <span className={cn("px-2 py-0.5 rounded text-[12px] font-medium capitalize", role.color, role.bg)}>
            {role.label}
          </span>
        );
      })(),
    },
    {
      label: tm.status,
      value: (() => {
        const status = statusConfig[member.status] || statusConfig.offline;
        return (
          <div className="flex items-center gap-2">
            <div className={cn("h-2 w-2 rounded-full", status.dot)} />
            <span className={cn("text-sm font-medium", status.color)}>{status.label}</span>
          </div>
        );
      })(),
    },
    {
      label: tm.activeTickets,
      value: (
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-medium">{member.activeTickets}</span>
        </div>
      ),
    },
    {
      label: tm.resolvedToday,
      value: (
        <div className="flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium">{member.resolvedToday}</span>
        </div>
      ),
    },
    {
      label: tm.avgResponseTime,
      value: (
        <div className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-medium">{member.avgResponseTime}</span>
        </div>
      ),
    },
  ];

  const getMemberActivities = (member: TeamMember): ActivityItem[] => [
    {
      id: 'joined',
      author: { name: member.name, initials: member.avatar, color: '#3b82f6' },
      action: tm.joinedTeam.replace('{team}', teamName),
      timestamp: tm.recently,
    },
  ];

  return (
    <>
      <EntityList<TeamMember>
        items={members}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        groups={groupConfigs}
        maxFilters={5}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={tm.searchMembers}
        searchFields={['name', 'email', 'role']}
        actionButtons={
          <Button variant="outline" size="sm" onClick={() => router.push(`/welddesk/teams/${teamId}/edit`)}>
            <Settings className="h-4 w-4 mr-2" />
            {tm.settings}
          </Button>
        }
        createButton={{
          label: tm.addMember,
          onClick: openAddDialog,
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
                <defs>
                  <clipPath id="member-clip-left"><circle cx="36" cy="46" r="13.4" /></clipPath>
                  <clipPath id="member-clip-right"><circle cx="84" cy="46" r="13.4" /></clipPath>
                  <clipPath id="member-clip-center"><circle cx="60" cy="56" r="15.4" /></clipPath>
                </defs>
                <circle cx="36" cy="46" r="14" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                <g clipPath="url(#member-clip-left)">
                  <circle cx="36" cy="42" r="5.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M24 60a12 12 0 0 1 24 0v4H24z" className="fill-gray-200 dark:fill-white/15" />
                </g>
                <circle cx="84" cy="46" r="14" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                <g clipPath="url(#member-clip-right)">
                  <circle cx="84" cy="42" r="5.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M72 60a12 12 0 0 1 24 0v4H72z" className="fill-gray-200 dark:fill-white/15" />
                </g>
                <circle cx="60" cy="56" r="16" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                <g clipPath="url(#member-clip-center)">
                  <circle cx="60" cy="51" r="6.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M46 72a14 14 0 0 1 28 0v4H46z" className="fill-gray-200 dark:fill-white/15" />
                </g>
              </svg>
            </EmptyStateIllustration>
          ),
          title: tm.noMembersYet,
          description: tm.noMembersDescription,
          action: {
            label: tm.addMember,
            onClick: openAddDialog,
          },
        }}
        noResultsState={{
          title: tm.noMembersFound,
          description: tm.noMembersSearchDescription,
        }}
      />

      {/* Member Detail Panel */}
      {selectedMember && (
        <EntityDetailPanel
          isOpen={!!selectedMember}
          onClose={() => setSelectedMember(null)}
          title={selectedMember.name}
          topOffset="123px"
          visibilityText={tm.memberOf.replace('{team}', teamName)}
          showHeaderActions={false}
          fields={getMemberFields(selectedMember)}
          descriptionValue={(selectedMember.activeTickets !== 1 ? tm.memberDescriptionSummaryPlural : tm.memberDescriptionSummary).replace('{role}', selectedMember.role.charAt(0).toUpperCase() + selectedMember.role.slice(1)).replace('{count}', String(selectedMember.activeTickets))}
          descriptionLabel={tm.summaryLabel}
          activities={getMemberActivities(selectedMember)}
          onShare={() => {}}
          onCopyLink={() => {}}
          onMaximize={() => router.push(`/welddesk/teams/${teamId}/members/${selectedMember.id}`)}
        />
      )}

      {/* Add Member Dialog */}
      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tm.addTeamMember}</DialogTitle>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onAddMember)} className="space-y-4">
            <div className="space-y-2">
              <Label>{tm.selectUser} *</Label>
              <Select value={form.watch('userId')} onValueChange={handleUserSelect} disabled={users.length === 0}>
                <SelectTrigger className="shadow-none">
                  <SelectValue placeholder={users.length === 0 ? tm.noUsersAvailable : tm.selectAUser} />
                </SelectTrigger>
                <SelectContent>
                  {users.length === 0 ? (
                    <div className="px-3 py-6 text-center">
                      <Users className="h-8 w-8 mx-auto mb-2 text-muted-foreground/50" />
                      <p className="text-sm font-medium text-muted-foreground">{tm.noUsersAvailable}</p>
                      <p className="text-xs text-muted-foreground/70 mt-1">{tm.inviteUsersFirst}</p>
                    </div>
                  ) : (
                    users.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email} ({user.email})
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {form.formState.errors.userId && (
                <p className="text-sm text-destructive">{form.formState.errors.userId.message}</p>
              )}
            </div>

            {form.watch('userId') && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{tm.fullName}</Label>
                  <Input {...form.register('name')} disabled className="shadow-none bg-muted" />
                </div>
                <div className="space-y-2">
                  <Label>{tm.emailAddress}</Label>
                  <Input {...form.register('email')} disabled className="shadow-none bg-muted" />
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{tm.role} *</Label>
                <Select
                  value={form.watch('role')}
                  onValueChange={(value: MemberFormValues['role']) => form.setValue('role', value)}
                >
                  <SelectTrigger className="shadow-none">
                    <SelectValue placeholder={tm.selectRole} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agent">{tm.agent}</SelectItem>
                    <SelectItem value="senior_agent">{tm.seniorAgent}</SelectItem>
                    <SelectItem value="team_lead">{tm.teamLead}</SelectItem>
                    <SelectItem value="supervisor">{tm.supervisor}</SelectItem>
                    <SelectItem value="admin">{tm.admin}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{tm.availability}</Label>
                <Select
                  value={form.watch('availability')}
                  onValueChange={(value: MemberFormValues['availability']) => form.setValue('availability', value)}
                >
                  <SelectTrigger className="shadow-none">
                    <SelectValue placeholder={tm.selectAvailability} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="available">{tm.available}</SelectItem>
                    <SelectItem value="busy">{tm.busy}</SelectItem>
                    <SelectItem value="away">{tm.away}</SelectItem>
                    <SelectItem value="offline">{tm.offline}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{tm.maxActiveTickets}</Label>
              <Input
                {...form.register('maxActiveTickets')}
                type="number"
                placeholder={tm.maxActiveTicketsPlaceholder}
                min="1"
                className="shadow-none"
              />
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAddDialogOpen(false)}>
                {tm.cancel}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? tm.adding : tm.addMember}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
