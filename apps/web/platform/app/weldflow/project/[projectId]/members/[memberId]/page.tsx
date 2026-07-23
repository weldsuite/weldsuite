
import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useParams, useRouter } from '@/lib/router';
import { useUser } from '@clerk/clerk-react';
import { format, formatDistanceToNow } from 'date-fns';
import {
  Mail,
  Calendar,
  User,
  Hash,
  Pencil,
  Trash2,
  UserMinus,
  CheckSquare,
  Clock,
  Loader2,
  AlertCircle,
  Percent,
} from 'lucide-react';
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@weldsuite/ui/components/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Button } from '@weldsuite/ui/components/button';
import { PersonDetailLayout } from '@/components/person-detail';
import { toast } from 'sonner';
import { membersApi } from '@/app/weldflow/lib/api-client';
import { useProjectPermissions } from '@/app/weldflow/contexts/project-permission-context';
import { PageLoader } from '@/components/page-loader';

interface ProjectMember {
  id: string;
  projectId: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  allocationPercentage?: number;
  hourlyRate?: number;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

interface MemberStats {
  tasksAssigned: number;
  tasksCompleted: number;
  hoursLogged: number;
  recentTasks: any[];
}

export default function MemberDetailPage() {
  const { t } = useI18n();
  const params = useParams();
  const router = useRouter();
  const { user } = useUser();
  const currentUserId = user?.id;
  const projectId = params.projectId as string;
  const memberId = params.memberId as string;
  const { isAdmin } = useProjectPermissions();

  const [member, setMember] = useState<ProjectMember | null>(null);
  const [stats, setStats] = useState<MemberStats>({ tasksAssigned: 0, tasksCompleted: 0, hoursLogged: 0, recentTasks: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit dialog state
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editRole, setEditRole] = useState('');
  const [editAllocation, setEditAllocation] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [memberResult, statsResult] = await Promise.all([
        membersApi.get(projectId, memberId),
        membersApi.getStats(projectId, memberId),
      ]);

      if (memberResult.success && memberResult.data) {
        setMember(memberResult.data);
        setEditRole(memberResult.data.role);
        setEditAllocation(String(memberResult.data.allocationPercentage || 100));
      } else {
        setError(memberResult.error || t.projects.members.loadingMember);
      }

      if (statsResult.success) {
        setStats(statsResult.data);
      }
    } catch (err) {
      console.error('Error loading member:', err);
      setError(t.projects.members.failedToUpdateMember);
    } finally {
      setIsLoading(false);
    }
  }, [projectId, memberId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const canDeleteMember = () => {
    if (!member) return false;
    // Cannot delete the owner
    if (member.role === 'owner') return false;
    // Cannot delete yourself
    if (member.userId === currentUserId) return false;
    return true;
  };

  const getDeleteDisabledReason = () => {
    if (!member) return null;
    if (member.role === 'owner') return t.projects.members.ownerCannotBeRemoved;
    if (member.userId === currentUserId) return t.projects.members.cannotRemoveYourself;
    return null;
  };

  const handleRemoveMember = async () => {
    if (!member || !canDeleteMember()) {
      toast.error(getDeleteDisabledReason() || t.projects.members.cannotRemoveThisMember);
      return;
    }

    if (!confirm(t.projects.members.confirmRemoveMember.replace('{name}', member.user?.name || t.projects.members.unknown))) return;

    const result = await membersApi.remove(projectId, member.userId);

    if (result.success) {
      toast.success(t.projects.members.memberRemovedFromProject);
      router.push(`/weldflow/project/${projectId}/members`);
    } else {
      toast.error(result.error || t.projects.members.failedToRemoveMemberFromProject);
    }
  };

  const handleUpdateMember = async () => {
    if (!member) return;

    setIsSubmitting(true);
    try {
      const result = await membersApi.update(projectId, member.userId, {
        role: editRole,
        allocationPercentage: parseInt(editAllocation) || 100,
      });

      if (result.success) {
        toast.success(t.projects.members.memberUpdatedSuccessfully);
        setIsEditDialogOpen(false);
        loadData();
      } else {
        toast.error(result.error || t.projects.members.failedToUpdateMember);
      }
    } catch (err) {
      toast.error(t.projects.members.failedToUpdateMember);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case 'owner': return t.projects.members.roleOwner;
      case 'admin': return t.projects.members.roleAdmin;
      case 'member': return t.projects.members.roleMember;
      case 'viewer': return t.projects.members.roleViewer;
      default: return role;
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'done':
        return <CheckSquare className="h-4 w-4 text-green-600 dark:text-green-400" />;
      case 'in_progress':
        return <Clock className="h-4 w-4 text-blue-600 dark:text-blue-400" />;
      default:
        return <CheckSquare className="h-4 w-4 text-purple-600 dark:text-purple-400" />;
    }
  };

  const getStatusBgColor = (status: string) => {
    switch (status) {
      case 'done':
        return 'bg-green-100 dark:bg-green-900/30';
      case 'in_progress':
        return 'bg-blue-100 dark:bg-blue-900/30';
      default:
        return 'bg-purple-100 dark:bg-purple-900/30';
    }
  };

  // Loading state
  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  // Error state
  if (error || !member) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex flex-col items-center gap-4">
          <AlertCircle className="h-12 w-12 text-red-400" />
          <p className="text-lg font-medium">{error || t.projects.members.memberNotFound}</p>
          <Button onClick={() => router.push(`/weldflow/project/${projectId}/members`)}>
            {t.projects.members.backToMembers}
          </Button>
        </div>
      </div>
    );
  }

  // Activity log component
  const ActivityLog = () => (
    <div className="rounded-lg border border-border/60 bg-card divide-y divide-border/60">
      {stats.recentTasks.length === 0 ? (
        <div className="p-8 text-center text-muted-foreground">
          <CheckSquare className="h-12 w-12 mx-auto mb-4 text-muted-foreground/30" />
          <p>{t.projects.members.noRecentActivity}</p>
        </div>
      ) : (
        stats.recentTasks.map((task: any) => (
          <div key={task.id} className="flex items-start gap-3 p-4">
            <div className={`h-8 w-8 rounded-full ${getStatusBgColor(task.status)} flex items-center justify-center flex-shrink-0`}>
              {getStatusIcon(task.status)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-foreground">
                {task.status === 'done' ? t.projects.members.completedTask : task.status === 'in_progress' ? t.projects.members.workingOnTask : t.projects.members.assignedToTask} task "{task.title}"
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {task.updatedAt ? formatDistanceToNow(new Date(task.updatedAt), { addSuffix: true }) : t.projects.members.recently}
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  );

  // Build dropdown items based on permissions
  const buildDropdownItems = () => {
    if (!isAdmin) return null;

    return (
      <>
        <DropdownMenuItem onClick={() => setIsEditDialogOpen(true)}>
          <Pencil className="h-3.5 w-3.5 mr-2" />
          {t.projects.members.editMember}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {canDeleteMember() ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={handleRemoveMember}
          >
            <UserMinus className="h-3.5 w-3.5 mr-2" />
            {t.projects.members.removeFromProjectMenuItem}
          </DropdownMenuItem>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="relative flex cursor-not-allowed select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none text-muted-foreground opacity-50">
                  <UserMinus className="h-3.5 w-3.5 mr-2" />
                  {t.projects.members.removeFromProjectMenuItem}
                </div>
              </TooltipTrigger>
              <TooltipContent side="left">
                <p>{getDeleteDisabledReason()}</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </>
    );
  };

  return (
    <>
      <PersonDetailLayout
        header={{
          name: member.user?.name || t.projects.members.unknown,
          avatar: member.user?.name?.slice(0, 2).toUpperCase() || '??',
          backUrl: `/weldflow/project/${projectId}/members`,
          backLabel: t.projects.members.backToMembers,
          primaryAction: member.user?.email ? {
            label: t.projects.members.emailLabel,
            icon: <Mail className="h-4 w-4" />,
            href: `mailto:${member.user.email}`,
          } : undefined,
          dropdownItems: buildDropdownItems(),
        }}
        sidebar={{
          sections: [
            {
              fields: [
                { icon: <User className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: t.projects.members.roleFieldLabel, value: getRoleBadge(member.role) },
                { icon: <Mail className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: t.projects.members.emailLabel, value: member.user?.email || '-' },
                { icon: <Hash className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: t.projects.members.idLabel, value: member.userId.slice(0, 12) },
                { icon: <Calendar className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: t.projects.members.joinedLabel, value: member.joinedAt ? format(new Date(member.joinedAt), 'MMM d, yyyy') : '-' },
              ],
            },
            {
              title: t.projects.members.allocationSection,
              fields: [
                { icon: <Percent className="h-4 w-4 text-muted-foreground flex-shrink-0" />, label: t.projects.members.allocationLabel, value: `${member.allocationPercentage || 100}%` },
              ],
            },
          ],
        }}
        content={{
          stats: [
            { label: t.projects.members.tasksAssigned, value: stats.tasksAssigned },
            { label: t.projects.members.tasksCompleted, value: stats.tasksCompleted },
            { label: t.projects.members.estHours, value: stats.hoursLogged },
          ],
          tabs: [
            { id: 'activity', label: t.projects.members.recentActivity, content: <ActivityLog /> },
          ],
          defaultTab: 'activity',
        }}
      />

      {/* Edit Member Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.projects.members.editMemberTitle}</DialogTitle>
            <DialogDescription>
              {t.projects.members.editMemberDesc.replace('{name}', member.user?.name || t.projects.members.unknown)}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="role">{t.projects.members.roleFieldLabel}</Label>
              <Select
                value={editRole}
                onValueChange={setEditRole}
                disabled={member.role === 'owner'}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {member.role === 'owner' && (
                    <SelectItem value="owner">{t.projects.members.ownerRoleOption}</SelectItem>
                  )}
                  <SelectItem value="admin">{t.projects.members.adminRoleOption}</SelectItem>
                  <SelectItem value="member">{t.projects.members.memberRoleOption}</SelectItem>
                  <SelectItem value="viewer">{t.projects.members.viewerRoleOption}</SelectItem>
                </SelectContent>
              </Select>
              {member.role === 'owner' && (
                <p className="text-xs text-muted-foreground">{t.projects.members.ownerRoleNote}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="allocation">{t.projects.members.allocationFieldLabel}</Label>
              <Input
                id="allocation"
                type="number"
                min="0"
                max="100"
                value={editAllocation}
                onChange={(e) => setEditAllocation(e.target.value)}
                placeholder={t.projects.members.allocationPlaceholder}
              />
              <p className="text-xs text-muted-foreground">
                {t.projects.members.allocationNote}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {t.projects.members.cancel}
            </Button>
            <Button onClick={handleUpdateMember} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="h-4 w-4 mr-0.5 animate-spin" />}
              {t.projects.members.saveChanges}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
