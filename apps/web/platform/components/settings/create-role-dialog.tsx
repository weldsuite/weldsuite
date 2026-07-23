
import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAppApiClient } from '@/lib/api/use-app-api';
import type { Role } from '@/lib/api/types/rbac.types';

interface CreateRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: Role[];
  onRoleCreated: () => void;
}

export function CreateRoleDialog({
  open,
  onOpenChange,
  roles,
  onRoleCreated,
}: CreateRoleDialogProps) {
  const t = useTranslations();
  const [loading, setLoading] = React.useState(false);
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [copyFromRoleId, setCopyFromRoleId] = React.useState<string | undefined>(undefined);
  const { getClient } = useAppApiClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim()) {
      toast.error(t('sweep.settings.createRole.nameRequired'));
      return;
    }

    setLoading(true);
    try {
      const client = await getClient();
      // app-api returns { data } and throws on non-2xx, so reaching here is success.
      await client.post<{ data?: Role }>('/roles', {
        name: name.trim(),
        description: description.trim() || undefined,
        copyFromRoleId: copyFromRoleId || undefined,
      });

      toast.success(t('sweep.settings.createRole.createdSuccessfully'));
      setName('');
      setDescription('');
      setCopyFromRoleId(undefined);
      onRoleCreated();
    } catch (error) {
      console.error('Failed to create role:', error);
      toast.error(error instanceof Error ? error.message : t('sweep.settings.createRole.createFailed'));
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (isOpen: boolean) => {
    if (!loading) {
      if (!isOpen) {
        setName('');
        setDescription('');
        setCopyFromRoleId(undefined);
      }
      onOpenChange(isOpen);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{t('sweep.settings.createRole.title')}</DialogTitle>
            <DialogDescription>
              {t('sweep.settings.createRole.description')}
              {roles.length >= 8 && (
                <span className="block mt-1 text-yellow-600 dark:text-yellow-400">
                  {t('sweep.settings.createRole.roleLimitWarning', { count: roles.length })}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">{t('sweep.settings.createRole.roleNameLabel')}</Label>
              <Input
                id="name"
                placeholder={t('sweep.settings.createRole.roleNamePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="description">{t('sweep.settings.createRole.descriptionLabel')}</Label>
              <Textarea
                id="description"
                placeholder={t('sweep.settings.createRole.descriptionPlaceholder')}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={loading}
                rows={3}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="copyFrom">{t('sweep.settings.createRole.copyFromLabel')}</Label>
              <Select
                value={copyFromRoleId ?? '__none__'}
                onValueChange={(value) => setCopyFromRoleId(value === '__none__' ? undefined : value)}
                disabled={loading}
              >
                <SelectTrigger id="copyFrom">
                  <SelectValue placeholder={t('sweep.settings.createRole.blankPermissions')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('sweep.settings.createRole.blankPermissions')}</SelectItem>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name} {role.isSystemRole ? `(${t('sweep.settings.createRole.systemTag')})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={loading}
            >
              {t('sweep.settings.createRole.cancel')}
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('sweep.settings.createRole.createButton')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
