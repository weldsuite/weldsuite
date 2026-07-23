
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@weldsuite/ui/components/form';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateUserApp, type UserApp } from '@/hooks/queries/use-user-apps-queries';

// Matches the backend contract exactly: /^[a-z][a-z0-9-]*$/, 3-50 chars.
const CODE_PATTERN = /^[a-z][a-z0-9-]*$/;

interface CreateAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (app: UserApp) => void;
}

export function CreateAppDialog({ open, onOpenChange, onCreated }: CreateAppDialogProps) {
  const { t } = useI18n();
  const wa = t.weldapps;

  const schema = z.object({
    code: z
      .string()
      .min(3, wa.createDialog.codeInvalid)
      .max(50, wa.createDialog.codeInvalid)
      .regex(CODE_PATTERN, wa.createDialog.codeInvalid),
    name: z.string().min(1, wa.createDialog.nameLabel),
    description: z.string().optional(),
    icon: z.string().optional(),
    category: z.string().optional(),
  });
  type FormValues = z.infer<typeof schema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { code: '', name: '', description: '', icon: '', category: '' },
  });

  const createMutation = useCreateUserApp();

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) form.reset();
    onOpenChange(nextOpen);
  };

  const onSubmit = async (values: FormValues) => {
    try {
      const app = await createMutation.mutateAsync({
        code: values.code,
        name: values.name,
        description: values.description || undefined,
        icon: values.icon || undefined,
        category: values.category || undefined,
      });
      toast.success(wa.createDialog.createSuccess);
      handleClose(false);
      onCreated?.(app);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : wa.createDialog.createError);
    }
  };

  return (
    <Dialog open={open} onOpenChange={form.formState.isSubmitting ? undefined : handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{wa.createDialog.title}</DialogTitle>
          <DialogDescription>{wa.createDialog.description}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="code"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{wa.createDialog.codeLabel}</FormLabel>
                  <FormControl>
                    <Input placeholder={wa.createDialog.codePlaceholder} {...field} />
                  </FormControl>
                  <p className="text-xs text-muted-foreground">{wa.createDialog.codeHint}</p>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{wa.createDialog.nameLabel}</FormLabel>
                  <FormControl>
                    <Input placeholder={wa.createDialog.namePlaceholder} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{wa.createDialog.descriptionLabel}</FormLabel>
                  <FormControl>
                    <Textarea placeholder={wa.createDialog.descriptionPlaceholder} rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="icon"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{wa.createDialog.iconLabel}</FormLabel>
                    <FormControl>
                      <Input placeholder={wa.createDialog.iconPlaceholder} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{wa.createDialog.categoryLabel}</FormLabel>
                    <FormControl>
                      <Input placeholder={wa.createDialog.categoryPlaceholder} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => handleClose(false)} disabled={form.formState.isSubmitting}>
                {wa.consent.cancel}
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {wa.createDialog.create}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
