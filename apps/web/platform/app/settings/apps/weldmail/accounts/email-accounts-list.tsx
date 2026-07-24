import { getTranslations } from '@/lib/i18n';
import { useMemo, useState, useTransition } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@weldsuite/ui/components/avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { MemberDetailPanel } from '@/components/settings/member-detail-panel';
import type { TeamMember } from '@/components/settings/team-section';
import {
  ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { Button } from '@weldsuite/ui/components/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Trash2,
  Users,
  Loader2,
  EllipsisVertical,
  Pencil,
} from 'lucide-react';
import { useDeleteMailAccount } from '@/hooks/queries/use-mail-queries';
import { toast } from 'sonner';
import { AiSettingsDialog } from './ai-settings-dialog';
import { ManageAccessDialog } from './manage-access-dialog';
import { EditAccountDialog } from './edit-account-dialog';

interface EmailAccount {
  id: string;
  email: string;
  displayName?: string;
  provider?: string;
  isShared?: boolean;
  assignedUserIds?: string[];
  isActive?: boolean;
  lastSyncAt?: string;
  status?: 'active' | 'inactive' | 'error' | 'suspended' | 'quota_exceeded';
  aiSettings?: {
    customInstructions?: string;
    defaultTone?: 'professional' | 'friendly' | 'casual';
    defaultLength?: 'short' | 'medium' | 'long';
    modelPreference?: string;
  };
}

interface EmailAccountsListProps {
  accounts: EmailAccount[];
}

interface RawWorkspaceMember {
  id: string;
  auth0Id?: string | null;
  userId?: string | null;
  email?: string;
  name?: string | null;
  picture?: string | null;
  role?: string;
  workspaceRole?: string;
  status?: string;
  hoursPerWeek?: string | null;
  createdAt?: string;
}

