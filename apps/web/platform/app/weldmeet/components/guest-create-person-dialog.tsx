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

export interface GuestCreatePersonTarget {
  name?: string;
  picture?: string;
}

interface Props {
  target: GuestCreatePersonTarget | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (personId: string) => void;
}

function splitName(name?: string): { firstName: string; lastName: string } {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const [first = '', ...rest] = trimmed.split(/\s+/);
  return { firstName: first, lastName: rest.join(' ') };
}

export function GuestCreatePersonDialog({ target, onOpenChange, onCreated }: Props) {
  const t = getTranslations('weldmeet');
  const isOpen = !!target;
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const createPerson = useCreatePerson();

  useEffect(() => {
    if (target) {
      const { firstName: f, lastName: l } = splitName(target.name);
      setFirstName(f || 'Guest');
      setLastName(l);
      setEmail('');
    }
  }, [target]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim()) return;
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
              disabled={createPerson.isPending}
            >
              {t.guestCreatePerson.cancel}
            </Button>
            <Button type="submit" disabled={createPerson.isPending || !firstName.trim()}>
              {createPerson.isPending ? t.guestCreatePerson.saving : t.guestCreatePerson.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
