import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { errorDetails } from '@/lib/api/domains/weldbooks-banking';
import { useI18n } from '@/lib/i18n/provider';

/** The CRM person the server found behind the email of a new contact. */
export interface ExistingPerson {
  id: string;
  name: string;
  email?: string | null;
}

/**
 * The person from a 409 `PERSON_EMAIL_EXISTS` answer to creating a contact, or
 * null for any other error. The server never attaches a contact to a person
 * with another name on its own: the user links to them or creates a separate one.
 */
export function existingPersonOf(err: unknown): ExistingPerson | null {
  const details = errorDetails(err);
  if (details?.code !== 'PERSON_EMAIL_EXISTS') return null;
  const person = details.existingPerson as ExistingPerson | undefined;
  return person && typeof person.id === 'string' ? person : null;
}

interface PersonEmailConflictDialogProps {
  person: ExistingPerson | null;
  isPending: boolean;
  onLink: (person: ExistingPerson) => void;
  onCreateSeparate: () => void;
  onCancel: () => void;
}

/** "A person with this email exists: <name>. Link to them or create a separate contact." */
export function PersonEmailConflictDialog({
  person,
  isPending,
  onLink,
  onCreateSeparate,
  onCancel,
}: Readonly<PersonEmailConflictDialogProps>) {
  const { t } = useI18n();
  const tc = t.accounting.contacts;
  const name = person?.name || person?.email || '';

  return (
    <AlertDialog open={person !== null} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent data-testid="person-email-conflict">
        <AlertDialogHeader>
          <AlertDialogTitle>{tc.personEmailTitle}</AlertDialogTitle>
          <AlertDialogDescription>{tc.personEmailDesc.replace('{name}', name)}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{tc.cancel}</AlertDialogCancel>
          <Button variant="outline" disabled={isPending} onClick={onCreateSeparate} data-testid="person-email-separate">
            {tc.personEmailSeparate}
          </Button>
          <Button disabled={isPending} onClick={() => person && onLink(person)} data-testid="person-email-link">
            {tc.personEmailLink.replace('{name}', name)}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
