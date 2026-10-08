import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
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
import { Input } from '@weldsuite/ui/components/input';
import { useUpdateSalesTaxAgency } from '@/hooks/queries/use-weldbooks-sales-tax-setup-queries';
import type { AgencyStatus, SalesTaxAgency } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { Field } from '../setup/field';
import { useSetupTexts } from '../setup/setup-texts';
import { statusTargets } from './agency-model';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Move an agency between registered, pending, monitoring and closed. Marking
 * it registered asks for the date the registration starts (tax is charged only
 * from then); closing it asks for confirmation.
 */
export function AgencyStatusMenu({ agency }: Readonly<{ agency: SalesTaxAgency }>) {
  const { t, format } = useSetupTexts();
  const update = useUpdateSalesTaxAgency();
  const [registerOpen, setRegisterOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [from, setFrom] = useState(agency.registeredFrom ?? '');
  const [showError, setShowError] = useState(false);

  const changed = (status: AgencyStatus) => toast.success(format(t.agency.statusChanged, { status: t.statuses[status] }));

  const move = async (status: AgencyStatus, extra: { registeredFrom?: string } = {}) => {
    await update.mutateAsync({ id: agency.id, input: { status, ...extra } });
    changed(status);
  };

  const choose = (status: AgencyStatus) => {
    update.reset();
    if (status === 'registered') {
      setFrom(agency.registeredFrom ?? '');
      setShowError(false);
      setRegisterOpen(true);
    } else if (status === 'closed') {
      setCloseOpen(true);
    } else {
      void move(status).catch((err: unknown) => toast.error(err instanceof Error && err.message ? err.message : t.common.saveError));
    }
  };

  const confirmRegister = async () => {
    if (!ISO_DATE.test(from)) {
      setShowError(true);
      return;
    }
    try {
      await move('registered', { registeredFrom: from });
      setRegisterOpen(false);
    } catch {
      // The error shows in the dialog (update.error).
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" disabled={update.isPending}>
            {t.agency.changeStatus}
            <ChevronDown className="ml-2 h-4 w-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {statusTargets(agency.status).map((status) => (
            <DropdownMenuItem key={status} onSelect={() => choose(status)}>
              {t.agency.statusActions[status]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={registerOpen} onOpenChange={setRegisterOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t.agency.registerDialog.title}</DialogTitle>
            <DialogDescription>{t.agency.registerDialog.description}</DialogDescription>
          </DialogHeader>
          <Field
            label={t.wizard.registrationStep.registeredFrom}
            htmlFor="status-registered-from"
            help={t.wizard.registrationStep.registeredFromHelp}
            error={showError ? t.validation.registeredFromRequired : undefined}
          >
            <Input
              id="status-registered-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-invalid={showError || undefined}
            />
          </Field>
          {update.isError ? (
            <Alert variant="destructive">
              <AlertDescription>
                {update.error instanceof Error && update.error.message ? update.error.message : t.common.saveError}
              </AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRegisterOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button type="button" onClick={() => void confirmRegister()} disabled={update.isPending}>
              {t.agency.registerDialog.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={closeOpen}
        onOpenChange={setCloseOpen}
        title={t.agency.closeDialog.title}
        description={t.agency.closeDialog.description}
        confirmLabel={t.agency.closeDialog.confirm}
        cancelLabel={t.common.cancel}
        variant="destructive"
        onConfirm={async () => {
          try {
            await move('closed');
            setCloseOpen(false);
          } catch (err) {
            toast.error(err instanceof Error && err.message ? err.message : t.common.saveError);
          }
        }}
      />
    </>
  );
}
