import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
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
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { Loader2 } from 'lucide-react';
import { useUpdateMailAccount } from '@/hooks/queries/use-mail-queries';
import { toast } from 'sonner';
import { getTranslations } from '@/lib/i18n';

const editAccountSchema = z.object({
  displayName: z.string().max(255).optional(),
});

type EditAccountFormValues = z.infer<typeof editAccountSchema>;

interface EditAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountEmail: string;
  defaultValues: {
    displayName?: string;
  };
}

export function EditAccountDialog({
  open,
  onOpenChange,
  accountId,
  accountEmail,
  defaultValues,
}: EditAccountDialogProps) {
  const ts = getTranslations('settings');
  const tea = ts.weldmail.editAccount;
  const updateAccount = useUpdateMailAccount();

  const form = useForm<EditAccountFormValues>({
    resolver: zodResolver(editAccountSchema),
    defaultValues: {
      displayName: defaultValues.displayName ?? '',
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        displayName: defaultValues.displayName ?? '',
      });
    }
  }, [open, defaultValues, form]);

  const onSubmit = async (values: EditAccountFormValues) => {
    try {
      await updateAccount.mutateAsync({
        id: accountId,
        displayName: values.displayName?.trim() || undefined,
      });
      toast.success(tea.messages.updated);
      onOpenChange(false);
    } catch {
      toast.error(tea.messages.updateFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{tea.title}</DialogTitle>
          <DialogDescription>{accountEmail}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{tea.displayName}</FormLabel>
                  <FormControl>
                    <Input placeholder={tea.displayNamePlaceholder} {...field} />
                  </FormControl>
                  <FormDescription>
                    {tea.displayNameDescription}
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {tea.cancel}
              </Button>
              <Button type="submit" disabled={updateAccount.isPending}>
                {updateAccount.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
                {tea.save}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
