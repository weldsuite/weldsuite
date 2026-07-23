
import { useTranslations } from '@weldsuite/i18n/client';
import { type Company } from '@/hooks/queries/use-companies-queries';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { QuickAddCompanyForm } from './quick-add-company-form';

/**
 * Quick-add a Company — modal wrapper around {@link QuickAddCompanyForm}.
 *
 * The form body is shared with the list add-member picker, so all field /
 * template logic lives in the form component; this file owns only the dialog
 * chrome.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill the name field (e.g. from a search term that found no match). */
  initialName?: string;
  /** Fired with the created record after a successful save. */
  onCreated?: (company: Company) => void;
}

export function QuickAddCompanyDialog({ open, onOpenChange, initialName, onCreated }: Props) {
  const t = useTranslations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[38rem]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('crm.quickAddCompany.dialogTitle')}</DialogTitle>
        </DialogHeader>

        {open && (
          <QuickAddCompanyForm
            initialName={initialName}
            onCreated={(company) => {
              onCreated?.(company);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
