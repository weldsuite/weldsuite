/**
 * Partner team: who can sign in to the portal, and with which role.
 */

import { useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { zodResolver } from '@hookform/resolvers/zod';
import { Controller, useForm } from 'react-hook-form';
import { Loader2, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import {
  PARTNER_MEMBER_ROLES,
  partnerMemberInviteSchema,
  type PartnerMemberRole,
} from '@weldsuite/app-api-client/schemas/partners';
import type { PartnerTeamMember } from '@weldsuite/app-api-client/domains/partners';
import {
  useInvitePartnerMember,
  usePartnerTeam,
  useRemovePartnerMember,
  useUpdatePartnerMember,
} from '@/hooks/queries/use-partner-queries';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useI18n } from '@/lib/i18n/provider';
import { apiErrorCode } from '@/lib/partner/api-errors';
import { usePartnerContext } from '@/lib/partner/partner-context';
import {
  EmptyBlock,
  ErrorBlock,
  FieldMessage,
  LoadingBlock,
  PageHeader,
  errorText,
  useFormatters,
} from './components/kit';

export default function PartnerTeamPage() {
  const { t, format } = useI18n();
  const tt = t.partner.team;
  const f = useFormatters();
  const { user } = useUser();
  const { can } = usePartnerContext();
  const canManage = can('partner:team:manage');
  const { data, isLoading, error, refetch } = usePartnerTeam();
  const update = useUpdatePartnerMember();
  const remove = useRemovePartnerMember();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<PartnerTeamMember | null>(null);

  const changeRole = async (member: PartnerTeamMember, role: PartnerMemberRole) => {
    if (role === member.role) return;
    try {
      await update.mutateAsync({ memberId: member.id, body: { role } });
      toast.success(tt.roleUpdated);
    } catch (err) {
      toast.error(apiErrorCode(err) === 'LAST_OWNER' ? tt.lastOwner : errorText(err, tt.roleFailed));
    }
  };

  const onRemove = async () => {
    if (!removing) return;
    try {
      await remove.mutateAsync(removing.id);
      toast.success(tt.removed);
      setRemoving(null);
    } catch (err) {
      toast.error(apiErrorCode(err) === 'LAST_OWNER' ? tt.lastOwner : errorText(err, tt.removeFailed));
      setRemoving(null);
    }
  };

  const inviteButton = canManage ? (
    <Button onClick={() => setInviting(true)}>
      <UserPlus className="mr-1.5 h-4 w-4" aria-hidden />
      {tt.invite}
    </Button>
  ) : undefined;

  let body;
  if (isLoading) body = <LoadingBlock />;
  else if (error) body = <ErrorBlock message={errorText(error, t.partner.common.loadFailed)} onRetry={() => void refetch()} />;
  else if ((data ?? []).length === 0) body = <EmptyBlock icon={Users} title={tt.emptyTitle} action={inviteButton} />;
  else
    body = (
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tt.name}</TableHead>
              <TableHead>{tt.role}</TableHead>
              <TableHead className="hidden sm:table-cell">{tt.status}</TableHead>
              {canManage && <TableHead className="text-right">{t.partner.common.actions}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data ?? []).map((member) => {
              const isSelf = Boolean(user?.id && member.userId === user.id);
              return (
                <TableRow key={member.id}>
                  <TableCell>
                    <p className="font-medium">
                      {member.name || member.email}
                      {isSelf && <Badge variant="outline" className="ml-2">{tt.you}</Badge>}
                    </p>
                    {member.name && <p className="text-xs text-muted-foreground">{member.email}</p>}
                  </TableCell>
                  <TableCell>
                    {canManage ? (
                      <Select value={member.role} onValueChange={(v) => void changeRole(member, v as PartnerMemberRole)}>
                        <SelectTrigger className="h-8 w-[130px]" aria-label={`${tt.role}: ${member.email}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PARTNER_MEMBER_ROLES.map((role) => (
                            <SelectItem key={role} value={role}>
                              {t.partner.roles[role]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      t.partner.roles[member.role]
                    )}
                  </TableCell>
                  <TableCell className="hidden text-sm text-muted-foreground sm:table-cell">
                    {member.acceptedAt ? format(tt.joined, { date: f.date(member.acceptedAt) }) : tt.pending}
                  </TableCell>
                  {canManage && (
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setRemoving(member)}>
                        {tt.remove}
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );

  return (
    <>
      <PageHeader title={tt.title} description={tt.description} actions={inviteButton} />
      {body}
      {inviting && <InviteDialog onClose={() => setInviting(false)} />}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={format(tt.removeTitle, { email: removing?.email ?? '' })}
        description={tt.removeDescription}
        confirmLabel={tt.remove}
        cancelLabel={t.partner.common.cancel}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={onRemove}
      />
    </>
  );
}

type InviteValues = { email: string; role: PartnerMemberRole };

function InviteDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useI18n();
  const tt = t.partner.team;
  const invite = useInvitePartnerMember();
  const [failure, setFailure] = useState<string | null>(null);
  const form = useForm<InviteValues>({
    resolver: zodResolver(partnerMemberInviteSchema),
    defaultValues: { email: '', role: 'admin' },
  });

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);
    try {
      await invite.mutateAsync(values);
      toast.success(tt.invited);
      onClose();
    } catch (err) {
      setFailure(errorText(err, tt.inviteFailed));
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !invite.isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tt.inviteTitle}</DialogTitle>
          <DialogDescription>{tt.inviteDescription}</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-email">{tt.email}</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder={tt.emailPlaceholder}
              disabled={invite.isPending}
              aria-invalid={Boolean(form.formState.errors.email)}
              {...form.register('email')}
            />
            {form.formState.errors.email && <FieldMessage>{t.partner.settings.invalidEmail}</FieldMessage>}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="invite-role">{tt.role}</Label>
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} disabled={invite.isPending}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARTNER_MEMBER_ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {t.partner.roles[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <p className="text-xs text-muted-foreground">{t.partner.roles[`${form.watch('role')}Hint` as const]}</p>
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={invite.isPending}>
              {t.partner.common.cancel}
            </Button>
            <Button type="submit" disabled={invite.isPending}>
              {invite.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {tt.submitInvite}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
