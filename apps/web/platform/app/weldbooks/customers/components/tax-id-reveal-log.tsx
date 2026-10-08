import { useMemo } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useTaxIdReveals } from '@/hooks/queries/use-weldbooks-1099-queries';
import { useWorkspaceMembers } from '@/hooks/queries/use-settings-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

interface TaxIdRevealLogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
}

/** Who looked at a vendor's full TIN or bank account number, newest first (people with `tax_ids:reveal`). */
export function TaxIdRevealLog({ open, onOpenChange, partyId }: Readonly<TaxIdRevealLogProps>) {
  const { t } = useI18n();
  const tl = t.weldbooksUs.form1099.revealLog;
  const { formatDateTime } = useWeldbooksFormat();
  const reveals = useTaxIdReveals(partyId, { enabled: open });
  const members = useWorkspaceMembers(1, 100, open);

  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members.data?.data ?? []) map.set(member.userId, member.name || member.email || member.userId);
    return map;
  }, [members.data]);

  const rows = reveals.data ?? [];
  const fieldLabel = (field: string): string =>
    field === 'tin' ? tl.fields.tin : field === 'ach_account_number' ? tl.fields.ach : field;
  const reasonLabel = (reason: string | null): string => {
    if (!reason) return '';
    return (tl.reasons as Record<string, string>)[reason] ?? reason;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tl.title}</DialogTitle>
          <DialogDescription>{tl.description}</DialogDescription>
        </DialogHeader>
        {reveals.isLoading ? (
          <p className="text-sm text-muted-foreground">{tl.loading}</p>
        ) : reveals.isError ? (
          <p className="text-sm text-destructive" role="alert">
            {tl.loadFailed}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{tl.empty}</p>
        ) : (
          <div className="max-h-[50vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tl.when}</TableHead>
                  <TableHead>{tl.who}</TableHead>
                  <TableHead>{tl.what}</TableHead>
                  <TableHead>{tl.why}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap">{formatDateTime(row.createdAt)}</TableCell>
                    <TableCell>{names.get(row.revealedBy) ?? row.revealedBy}</TableCell>
                    <TableCell>{fieldLabel(row.field)}</TableCell>
                    <TableCell className="text-muted-foreground">{reasonLabel(row.reason)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tl.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
