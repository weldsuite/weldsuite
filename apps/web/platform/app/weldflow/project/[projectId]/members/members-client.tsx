
import { useState, useCallback, useMemo, useRef } from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { useUser } from '@clerk/clerk-react';
import { useProjectMemberEvents } from '@/hooks/realtime/use-entity-events';
import type { ProjectMemberEventData, AnyPlatformEvent } from '@/lib/platform-events/types';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Label } from '@weldsuite/ui/components/label';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Search,
  Plus,
  MoreVertical,
  Trash2,
  Crown,
  Check,
  ChevronsUpDown,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { membersApi } from '@/app/weldflow/lib/api-client';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import { FilterPills, type ActiveFilter, type FilterConfig } from '@/components/entity-list';
import { TeamMemberDetailsPanel, fromProjectMember } from '@/components/team-member-details-panel';

interface ProjectMember {
  id: string;
  userId: string;
  role: string;
  isActive: boolean;
  joinedAt: string;
  allocationPercentage?: number;
  user?: {
    id: string;
    name: string;
    email: string;
    avatar?: string;
  };
}

interface AvailableUser {
  id: string;
  name: string;
  email: string;
  image?: string;
}

interface MembersClientProps {
  projectId: string;
  initialMembers: ProjectMember[];
  initialAvailableUsers: AvailableUser[];
  isAdmin: boolean;
  canWrite: boolean;
  isViewer: boolean;
}

