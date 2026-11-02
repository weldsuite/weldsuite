/**
 * Use a template: one block per role, in the order the roles are asked for,
 * with the role's usual person filled in. "Create draft" makes a new draft
 * request (documents, fields and settings copied) and opens it, ready to be
 * sent right away.
 *
 * The form is the contract's own `useTemplateSchema`; the server has the final
 * say, so what it refuses (a role left out, an address used twice, a missing
 * access code) comes back as a toast with its message.
 */

import { useMemo } from 'react';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useTemplateSchema, type SignEnvelopeDetail, type SignRecipientDto } from '@weldsuite/app-api-client/schemas/weldsign';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useSignTemplate, useUseSignTemplate } from '@/hooks/queries/use-weldsign-queries';
import { apiErrorMessage } from '../lib/errors';
import { recipientColor } from '../lib/recipient-colors';
import { rolesInOrder } from '../lib/roles';
import { buildUseTemplateInput, needsAccessCode, recipientDefaults } from '../lib/use-template';

type FormInput = z.input<typeof useTemplateSchema>;
type FormOutput = z.output<typeof useTemplateSchema>;
type TemplateForm = UseFormReturn<FormInput, unknown, FormOutput>;
type Strings = ReturnType<typeof useI18n>['t']['weldsign']['templates']['useTemplate'];

/** The contract's schema, plus: two roles cannot share an email address (the server refuses it too). */
function formSchema(duplicateEmail: string) {
  return useTemplateSchema.superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.recipients.forEach((person, index) => {
      const email = person.email.trim().toLowerCase();
      if (seen.has(email)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['recipients', index, 'email'], message: duplicateEmail });
      seen.add(email);
    });
  });
}

/** The message for a field of the contract's schema, in the UI language. */
function issueMessage(path: (string | number)[], tu: Strings): string | null {
  if (path[0] === 'title') return tu.titleRequired;
  if (path[0] !== 'recipients') return null;
  if (path[2] === 'name') return tu.nameRequired;
  if (path[2] === 'email') return tu.invalidEmail;
  if (path[2] === 'accessCode') return tu.accessCodeRequired;
  return null;
}

interface UseTemplateDialogProps {
  /** The template to use; null keeps the dialog closed. */
  templateId: string | null;
  onClose: () => void;
}

export function UseTemplateDialog({ templateId, onClose }: Readonly<UseTemplateDialogProps>) {
  // Mounted per template, so every opening starts from the template's own values.
  return templateId ? <TemplateLoader key={templateId} templateId={templateId} onClose={onClose} /> : null;
}

function TemplateLoader({ templateId, onClose }: Readonly<{ templateId: string; onClose: () => void }>) {
  const { t } = useI18n();
  const tu = t.weldsign.templates.useTemplate;
  const { data: template, isLoading } = useSignTemplate(templateId);

  if (template) return <UseTemplateForm template={template} onClose={onClose} />;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tu.title}</DialogTitle>
          <DialogDescription>{isLoading ? tu.loading : tu.loadFailed}</DialogDescription>
        </DialogHeader>
        {isLoading && <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />}
      </DialogContent>
    </Dialog>
  );
}

