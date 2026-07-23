import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { MoreVertical, RefreshCw, X } from 'lucide-react';
import { Avatar, AvatarFallback } from '@weldsuite/ui/components/avatar';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import type { Member } from '@weldsuite/core-api-client/schemas/members';

interface PendingInvitationsSectionProps {
  members: Member[];
  onResendInvite: (memberId: string) => void;
  onCancelInvite: (memberId: string) => void;
}

function getRoleLabel(role: string, st: ReturnType<typeof useTranslations>): string {
  switch (role.toUpperCase()) {
    case 'ADMIN': return st('sweep.settings.team.roles.admin');
    case 'VIEWER': return st('sweep.settings.team.roles.viewer');
    default: return st('sweep.settings.team.roles.member');
  }
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function PendingInvitationsSection({
  members,
  onResendInvite,
  onCancelInvite,
}: PendingInvitationsSectionProps) {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.team;
  const [cancellingId, setCancellingId] = React.useState<string | null>(null);

  if (members.length === 0) return null;

  const cancellingMember = cancellingId ? members.find((m) => m.id === cancellingId) : null;
  const cancellingMemberEmail: string | null =
    cancellingMember && 'email' in cancellingMember
      ? (cancellingMember as { email: string | null }).email
      : null;
  const cancellingName = cancellingMemberEmail ?? cancellingMember?.name ?? st('sweep.settings.pendingInvitations.thisMember');

  return (
    <div className="mt-8 space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{ts.pendingInvitations}</h2>
        <p className="text-sm text-muted-foreground">
          {st('sweep.settings.pendingInvitations.count', { count: members.length })}
        </p>
      </div>

      <div className="rounded-md border border-border/70 overflow-hidden">
        <Table>
          <TableHeader className="[&_tr]:border-border/70">
            <TableRow>
              <TableHead className="text-[13.5px]">{st('sweep.settings.team.table.member')}</TableHead>
              <TableHead className="text-[13.5px]">{st('sweep.settings.team.table.email')}</TableHead>
              <TableHead className="text-[13.5px]">{st('sweep.settings.team.table.role')}</TableHead>
              <TableHead className="text-[13.5px]">{st('sweep.settings.pendingInvitations.invited')}</TableHead>
              <TableHead className="w-12 text-[13.5px]" />
            </TableRow>
          </TableHeader>
          <TableBody className="[&_tr]:border-border/70">
            {members.map((member) => {
              const email = 'email' in member ? member.email : null;
              const invitedAt = 'invitedAt' in member ? (member as any).invitedAt : null;
              const roleKey = member.role.toUpperCase();

              return (
                <TableRow key={member.id} className="group h-10 hover:bg-muted/50">
                  <TableCell className="py-2">
                    <div className="flex items-center gap-2">
                      <Avatar className="h-[22px] w-[22px] rounded-md">
                        <AvatarFallback className="rounded-md text-[11px] font-mono leading-none">
                          {(member.name?.[0] || email?.[0] || '?').toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{member.name || st('sweep.settings.team.unknown')}</span>
                        {member.memberType === 'EXTERNAL_GUEST' && (
                          <span
                            className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
                            title={st('sweep.settings.team.guestTooltip')}
                          >
                            {st('sweep.settings.team.guest')}
                          </span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="py-2 text-sm text-muted-foreground">
                    {email ?? '—'}
                  </TableCell>
                  <TableCell className="py-2">
                    <span
                      className={cn(
                        'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
                        roleKey === 'ADMIN'
                          ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/30 dark:text-blue-400'
                          : roleKey === 'VIEWER'
                          ? 'bg-gray-50 text-gray-700 dark:bg-background/30 dark:text-muted-foreground'
                          : 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-400'
                      )}
                    >
                      {getRoleLabel(member.role, st)}
                    </span>
                  </TableCell>
                  <TableCell className="py-2 text-sm text-muted-foreground whitespace-nowrap">
                    {formatDate(invitedAt)}
                  </TableCell>
                  <TableCell className="py-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 rounded-lg opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                        >
                          <MoreVertical className="h-4 w-4" />
                          <span className="sr-only">{st('sweep.settings.pendingInvitations.actions')}</span>
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => onResendInvite(member.id)}>
                          <RefreshCw className="mr-2 h-4 w-4" />
                          {st('sweep.settings.team.resendInvite')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => setCancellingId(member.id)}
                          className="text-destructive focus:text-destructive"
                        >
                          <X className="mr-2 h-4 w-4" />
                          {st('sweep.settings.team.cancelInvite')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <ConfirmDialog
        open={!!cancellingId}
        onOpenChange={(open) => { if (!open) setCancellingId(null); }}
        title={ts.cancelInviteTitle}
        description={ts.cancelInviteDescription.replace('{name}', cancellingName)}
        confirmLabel={ts.cancelInviteButton}
        variant="destructive"
        onConfirm={() => {
          if (cancellingId) {
            onCancelInvite(cancellingId);
            setCancellingId(null);
          }
        }}
      />
    </div>
  );
}