export function EmailAccountsList({ accounts }: EmailAccountsListProps) {
  const ts = getTranslations('settings');
  const ta = ts.weldmail.accounts;
  const deleteAccountMutation = useDeleteMailAccount();
  const [isPending, startTransition] = useTransition();
  const [deletingAccount, setDeletingAccount] = useState<EmailAccount | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [aiSettingsAccount, setAiSettingsAccount] = useState<EmailAccount | null>(null);
  const [aiSettingsDialogOpen, setAiSettingsDialogOpen] = useState(false);
  const [accessAccount, setAccessAccount] = useState<EmailAccount | null>(null);
  const [accessDialogOpen, setAccessDialogOpen] = useState(false);
  const [editAccount, setEditAccount] = useState<EmailAccount | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [selectedMemberUserId, setSelectedMemberUserId] = useState<string | null>(null);

  const { data: membersData } = useWorkspaceMembers(1, 100);

  const rawMemberByUserId = useMemo(() => {
    const map = new Map<string, RawWorkspaceMember>();
    for (const m of (membersData?.data ?? []) as RawWorkspaceMember[]) {
      if (m.userId) map.set(m.userId, m);
    }
    return map;
  }, [membersData]);

  const selectedMember: TeamMember | null = useMemo(() => {
    if (!selectedMemberUserId) return null;
    const m = rawMemberByUserId.get(selectedMemberUserId);
    if (!m) return null;
    return {
      id: m.id,
      auth0Id: m.auth0Id ?? null,
      userId: m.userId ?? null,
      email: m.email ?? '',
      name: m.name ?? null,
      picture: m.picture ?? null,
      role: (m.role || 'USER') as TeamMember['role'],
      workspaceRole: m.workspaceRole,
      status: m.status as TeamMember['status'],
      hoursPerWeek: m.hoursPerWeek ?? null,
      createdAt: m.createdAt ? new Date(m.createdAt) : new Date(),
    };
  }, [rawMemberByUserId, selectedMemberUserId]);
  const allMembers: { userId: string; name: string; avatar?: string }[] = useMemo(() => {
    return ((membersData?.data ?? []) as RawWorkspaceMember[])
      .filter((m): m is RawWorkspaceMember & { userId: string } => !!m.userId)
      .map((m) => ({
        userId: m.userId,
        name: m.name || m.email || 'Member',
        avatar: m.picture || undefined,
      }));
  }, [membersData]);
  const memberById = useMemo(() => {
    const map = new Map<string, { userId: string; name: string; avatar?: string }>();
    for (const m of allMembers) map.set(m.userId, m);
    return map;
  }, [allMembers]);

  const handleDelete = async () => {
    if (!deletingAccount) return;

    startTransition(async () => {
      try {
        // DELETE resolves with no body (204), so there is no `success` flag to
        // check — a resolved promise means the account was deleted. Checking a
        // non-existent `result.success` previously sent every successful delete
        // down the error path, leaving the dialog open; a retry then hit the
        // already soft-deleted row and 404'd.
        await deleteAccountMutation.mutateAsync(deletingAccount.id);
        toast.success(ta.messages.deleted);
        setDeleteDialogOpen(false);
        setDeletingAccount(null);
      } catch {
        toast.error(ta.messages.deleteFailed);
      }
    });
  };

  const columns: ColumnDef<EmailAccount>[] = [
    {
      accessorKey: 'email',
      header: ta.columns.email,
      size: 250,
      cell: ({ row }) => (
        <span className="font-medium">{row.original.email}</span>
      ),
    },
    {
      accessorKey: 'displayName',
      header: ta.columns.name,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.displayName || '—'}
        </span>
      ),
    },
    {
      id: 'access',
      header: ta.columns.access,
      size: 160,
      cell: ({ row }) => {
        const account = row.original;

        if (account.isShared) {
          return (
            <Tooltip delayDuration={150}>
              <TooltipTrigger asChild>
                <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-gray-100 dark:bg-secondary text-gray-600 dark:text-muted-foreground cursor-default">
                  {ta.shared}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {ta.sharedTooltip}
              </TooltipContent>
            </Tooltip>
          );
        }

        const users = (account.assignedUserIds ?? [])
          .map((id) => memberById.get(id))
          .filter((u): u is { userId: string; name: string; avatar?: string } => !!u);

        if (users.length === 0) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }

        const visible = users.slice(0, 3);
        const overflow = users.length - visible.length;

        return (
          <div className="flex items-center">
            <div className="flex -space-x-1.5">
              {visible.map((u) => {
                const avatar = (
                  <Avatar
                    key={u.userId}
                    className="h-5 w-5 !rounded-[7px] ring-1 ring-background"
                    title={u.name}
                  >
                    {u.avatar && <AvatarImage src={u.avatar} alt={u.name} className="!rounded-[7px]" />}
                    <AvatarFallback className="!rounded-[7px] text-[10px] font-medium bg-gray-200 dark:bg-accent text-gray-600 dark:text-muted-foreground">
                      {u.name.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                );
                return (
                  <Tooltip key={u.userId} delayDuration={150}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setSelectedMemberUserId(u.userId)}
                        className="inline-flex cursor-pointer focus:outline-none"
                      >
                        {avatar}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={4}>
                      {u.name}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              {overflow > 0 && (
                <div className="relative z-10 w-5 h-5 !rounded-[7px] bg-gray-300 dark:bg-accent flex items-center justify-center ring-1 ring-background">
                  <span className="text-[9px] font-medium text-gray-600 dark:text-muted-foreground">
                    +{overflow}
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const account = row.original;

        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-8 w-8 p-0 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                >
                  <span className="sr-only">{ta.openMenu}</span>
                  <EllipsisVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={() => {
                    setEditAccount(account);
                    setEditDialogOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4 mr-0.5" />
                  {ta.menuEdit}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setAccessAccount(account);
                    setAccessDialogOpen(true);
                  }}
                >
                  <Users className="h-4 w-4 mr-0.5" />
                  {ta.menuManageAccess}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setAiSettingsAccount(account);
                    setAiSettingsDialogOpen(true);
                  }}
                >
                  <img
                    src="/assets/images/weldagent/logo-light.png"
                    alt="WeldAgent"
                    className="h-4 w-4 mr-0.5 grayscale opacity-70"
                  />
                  {ta.menuAiSettings}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    setDeletingAccount(account);
                    setDeleteDialogOpen(true);
                  }}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                >
                  <Trash2 className="h-4 w-4 mr-0.5 text-destructive" />
                  {ta.menuDelete}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        );
      },
    },
  ];

  const table = useReactTable({
    data: accounts,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="text-[13.5px]" style={{ width: header.getSize() }}>
                    {header.isPlaceholder
                      ? null
                      : flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="group">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className="h-[42px] py-0 px-3" style={{ width: cell.column.getSize() }}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  {ta.noResults}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{ta.deleteTitle}</DialogTitle>
            <DialogDescription>
              {ta.deleteDescription.replace('{email}', deletingAccount?.email ?? '')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              {ta.cancel}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              className="text-white"
            >
              {isPending ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  {ta.deleting}
                </>
              ) : (
                ta.deleteButton
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI Settings Dialog */}
      {aiSettingsAccount && (
        <AiSettingsDialog
          open={aiSettingsDialogOpen}
          onOpenChange={setAiSettingsDialogOpen}
          accountId={aiSettingsAccount.id}
          accountEmail={aiSettingsAccount.email}
          defaultValues={aiSettingsAccount.aiSettings}
        />
      )}

      {/* Manage Access Dialog */}
      {accessAccount && (
        <ManageAccessDialog
          open={accessDialogOpen}
          onOpenChange={setAccessDialogOpen}
          accountId={accessAccount.id}
          accountEmail={accessAccount.email}
          defaultIsShared={accessAccount.isShared ?? true}
          defaultAssignedUserIds={accessAccount.assignedUserIds ?? []}
        />
      )}

      {/* Edit Account Dialog */}
      {editAccount && (
        <EditAccountDialog
          open={editDialogOpen}
          onOpenChange={setEditDialogOpen}
          accountId={editAccount.id}
          accountEmail={editAccount.email}
          defaultValues={{
            displayName: editAccount.displayName,
          }}
        />
      )}

      {/* Team Member Detail Panel — opened by clicking an avatar in the Access column */}
      <MemberDetailPanel
        member={selectedMember}
        isOpen={!!selectedMember}
        onClose={() => setSelectedMemberUserId(null)}
        canManageMembers={false}
        onRemoveMember={() => {}}
        onMemberUpdated={() => {}}
      />
    </>
  );
}
