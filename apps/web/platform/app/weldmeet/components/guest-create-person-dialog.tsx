import { useEffect, useState } from 'react';
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
import { Button } from '@weldsuite/ui/components/button';
import { useCreatePerson } from '@/hooks/queries/use-people-queries';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';
import { useResolvePersonByEmail } from './use-resolve-person-by-email';

export interface GuestCreatePersonTarget {
  name?: string;
  picture?: string;
  /** Known email (portal guests join as `guest:<email>`); prefilled in the form. */
  email?: string;
}

interface Props {
  target: GuestCreatePersonTarget | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the new person's id, or the existing person's id when the email already had one. */
  onCreated: (personId: string) => void;
}

function splitName(name?: string): { firstName: string; lastName: string } {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const [first = '', ...rest] = trimmed.split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') };
}

export function GuestCreatePersonDialog({ target, onOpenChange, onCreated }: Readonly<Props>) {
  const t = getTranslations('weldmeet');
  const isOpen = !!target;
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const createPerson = useCreatePerson();
  const resolvePersonByEmail = useResolvePersonByEmail();
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    if (target) {
      const { firstName: f, lastName: l } = splitName(target.name);
      setFirstName(f || 'Guest');
      setLastName(l);
      setEmail(target.email ?? '');
    }
  }, [target]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return;

    // The email may already belong to a person (a guest who was linked after
    // this dialog's data went stale, or a CRM contact added by someone else).
    // Open that person instead of creating a duplicate.
    const typedEmail = email.trim();
    if (typedEmail) {
      setResolving(true);
      try {
        const existingId = await resolvePersonByEmail(typedEmail);
        if (existingId) {
          toast.info(t.guestCreatePerson.existingPerson);
          onCreated(existingId);
          return;
        }
      } catch {
        // The lookup is a safety net; if it fails, creating the person (which
        // the server still validates) is better than blocking the host.
      } finally {
        setResolving(false);
      }
    }

    try {
      const res = await createPerson.mutateAsync({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim() || undefined,
      });
      const id = res?.data?.id;
      if (id) {
        onCreated(id);
      } else {
        toast.error(t.guestCreatePerson.errorNoId);
        onOpenChange(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t.guestCreatePerson.errorGeneric;
      toast.error(message);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t.guestCreatePerson.title}</DialogTitle>
          <DialogDescription>
            {t.guestCreatePerson.description}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="guest-first-name">{t.guestCreatePerson.firstNameLabel}</Label>
              <Input
                id="guest-first-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoFocus
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="guest-last-name">{t.guestCreatePerson.lastNameLabel}</Label>
              <Input
                id="guest-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="guest-email">{t.guestCreatePerson.emailLabel}</Label>
            <Input
              id="guest-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t.guestCreatePerson.emailPlaceholder}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={createPerson.isPending || resolving}
            >
              {t.guestCreatePerson.cancel}
            </Button>
            <Button type="submit" disabled={createPerson.isPending || resolving || !firstName.trim()}>
              {createPerson.isPending || resolving ? t.guestCreatePerson.saving : t.guestCreatePerson.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
