'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { PARTNER_MEMBER_ROLES, type PartnerMemberRole } from '@weldsuite/app-api-client/schemas/partners';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { invitePartnerMember, removePartnerMember } from '@/actions/partners';
import { Field } from '@/components/billing/action-dialog';
import { useSubmit } from '@/components/partners/use-submit';
import { formatDay, newRequestId } from '@/lib/billing-format';
import type { AdminPartnerMember } from '@/lib/partners';
import { fill } from '@/lib/i18n';
import { partnersCopy } from '@/lib/partners-copy';
import type { PartnerTabProps } from './partner-detail';

export function MembersTab({ detail, canWrite }: Readonly<PartnerTabProps>) {
  const t = partnersCopy();
  const router = useRouter();
  const { submit, isPending } = useSubmit();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<PartnerMemberRole>('admin');
  const [removeTarget, setRemoveTarget] = useState<AdminPartnerMember | null>(null);

  const onInvite = () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return void toast.error(`${t.members.email}: invalid email`);
    submit((requestId) => invitePartnerMember(detail.partner.id, { email: email.trim(), role }, requestId), {
      success: t.members.invitedToast,
      onSuccess: () => {
        setEmail('');
        router.refresh();
      },
    });
  };

  const onRemove = async () => {
    if (!removeTarget) return;
    const target = removeTarget;
    const result = await removePartnerMember(detail.partner.id, target.id, newRequestId());
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(t.members.removed);
    setRemoveTarget(null);
    router.refresh();
  };

  return (
    <div className="space-y-4">
      <Card className="py-4">
        <CardContent className="space-y-3 px-4">
          <div>
            <h2 className="text-sm font-medium">{t.members.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t.members.description}</p>
          </div>
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.members.email}</TableHead>
                  <TableHead className="w-32">{t.members.role}</TableHead>
                  <TableHead className="w-40">{t.members.status}</TableHead>
                  {canWrite && <TableHead className="w-28" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.members.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canWrite ? 4 : 3} className="py-8 text-center text-sm text-muted-foreground">
                      {t.members.empty}
                    </TableCell>
                  </TableRow>
                )}
                {detail.members.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="font-medium">{m.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{t.roles[m.role] ?? m.role}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.acceptedAt ? `${t.members.accepted} ${formatDay(m.acceptedAt)}` : t.members.invited}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => setRemoveTarget(m)}>
                          {t.common.remove}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {canWrite && (
        <Card className="py-4">
          <CardContent className="space-y-3 px-4">
            <h2 className="text-sm font-medium">{t.members.invite}</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
              <Field label={t.members.email} htmlFor="member-email">
                <Input id="member-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={isPending} maxLength={255} />
              </Field>
              <Field label={t.members.role}>
                <Select value={role} onValueChange={(v) => setRole(v as PartnerMemberRole)} disabled={isPending}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PARTNER_MEMBER_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {t.roles[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Button disabled={isPending} onClick={onInvite}>
                {isPending ? t.common.working : t.members.inviteSubmit}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={t.members.removeTitle}
        description={removeTarget ? fill(t.members.removeConfirm, { email: removeTarget.email, partner: detail.partner.name }) : ''}
        confirmLabel={t.common.remove}
        cancelLabel={t.common.cancel}
        variant="destructive"
        onConfirm={onRemove}
      />
    </div>
  );
}
