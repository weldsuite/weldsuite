import { useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { ActionDialog, Field } from '@/components/billing/action-dialog';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { addStaff, removeStaff } from '@/actions/staff';
import { formatDateTime } from '@/lib/billing-format';
import { adminCopy, fill } from '@/lib/i18n';
import { ADMIN_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type AdminRole } from '@/lib/roles';
import { normalizeStaffEmail } from '@/lib/staff';
import type { StaffPageData, StaffRow } from './data';

type Dialog =
  | { kind: 'add'; email?: string; role?: AdminRole }
  | { kind: 'role'; row: StaffRow }
  | { kind: 'remove'; row: StaffRow }
  | null;

/** The install's staff list (master admin_users): who may use this console and the CLI. */
export function StaffPage({ staff, me, canWrite }: Readonly<StaffPageData>) {
  const t = adminCopy().staff;
  const [dialog, setDialog] = useState<Dialog>(null);

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={t.title}
          description={t.description}
          actions={
            canWrite && (
              <Button size="sm" onClick={() => setDialog({ kind: 'add' })}>
                <UserPlus className="h-4 w-4" />
                {t.add}
              </Button>
            )
          }
        />
        {!canWrite && <p className="text-sm text-muted-foreground">{t.readOnly}</p>}

        <div className="overflow-hidden rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.columns.person}</TableHead>
                <TableHead className="w-32">{t.columns.role}</TableHead>
                <TableHead className="w-28">{t.columns.status}</TableHead>
                <TableHead className="w-44">{t.columns.lastSignIn}</TableHead>
                <TableHead className="w-56">{t.columns.addedBy}</TableHead>
                {canWrite && <TableHead className="w-56" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canWrite ? 6 : 5} className="py-16 text-center text-sm text-muted-foreground">
                    {t.empty}
                  </TableCell>
                </TableRow>
              )}
              {staff.map((row) => (
                <TableRow key={row.id} className={row.isActive ? 'h-12' : 'h-12 text-muted-foreground'}>
                  <TableCell>
                    <div className="font-medium">
                      {row.name ?? row.email}
                      {row.email === me && <span className="ml-1.5 text-xs text-muted-foreground">({t.you})</span>}
                    </div>
                    {row.name && <div className="text-xs text-muted-foreground">{row.email}</div>}
                  </TableCell>
                  <TableCell>{ROLE_LABELS[row.role]}</TableCell>
                  <TableCell>
                    <Badge variant={row.isActive ? 'success' : 'secondary'}>{row.isActive ? t.active : t.removed}</Badge>
                  </TableCell>
                  <TableCell className="text-xs tabular-nums">
                    {row.lastLoginAt ? formatDateTime(row.lastLoginAt) : t.never}
                  </TableCell>
                  <TableCell className="truncate text-xs">
                    {row.invitedBy ?? '—'}
                    <div className="text-muted-foreground tabular-nums">{formatDateTime(row.invitedAt)}</div>
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      {row.isActive ? (
                        <div className="flex justify-end gap-1.5">
                          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'role', row })}>
                            {t.changeRole}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: 'remove', row })}>
                            {t.remove}
                          </Button>
                        </div>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setDialog({ kind: 'add', email: row.email, role: row.role })}
                        >
                          {t.addAgain}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </PageBody>

      {dialog?.kind === 'add' && (
        <AddStaffDialog email={dialog.email} role={dialog.role} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'role' && <ChangeRoleDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'remove' && <RemoveStaffDialog row={dialog.row} onClose={() => setDialog(null)} />}
    </PageContent>
  );
}

function RoleSelect({ id, value, onChange }: Readonly<{ id: string; value: AdminRole; onChange: (role: AdminRole) => void }>) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as AdminRole)}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ADMIN_ROLES.map((role) => (
          <SelectItem key={role} value={role}>
            {ROLE_LABELS[role]} · {ROLE_DESCRIPTIONS[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function AddStaffDialog({
  email: initialEmail = '',
  role: initialRole = 'admin',
  onClose,
}: Readonly<{ email?: string; role?: AdminRole; onClose: () => void }>) {
  const t = adminCopy().staff;
  const [email, setEmail] = useState(initialEmail);
  const [name, setName] = useState('');
  const [role, setRole] = useState<AdminRole>(initialRole);
  const valid = normalizeStaffEmail(email) !== null;

  return (
    <ActionDialog
      title={t.addTitle}
      description={t.addDescription}
      submitLabel={t.addSubmit}
      invalidMessage={email === '' || valid ? null : t.errors.invalidEmail}
      onClose={onClose}
      onSubmit={async (reason) => {
        if (!valid) return { ok: false as const, error: t.errors.invalidEmail };
        return addStaff({ email, role, name: name || null, reason });
      }}
      successMessage={(data) => fill(t.added, { email: data.email, role: ROLE_LABELS[data.role] })}
    >
      <Field label={t.email} htmlFor="staff-email">
        <Input id="staff-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
      </Field>
      <Field label={t.name} htmlFor="staff-name">
        <Input id="staff-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={255} />
      </Field>
      <Field label={t.role} htmlFor="staff-role">
        <RoleSelect id="staff-role" value={role} onChange={setRole} />
      </Field>
    </ActionDialog>
  );
}

function ChangeRoleDialog({ row, onClose }: Readonly<{ row: StaffRow; onClose: () => void }>) {
  const t = adminCopy().staff;
  const [role, setRole] = useState<AdminRole>(row.role);

  return (
    <ActionDialog
      title={fill(t.changeRoleTitle, { email: row.email })}
      submitLabel={t.changeRole}
      invalidMessage={null}
      onClose={onClose}
      onSubmit={(reason) => addStaff({ email: row.email, role, reason })}
      successMessage={(data) => fill(t.roleChanged, { email: data.email, role: ROLE_LABELS[data.role] })}
    >
      <Field label={t.role} htmlFor="staff-change-role">
        <RoleSelect id="staff-change-role" value={role} onChange={setRole} />
      </Field>
    </ActionDialog>
  );
}

function RemoveStaffDialog({ row, onClose }: Readonly<{ row: StaffRow; onClose: () => void }>) {
  const t = adminCopy().staff;

  return (
    <ActionDialog
      title={fill(t.removeTitle, { email: row.email })}
      description={t.removeDescription}
      submitLabel={t.remove}
      destructive
      onClose={onClose}
      onSubmit={(reason) => removeStaff({ email: row.email, reason })}
      successMessage={(data) => fill(t.removedToast, { email: data.email })}
    />
  );
}
