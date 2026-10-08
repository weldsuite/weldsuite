import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
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
import { Textarea } from '@weldsuite/ui/components/textarea';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useCreateLockException,
  useLockExceptions,
  useRevokeLockException,
} from '@/hooks/queries/use-accounting-queries';
import { useWorkspaceMemberDirectory } from '@/hooks/queries/use-settings-queries';
import type { LockDateException, LockType } from '@/lib/api/domains/weldbooks';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { useI18n } from '@/lib/i18n/provider';

const LOCK_TYPES: readonly LockType[] = ['sales', 'purchase', 'tax', 'period'];
const EVERYONE = '__everyone__';
const MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DDTHH:mm` in local time, for a datetime-local input. */
function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function exceptionStatus(exception: LockDateException, now: number): 'active' | 'expired' | 'revoked' {
  if (exception.revokedAt) return 'revoked';
  return new Date(exception.endsAt).getTime() <= now ? 'expired' : 'active';
}

interface LockExceptionsCardProps {
  entityId: string;
  canUpdate: boolean;
}

/** Time-limited, logged permissions to post into a locked period. */
export function LockExceptionsCard({ entityId, canUpdate }: Readonly<LockExceptionsCardProps>) {
  const { t } = useI18n();
  const te = t.accounting.lockDates.exceptions;
  const tl = t.accounting.lockDates;
  const { formatDateTime } = useWeldbooksFormat();

  const exceptionsQuery = useLockExceptions(entityId);
  const { data: membersData } = useWorkspaceMemberDirectory(canUpdate || (exceptionsQuery.data?.length ?? 0) > 0);
  const createException = useCreateLockException();
  const revokeException = useRevokeLockException();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [lockType, setLockType] = useState<LockType>('period');
  const [userId, setUserId] = useState<string>(EVERYONE);
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<LockDateException | null>(null);

  const members = useMemo(() => membersData?.data ?? [], [membersData]);
  const memberName = (id: string | null) => {
    if (!id) return te.everyone;
    const member = members.find((m) => m.userId === id);
    return member?.name || member?.email || id;
  };

  const openDialog = () => {
    setLockType('period');
    setUserId(EVERYONE);
    setEndsAt(toLocalInputValue(new Date(Date.now() + DAY_MS)));
    setReason('');
    setFormError(null);
    setDialogOpen(true);
  };

  const submit = async () => {
    const ends = new Date(endsAt);
    const now = Date.now();
    if (Number.isNaN(ends.getTime()) || ends.getTime() <= now || ends.getTime() > now + MAX_DAYS * DAY_MS) {
      setFormError(te.endsAtInvalid);
      return;
    }
    if (!reason.trim()) {
      setFormError(te.reasonRequired);
      return;
    }
    setFormError(null);
    try {
      await createException.mutateAsync({
        entityId,
        data: {
          lockType,
          userId: userId === EVERYONE ? null : userId,
          endsAt: ends.toISOString(),
          reason: reason.trim(),
        },
      });
      toast.success(te.created);
      setDialogOpen(false);
    } catch (err) {
      toast.error(te.createFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    try {
      await revokeException.mutateAsync({ entityId, exceptionId: revoking.id });
      toast.success(te.revoked);
      setRevoking(null);
    } catch (err) {
      toast.error(te.revokeFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const now = Date.now();
  const exceptions = exceptionsQuery.data ?? [];
  const nowInput = toLocalInputValue(new Date(now));
  const maxInput = toLocalInputValue(new Date(now + MAX_DAYS * DAY_MS));

  const renderBody = () => {
    if (exceptionsQuery.isLoading) {
      return <p className="text-sm text-muted-foreground">…</p>;
    }
    if (exceptionsQuery.isError) {
      return (
        <div className="flex items-center gap-3">
          <p className="text-sm text-destructive">{te.loadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void exceptionsQuery.refetch()}>
            {t.accounting.layout.retry}
          </Button>
        </div>
      );
    }
    if (exceptions.length === 0) {
      return <p className="text-sm text-muted-foreground">{te.empty}</p>;
    }
    return (
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{te.colLock}</TableHead>
              <TableHead>{te.colMember}</TableHead>
              <TableHead>{te.colEndsAt}</TableHead>
              <TableHead>{te.colReason}</TableHead>
              <TableHead>{te.colStatus}</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {exceptions.map((exception) => {
              const status = exceptionStatus(exception, now);
              const statusLabel = {
                active: te.statusActive,
                expired: te.statusExpired,
                revoked: te.statusRevoked,
              }[status];
              return (
                <TableRow key={exception.id}>
                  <TableCell>{te.lockTypes[exception.lockType] ?? exception.lockType}</TableCell>
                  <TableCell>{memberName(exception.userId)}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDateTime(exception.endsAt)}</TableCell>
                  <TableCell className="max-w-[260px] truncate" title={exception.reason}>
                    {exception.reason}
                  </TableCell>
                  <TableCell>
                    <Badge variant={status === 'active' ? 'secondary' : 'outline'}>{statusLabel}</Badge>
                  </TableCell>
                  <TableCell>
                    {canUpdate && status === 'active' ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setRevoking(exception)}>
                        {te.revoke}
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    );
  };

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:space-y-0">
        <div className="space-y-1.5">
          <CardTitle>{te.title}</CardTitle>
          <CardDescription>{te.description}</CardDescription>
        </div>
        {canUpdate && (
          <Button type="button" variant="outline" size="sm" onClick={openDialog}>
            <Plus className="h-4 w-4 mr-1" />
            {te.add}
          </Button>
        )}
      </CardHeader>
      <CardContent>{renderBody()}</CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{te.dialogTitle}</DialogTitle>
            <DialogDescription>{te.description}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="lock-exception-type">{te.lockType}</Label>
              <Select value={lockType} onValueChange={(v) => setLockType(v as LockType)}>
                <SelectTrigger id="lock-exception-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LOCK_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {te.lockTypes[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lock-exception-member">{te.member}</Label>
              <Select value={userId} onValueChange={setUserId}>
                <SelectTrigger id="lock-exception-member">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={EVERYONE}>{te.everyone}</SelectItem>
                  {members.map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.name || member.email || member.userId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lock-exception-ends">{te.endsAt}</Label>
              <Input
                id="lock-exception-ends"
                type="datetime-local"
                value={endsAt}
                min={nowInput}
                max={maxInput}
                aria-describedby="lock-exception-ends-help"
                onChange={(e) => setEndsAt(e.target.value)}
              />
              <p id="lock-exception-ends-help" className="text-xs text-muted-foreground">{te.endsAtHelp}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="lock-exception-reason">{te.reason}</Label>
              <Textarea
                id="lock-exception-reason"
                rows={3}
                value={reason}
                placeholder={te.reasonPlaceholder}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              {tl.cancel}
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={createException.isPending}>
              {createException.isPending ? te.creating : te.create}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        title={te.revokeTitle}
        description={te.revokeDescription}
        confirmLabel={te.revoke}
        cancelLabel={tl.cancel}
        variant="destructive"
        loading={revokeException.isPending}
        onConfirm={revoke}
      />
    </Card>
  );
}
