
import { useMemo, useCallback, useState, useTransition } from 'react';
import { Link, useRouter } from '@/lib/router';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { MoreVertical, Eye, Users, MessageSquare, CheckCircle, Clock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
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
  DialogDescription,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { EntityList, EmptyStateIllustration, type HeaderColumn, type FilterConfig } from '@/components/entity-list';
import { departmentFormSchema, type DepartmentFormValues } from './hooks/use-department-form';
import { useCreateDepartment } from '@/hooks/queries/use-helpdesk-queries';

interface Team {
  id: string;
  name: string;
  description: string;
  members: number;
  activeTickets: number;
  resolvedToday: number;
  avgResponseTime: string;
  color: string;
}

interface TeamsClientProps {
  teams: Team[];
}

export function TeamsClient({ teams }: TeamsClientProps) {
  const { t } = useI18n();
  const tm = t.helpdesk.teams;
  const router = useRouter();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isPending] = useTransition();
  const createDepartmentMutation = useCreateDepartment();

  const form = useForm<DepartmentFormValues>({
    resolver: zodResolver(departmentFormSchema),
    defaultValues: {
      name: '',
      description: '',
      email: '',
      autoAssignment: false,
      roundRobinAssignment: false,
      defaultPriority: 'medium',
      isActive: true,
    },
  });

  const onSubmit = (data: DepartmentFormValues) => {
    createDepartmentMutation.mutate(
      {
        name: data.name,
        description: data.description || undefined,
        email: data.email || undefined,
        autoAssignment: data.autoAssignment,
        roundRobinAssignment: data.roundRobinAssignment,
        defaultPriority: data.defaultPriority,
        isActive: data.isActive,
      },
      {
        onSuccess: (result) => {
          toast.success(t.helpdesk.teamsPage.teamCreated);
          setDialogOpen(false);
          form.reset();
          if (result?.id) {
            router.push(`/welddesk/teams/${result.id}`);
          }
        },
        onError: (error: Error) => {
          toast.error(t.helpdesk.teamsPage.failedToCreateTeam, { description: error.message });
        },
      }
    );
  };

  // Filter configs
  const filterConfigs: FilterConfig[] = useMemo(() => [], []);
  useBreadcrumbs([
    { label: t.helpdesk.title, href: '/welddesk' },
    { label: tm.title },
  ]);

  // Apply filters (no filters for teams, but keep the structure)
  const applyFilters = useCallback((items: Team[]) => {
    return items;
  }, []);

  // Header columns
  const headerColumns: HeaderColumn[] = useMemo(() => [
    { id: 'name', header: tm.team, width: 'flex-1 min-w-[250px]' },
    { id: 'members', header: tm.members, width: 'w-[100px]' },
    { id: 'activeTickets', header: tm.activeTickets, width: 'w-[120px]' },
    { id: 'resolvedToday', header: tm.resolvedToday, width: 'w-[120px]' },
    { id: 'avgResponseTime', header: tm.avgResponse, width: 'w-[120px]' },
  ], [tm]);

  // Render row
  const renderRow = useCallback((team: Team) => {
    return (
      <div
        key={team.id}
        onClick={() => router.push(`/welddesk/teams/${team.id}`)}
        className="flex items-center gap-4 px-4 py-3 hover:bg-gray-50 dark:hover:bg-secondary/50 cursor-pointer border-b border-gray-200/70 dark:border-border group"
      >
        {/* Team Name */}
        <div className="flex-1 min-w-[250px] flex items-center gap-3">
          <div className={`h-9 w-9 rounded-lg ${team.color} flex items-center justify-center flex-shrink-0`}>
            <Users className="h-[18px] w-[18px] text-white" />
          </div>
          <div className="min-w-0">
            <span className="text-sm font-medium text-gray-900 dark:text-foreground block truncate">
              {team.name}
            </span>
            <span className="text-xs text-gray-500 block truncate">{team.description}</span>
          </div>
        </div>

        {/* Members */}
        <div className="w-[100px] flex items-center gap-2">
          <Users className="h-4 w-4 text-gray-400" />
          <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">{team.members}</span>
        </div>

        {/* Active Tickets */}
        <div className="w-[120px] flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">{team.activeTickets}</span>
        </div>

        {/* Resolved Today */}
        <div className="w-[120px] flex items-center gap-2">
          <CheckCircle className="h-4 w-4 text-green-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">{team.resolvedToday}</span>
        </div>

        {/* Avg Response Time */}
        <div className="w-[120px] flex items-center gap-2">
          <Clock className="h-4 w-4 text-blue-500" />
          <span className="text-sm font-medium text-gray-700 dark:text-muted-foreground">{team.avgResponseTime}</span>
        </div>

        {/* Actions */}
        <div className="w-[40px] flex justify-end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 data-[state=open]:bg-accent">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/welddesk/teams/${team.id}`} className="flex items-center">
                  <Eye className="h-4 w-4 mr-0.5" />
                  {tm.viewDetails}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem>
                {tm.manageMembers}
              </DropdownMenuItem>
              <DropdownMenuItem>
                {tm.viewAnalytics}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  }, [router, tm]);

  const openCreateDialog = () => {
    form.reset();
    setDialogOpen(true);
  };

  return (
    <>
      <EntityList<Team>
        items={teams}
        isLoading={false}
        error={null}
        headerColumns={headerColumns}
        filters={filterConfigs}
        maxFilters={5}
        applyFilters={applyFilters}
        renderRow={renderRow}
        searchPlaceholder={tm.searchTeams}
        searchFields={['name', 'description']}
        createButton={{
          label: tm.newTeam,
          onClick: openCreateDialog,
        }}
        emptyState={{
          icon: (
            <EmptyStateIllustration>
              <svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" opacity="0.45">
                <defs>
                  <clipPath id="teams-clip-left"><circle cx="36" cy="46" r="13.4" /></clipPath>
                  <clipPath id="teams-clip-right"><circle cx="84" cy="46" r="13.4" /></clipPath>
                  <clipPath id="teams-clip-center"><circle cx="60" cy="56" r="15.4" /></clipPath>
                </defs>
                {/* Back-left person */}
                <circle cx="36" cy="46" r="14" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                <g clipPath="url(#teams-clip-left)">
                  <circle cx="36" cy="42" r="5.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M24 60a12 12 0 0 1 24 0v4H24z" className="fill-gray-200 dark:fill-white/15" />
                </g>
                {/* Back-right person */}
                <circle cx="84" cy="46" r="14" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                <g clipPath="url(#teams-clip-right)">
                  <circle cx="84" cy="42" r="5.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M72 60a12 12 0 0 1 24 0v4H72z" className="fill-gray-200 dark:fill-white/15" />
                </g>
                {/* Front-center person (larger, overlaps) */}
                <circle cx="60" cy="56" r="16" className="fill-white dark:fill-white/[0.03] stroke-gray-300 dark:stroke-white/15" strokeWidth="1.2" />
                <g clipPath="url(#teams-clip-center)">
                  <circle cx="60" cy="51" r="6.5" className="fill-gray-200 dark:fill-white/15" />
                  <path d="M46 72a14 14 0 0 1 28 0v4H46z" className="fill-gray-200 dark:fill-white/15" />
                </g>
              </svg>
            </EmptyStateIllustration>
          ),
          title: tm.noTeamsFound,
          description: tm.noTeamsDescription,
          action: {
            label: tm.newTeam,
            onClick: openCreateDialog,
          },
        }}
        noResultsState={{
          title: tm.noTeamsFound,
          description: tm.noTeamsSearchDescription,
        }}
      />

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{tm.createNewTeam}</DialogTitle>
            <DialogDescription>{tm.createTeamDescription}</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">{tm.teamName} *</Label>
              <Input
                id="name"
                {...form.register('name')}
                placeholder={tm.teamNamePlaceholder}
                className="shadow-none"
              />
              {form.formState.errors.name && (
                <p className="text-sm text-destructive">{form.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">{tm.description}</Label>
              <Textarea
                id="description"
                {...form.register('description')}
                placeholder={tm.descriptionPlaceholder}
                rows={3}
                className="shadow-none"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">{tm.teamEmail}</Label>
              <Input
                id="email"
                {...form.register('email')}
                type="email"
                placeholder={tm.emailPlaceholder}
                className="shadow-none"
              />
              {form.formState.errors.email && (
                <p className="text-sm text-destructive">{form.formState.errors.email.message}</p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="dialog-autoAssignment">{tm.autoAssignment}</Label>
                <p className="text-sm text-muted-foreground">{tm.autoAssignmentDescription}</p>
              </div>
              <Switch
                id="dialog-autoAssignment"
                checked={form.watch('autoAssignment')}
                onCheckedChange={(checked) => form.setValue('autoAssignment', checked)}
              />
            </div>

            <div className="space-y-2">
              <Label>{tm.defaultPriority}</Label>
              <Select
                value={form.watch('defaultPriority')}
                onValueChange={(value: DepartmentFormValues['defaultPriority']) => form.setValue('defaultPriority', value)}
              >
                <SelectTrigger className="shadow-none">
                  <SelectValue placeholder={tm.selectDefaultPriority} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">{t.helpdesk.triggerPanel.priorityLow}</SelectItem>
                  <SelectItem value="medium">{t.helpdesk.triggerPanel.priorityMedium}</SelectItem>
                  <SelectItem value="high">{t.helpdesk.triggerPanel.priorityHigh}</SelectItem>
                  <SelectItem value="urgent">{t.helpdesk.triggerPanel.priorityUrgent}</SelectItem>
                  <SelectItem value="critical">{t.helpdesk.triggerPanel.priorityCritical}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                {tm.cancel}
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? tm.creating : tm.createTeam}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