export function MembersClient({
  projectId,
  initialMembers,
  initialAvailableUsers,
  isAdmin,
}: MembersClientProps) {
  const { t } = useI18n();
  useBreadcrumbs([
    { label: t.projects.members.projects, href: '/weldflow' },
    { label: t.projects.members.title },
  ]);

  const { user } = useUser();
  const currentUserId = user?.id;
  const [members, setMembers] = useState<ProjectMember[]>(initialMembers);
  const [availableUsers, setAvailableUsers] = useState<AvailableUser[]>(initialAvailableUsers);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [selectedMember, setSelectedMember] = useState<ProjectMember | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [userPickerOpen, setUserPickerOpen] = useState(false);
  const [selectedRole, setSelectedRole] = useState('member');
  const [allocation, setAllocation] = useState('100');

  const loadData = useCallback(async () => {
    try {
      const [membersResult, usersResult] = await Promise.all([
        membersApi.list(projectId),
        membersApi.available(projectId),
      ]);
      if (membersResult.success && membersResult.data) setMembers(membersResult.data);
      if (usersResult.success && usersResult.data) setAvailableUsers(usersResult.data);
    } catch (err) {
      console.error('Error loading members:', err);
    }
  }, [projectId]);

  const handleMemberChange = useCallback((event: AnyPlatformEvent) => {
    const memberData = event.data as ProjectMemberEventData;
    if (memberData.projectId !== projectId) return;
    loadData();
  }, [projectId, loadData]);

  useProjectMemberEvents({
    onCreated: handleMemberChange,
    onUpdated: handleMemberChange,
    onDeleted: handleMemberChange,
  });

  const handleAddMember = async () => {
    if (selectedUserIds.length === 0) {
      toast.error(t.projects.members.pleaseSelectUser);
      return;
    }
    setIsSubmitting(true);
    try {
      const results = await Promise.all(
        selectedUserIds.map((userId) =>
          membersApi.add(projectId, {
            userId,
            role: selectedRole,
            allocationPercentage: parseInt(allocation) || 100,
          }),
        ),
      );
      const succeeded = results.filter((r) => r.success).length;
      const failed = results.length - succeeded;
      if (succeeded > 0) {
        toast.success(succeeded === 1 ? t.projects.members.memberAdded : t.projects.members.membersAdded.replace('{n}', String(succeeded)));
      }
      if (failed > 0) {
        const firstError = results.find((r) => !r.success)?.error;
        toast.error(
          failed === 1
            ? firstError || t.projects.members.failedToAdd1Member
            : t.projects.members.failedToAddNMembers.replace('{n}', String(failed)),
        );
      }
      if (succeeded > 0) {
        setIsAddDialogOpen(false);
        setSelectedUserIds([]);
        setSelectedRole('member');
        setAllocation('100');
        loadData();
      }
    } catch {
      toast.error(t.projects.members.failedToAddMembers);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateRole = async (userId: string, newRole: string) => {
    const result = await membersApi.update(projectId, userId, { role: newRole });
    if (result.success) {
      toast.success(t.projects.members.roleUpdated);
      loadData();
    } else {
      toast.error(result.error || t.projects.members.failedToUpdateRole);
    }
  };

  const canDeleteMember = (member: ProjectMember) => {
    if (member.role === 'owner') return false;
    if (member.userId === currentUserId) return false;
    return true;
  };

  const handleRemoveMember = async (userId: string, userName: string) => {
    const member = members.find(m => m.userId === userId);
    if (member && !canDeleteMember(member)) {
      toast.error(
        member.role === 'owner'
          ? t.projects.members.ownerCannotBeRemoved
          : t.projects.members.cannotRemoveYourself
      );
      return;
    }
    if (!confirm(t.projects.members.confirmRemoveMember.replace('{name}', userName))) return;

    const result = await membersApi.remove(projectId, userId);
    if (result.success) {
      toast.success(t.projects.members.memberRemoved);
      loadData();
    } else {
      toast.error(result.error || t.projects.members.failedToRemoveMember);
    }
  };

  const filterConfigs: FilterConfig[] = useMemo(() => [
    {
      field: 'role',
      label: t.projects.members.filterRoleLabel,
      options: [
        { value: 'owner', label: t.projects.members.roleOwner },
        { value: 'admin', label: t.projects.members.roleAdmin },
        { value: 'member', label: t.projects.members.roleMember },
        { value: 'viewer', label: t.projects.members.roleViewer },
      ],
    },
  ], [t]);

  const filteredMembers = useMemo(() => {
    let result = members;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(m =>
        m.user?.name?.toLowerCase().includes(q) || m.user?.email?.toLowerCase().includes(q)
      );
    }
    if (activeFilters.length > 0) {
      result = result.filter(m =>
        activeFilters.every(f => {
          if (!f.value) return true;
          if (f.field === 'role') {
            const match = m.role === f.value;
            return f.operator === 'is not' ? !match : match;
          }
          return true;
        })
      );
    }
    return result;
  }, [members, searchQuery, activeFilters]);

  const formatDate = (s: string) => format(new Date(s), 'MMM d, yyyy');

  const roleBadgeClass = (role: string) => {
    switch (role) {
      case 'owner':
        return 'bg-purple-50 text-purple-700 dark:bg-purple-950/30 dark:text-purple-400';
      case 'admin':
        return 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400';
      case 'member':
        return 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400';
      case 'viewer':
        return 'bg-gray-50 text-gray-700 dark:bg-background/30 dark:text-muted-foreground';
      default:
        return 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400';
    }
  };

  const roleLabel = (role: string) =>
    role.charAt(0).toUpperCase() + role.slice(1);

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-end mb-4 gap-2">
        <FilterPills
          filters={activeFilters}
          filterConfigs={filterConfigs}
          maxFilters={3}
          onFiltersChange={setActiveFilters}
        />
        <div className="flex-1" />
        <div className="relative flex items-center">
          <div className={cn(
            'flex items-center transition-all duration-200 ease-out',
            searchOpen ? 'w-48' : 'w-8',
          )}>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-8 w-8 p-0 flex-shrink-0 shadow-none transition-opacity duration-200',
                searchOpen && 'opacity-0 pointer-events-none absolute',
              )}
              onClick={() => {
                setSearchOpen(true);
                setTimeout(() => searchInputRef.current?.focus(), 50);
              }}
            >
              <Search className="h-4 w-4" />
            </Button>
            <div className={cn(
              'relative transition-all duration-200 ease-out',
              searchOpen ? 'opacity-100 w-48' : 'opacity-0 w-0 pointer-events-none',
            )}>
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder={t.projects.members.searchMembers}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onBlur={() => { if (!searchQuery) setSearchOpen(false); }}
                className="h-8 w-full pl-8 pr-3 text-sm border border-border rounded-md bg-background focus:outline-none"
              />
            </div>
          </div>
        </div>
        {isAdmin && (
          <Button
            onClick={() => setIsAddDialogOpen(true)}
            className="h-8 text-sm px-3 flex items-center gap-2 shadow-none"
          >
            <Plus className="h-4 w-4" />
            {t.projects.members.addMember}
          </Button>
        )}
      </div>

      <div className="rounded-md border border-border/70 overflow-hidden">
        <Table>
          <TableHeader className="[&_tr]:border-border/70">
            <TableRow>
              <TableHead>{t.projects.members.columnMember}</TableHead>
              <TableHead className="w-24">{t.projects.members.columnRole}</TableHead>
              <TableHead className="w-32">{t.projects.members.columnJoined}</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {filteredMembers.map((member) => (
              <TableRow
                key={member.id}
                className="group h-[46px] cursor-pointer hover:bg-muted/50"
                onClick={() => setSelectedMember(member)}
              >
                <TableCell className="py-1.5">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-6 w-6 rounded-md">
                      {member.user?.avatar && (
                        <AvatarImage
                          src={member.user.avatar}
                          alt={member.user.name || member.user.email}
                          className="rounded-md"
                        />
                      )}
                      <AvatarFallback className="rounded-md text-xs">
                        {(member.user?.name || member.user?.email || '??')[0]?.toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{member.user?.name || t.projects.members.unknown}</span>
                      {member.role === 'owner' && (
                        <Crown className="h-3.5 w-3.5 text-amber-500" />
                      )}
                    </div>
                  </div>
                </TableCell>
                <TableCell className="py-1.5">
                  <span className={cn(
                    'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
                    roleBadgeClass(member.role),
                  )}>
                    {roleLabel(member.role)}
                  </span>
                </TableCell>
                <TableCell className="py-1.5 font-mono tabular-nums text-sm text-muted-foreground">
                  {formatDate(member.joinedAt)}
                </TableCell>
                <TableCell className="py-1.5" onClick={(e) => e.stopPropagation()}>
                  <div className="h-8 w-8 flex items-center justify-center">
                    {isAdmin && canDeleteMember(member) && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          <DropdownMenuItem onClick={() => handleUpdateRole(member.userId, 'admin')}>
                            {t.projects.members.makeAdmin}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleUpdateRole(member.userId, 'member')}>
                            {t.projects.members.makeMember}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleUpdateRole(member.userId, 'viewer')}>
                            {t.projects.members.makeViewer}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => handleRemoveMember(member.userId, member.user?.name || t.projects.members.unknown)}
                          >
                            <Trash2 className="h-4 w-4 mr-0.5" />
                            {t.projects.members.removeFromProject}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {filteredMembers.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                  {t.projects.members.noMembersFound}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <TeamMemberDetailsPanel
        member={selectedMember ? fromProjectMember(selectedMember) : null}
        isOpen={!!selectedMember}
        onClose={() => setSelectedMember(null)}
        context="projects"
        canManageMembers={isAdmin}
        onRemoveMember={(memberId) => {
          const member = members.find(m => m.id === memberId);
          if (member) {
            handleRemoveMember(member.userId, member.user?.name || t.projects.members.unknown);
            setSelectedMember(null);
          }
        }}
        onMemberUpdated={loadData}
        onRoleChange={async (memberId, newRole) => {
          const member = members.find(m => m.id === memberId);
          if (member) {
            const result = await membersApi.update(projectId, member.userId, { role: newRole.toLowerCase() });
            if (result.success) {
              toast.success(t.projects.members.roleUpdated);
              loadData();
            } else {
              toast.error(result.error || t.projects.members.failedToUpdateRole);
            }
          }
        }}
        projectsConfig={{ projectId }}
      />

      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t.projects.members.addTeamMembers}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label className="text-[13px]">{t.projects.members.selectTeamMembers}</Label>
              <Popover open={userPickerOpen} onOpenChange={setUserPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={userPickerOpen}
                    className="w-full justify-between font-normal"
                  >
                    {selectedUserIds.length === 0 ? (
                      <span className="text-muted-foreground">{t.projects.members.chooseUsers}</span>
                    ) : (
                      <span>
                        {selectedUserIds.length === 1
                          ? t.projects.members.userSelected.replace('{n}', String(selectedUserIds.length))
                          : t.projects.members.usersSelected.replace('{n}', String(selectedUserIds.length))}
                      </span>
                    )}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="p-0 w-(--radix-popover-trigger-width)"
                >
                  <Command>
                    <CommandInput placeholder={t.projects.members.searchTeamMembers} />
                    <CommandList>
                      <CommandEmpty>{t.projects.members.noTeamMembersFound}</CommandEmpty>
                      <CommandGroup>
                        {availableUsers.map((u) => {
                          const label = u.name || u.email || '';
                          const isSelected = selectedUserIds.includes(u.id);
                          return (
                            <CommandItem
                              key={u.id}
                              value={`${u.name ?? ''} ${u.email ?? ''}`}
                              onSelect={() => {
                                setSelectedUserIds((prev) =>
                                  prev.includes(u.id)
                                    ? prev.filter((id) => id !== u.id)
                                    : [...prev, u.id],
                                );
                              }}
                              className={cn(isSelected && 'bg-muted')}
                            >
                              <Avatar className="h-5 w-5 !rounded-[7px] shrink-0">
                                {u.image && (
                                  <AvatarImage src={u.image} alt={label} className="!rounded-[7px]" />
                                )}
                                <AvatarFallback className="!rounded-[7px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                                  {label.charAt(0).toUpperCase()}
                                </AvatarFallback>
                              </Avatar>
                              <span>{label}</span>
                              <Check
                                className={cn(
                                  'ml-auto h-4 w-4',
                                  isSelected ? 'opacity-100' : 'opacity-0',
                                )}
                              />
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>

              {selectedUserIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {selectedUserIds.map((userId) => {
                    const u = availableUsers.find((x) => x.id === userId);
                    const displayName = u?.name || u?.email || userId;
                    return (
                      <Badge
                        key={userId}
                        variant="secondary"
                        className="gap-1.5 pl-1 pr-1.5 py-1 !rounded-md"
                      >
                        <Avatar className="h-[18px] w-[18px] !rounded-[6px]">
                          {u?.image && (
                            <AvatarImage src={u.image} alt={displayName} className="!rounded-[6px]" />
                          )}
                          <AvatarFallback className="!rounded-[6px] text-[9px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                            {displayName.charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        {displayName}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            setSelectedUserIds((prev) => prev.filter((id) => id !== userId))
                          }
                          className="rounded-sm p-0.5 text-gray-600 dark:text-muted-foreground hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="role" className="text-[13px]">{t.projects.members.roleLabel}</Label>
              <Select value={selectedRole} onValueChange={setSelectedRole}>
                <SelectTrigger className="w-full focus:ring-0 focus:ring-offset-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="w-(--radix-select-trigger-width) min-w-(--radix-select-trigger-width)">
                  <SelectItem value="admin">{t.projects.members.adminRole}</SelectItem>
                  <SelectItem value="member">{t.projects.members.memberRole}</SelectItem>
                  <SelectItem value="viewer">{t.projects.members.viewerRole}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              {t.projects.members.cancel}
            </Button>
            <Button onClick={handleAddMember} disabled={isSubmitting || selectedUserIds.length === 0}>
              {selectedUserIds.length > 1
                ? t.projects.members.addNMembers.replace('{n}', String(selectedUserIds.length))
                : t.projects.members.addOneMember}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
