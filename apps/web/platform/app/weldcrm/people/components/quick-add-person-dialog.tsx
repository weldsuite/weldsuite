
import { useTranslations } from '@weldsuite/i18n/client';
import { type Person } from '@/hooks/queries/use-people-queries';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { QuickAddPersonForm } from './quick-add-person-form';

/**
 * Quick-add a Person — modal wrapper around {@link QuickAddPersonForm}.
 *
 * The form body is shared with the list add-member picker, so all field /
 * template logic lives in the form component; this file owns only the dialog
 * chrome.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefill the name fields (e.g. from a search term that found no match). */
  initialName?: string;
  /** Fired with the created record after a successful save. */
  onCreated?: (person: Person) => void;
}

export function QuickAddPersonDialog({ open, onOpenChange, initialName, onCreated }: Props) {
  const t = useTranslations();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[38rem]" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('crm.quickAddPerson.dialogTitle')}</DialogTitle>
        </DialogHeader>

        {open && (
          <QuickAddPersonForm
            initialName={initialName}
            onCreated={(person) => {
              onCreated?.(person);
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
