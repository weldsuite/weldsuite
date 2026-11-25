import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { useI18n } from '@/lib/i18n/provider';
import type { IntegrationAuthField } from '@/hooks/queries/use-workflow-integration-queries';

interface ApiKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerName: string;
  fields: readonly IntegrationAuthField[];
  pending: boolean;
  onSubmit: (credentials: Record<string, string>) => void;
}

/**
 * The credentials an API-key provider asks for (its catalog `auth.fields`).
 * Errors show once a field has been left, and a submit moves focus to the
 * first one that is missing.
 */
export function ApiKeyDialog({ open, onOpenChange, providerName, fields, pending, onSubmit }: Readonly<ApiKeyDialogProps>) {
  const { t, format } = useI18n();
  const copy = t.settings.integrations.workflowConnections.apiKeyDialog;

  const schema = useMemo(
    () =>
      z.object(
        Object.fromEntries(
          fields.map((field) => [
            field.key,
            z.string().trim().min(1, format(copy.required, { field: field.label })),
          ]),
        ),
      ),
    [fields, copy.required, format],
  );
  const empty = useMemo(() => Object.fromEntries(fields.map((field) => [field.key, ''])), [fields]);

  const form = useForm<Record<string, string>>({
    resolver: zodResolver(schema),
    defaultValues: empty,
    mode: 'onTouched',
  });

  useEffect(() => {
    if (!open) form.reset(empty);
  }, [open, empty, form]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{format(copy.title, { provider: providerName })}</DialogTitle>
          <DialogDescription>{format(copy.description, { provider: providerName })}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            noValidate
            className="space-y-4"
            onSubmit={form.handleSubmit((values) => onSubmit(values))}
          >
            {fields.map((field) => (
              <FormField
                key={field.key}
                control={form.control}
                name={field.key}
                render={({ field: control }) => (
                  <FormItem>
                    <FormLabel>{field.label}</FormLabel>
                    <FormControl>
                      <Input
                        {...control}
                        type={field.secret ? 'password' : 'text'}
                        placeholder={field.placeholder}
                        required
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ))}
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                {copy.cancel}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {copy.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