function UseTemplateForm({ template, onClose }: Readonly<{ template: SignEnvelopeDetail; onClose: () => void }>) {
  const { t, format } = useI18n();
  const router = useRouter();
  const tt = t.weldsign.templates;
  const tu = tt.useTemplate;
  const use = useUseSignTemplate(template.id);

  const roles = useMemo(() => rolesInOrder(template.recipientList), [template.recipientList]);
  // The server refuses a template without documents or roles.
  const usable = roles.length > 0 && template.documents.length > 0;

  const schemaOptions = useMemo(
    () => ({
      errorMap: (issue: z.ZodIssueOptionalMessage, ctx: z.ErrorMapCtx) => ({ message: issueMessage(issue.path, tu) ?? ctx.defaultError }),
      path: [] as Array<string | number>,
      async: false,
    }),
    [tu],
  );
  const schema = useMemo(() => formSchema(tu.duplicateEmail), [tu.duplicateEmail]);

  const form = useForm<FormInput, unknown, FormOutput>({
    resolver: zodResolver(schema, schemaOptions),
    defaultValues: { title: template.title, message: template.message ?? '', recipients: roles.map(recipientDefaults) },
  });

  const onSubmit = form.handleSubmit((values) =>
    use.mutate(buildUseTemplateInput(values, template), {
      onSuccess: (envelope) => {
        onClose();
        router.push(`/weldsign/${envelope.id}`);
      },
      onError: (err) => toast.error(`${tu.failed}: ${apiErrorMessage(err)}`),
    }),
  );

  return (
    // Stays open while the draft is being made: a refusal is shown in this dialog.
    <Dialog open onOpenChange={(open) => !open && !use.isPending && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] sm:max-w-xl">
        <Form {...form}>
          <form onSubmit={onSubmit} className="flex min-h-0 flex-col gap-4" noValidate>
            <DialogHeader>
              <DialogTitle>{tu.title}</DialogTitle>
              <DialogDescription>{format(tu.description, { name: template.title })}</DialogDescription>
            </DialogHeader>

            {usable ? (
              <div className="flex max-h-[55dvh] flex-col gap-4 overflow-y-auto pr-1">
                {roles.map((role, index) => (
                  <RoleBlock key={role.id} form={form} role={role} index={index} position={template.signingOrderEnabled ? index + 1 : null} />
                ))}
                <RequestDetails form={form} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{tt.cannotUse}</p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" disabled={use.isPending} onClick={onClose}>
                {t.common.actions.cancel}
              </Button>
              <Button type="submit" disabled={use.isPending || !usable}>
                {use.isPending ? tu.submitting : tu.submit}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

interface RoleBlockProps {
  form: TemplateForm;
  role: SignRecipientDto;
  index: number;
  /** Place in the signing order; null when the template has none. */
  position: number | null;
}

/** One role: who fills it, and the access code if the role is protected with one. */
function RoleBlock({ form, role, index, position }: Readonly<RoleBlockProps>) {
  const { t, format } = useI18n();
  const tu = t.weldsign.templates.useTemplate;
  const color = recipientColor(index);

  return (
    <section aria-label={role.roleName ?? ''} className="rounded-lg border p-4" style={{ borderLeft: `4px solid ${color.border}` }}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{role.roleName}</h3>
        <Badge variant="secondary">{role.role === 'signer' ? tu.signs : tu.copy}</Badge>
        {position !== null && <Badge variant="outline">{format(tu.step, { position })}</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          control={form.control}
          name={`recipients.${index}.name`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tu.name}</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} maxLength={255} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name={`recipients.${index}.email`}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{tu.email}</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} type="email" maxLength={320} autoComplete="off" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
      {needsAccessCode(role) && (
        <FormField
          control={form.control}
          name={`recipients.${index}.accessCode`}
          render={({ field }) => (
            <FormItem className="mt-3 sm:max-w-xs">
              <FormLabel>{tu.accessCode}</FormLabel>
              <FormControl>
                <Input {...field} value={field.value ?? ''} maxLength={64} autoComplete="off" />
              </FormControl>
              <p className="text-xs text-muted-foreground">{t.weldsign.editor.recipients.accessCodeHint}</p>
              <FormMessage />
            </FormItem>
          )}
        />
      )}
    </section>
  );
}

/** The title and message of the draft, as the template has them unless changed here. */
function RequestDetails({ form }: Readonly<{ form: TemplateForm }>) {
  const { t } = useI18n();
  const tu = t.weldsign.templates.useTemplate;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{tu.details}</h3>
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{tu.requestTitle}</FormLabel>
            <FormControl>
              <Input {...field} value={field.value ?? ''} maxLength={255} autoComplete="off" />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="message"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{tu.message}</FormLabel>
            <FormControl>
              <Textarea {...field} value={field.value ?? ''} rows={3} maxLength={5000} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </section>
  );
}
