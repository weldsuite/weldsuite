/**
 * The e-mail dialog of an invoice, a credit note and a quote (edition feature
 * `books-invoice-email`): who gets it (To, Cc), optionally its own subject and
 * text, whether the PDF and the online link go with it, and, once it is sent,
 * to whom it went and the link with a "Copy link" button.
 *
 * Subject and text are left empty by default: the server then writes them from
 * the entity's template (Settings → Entities → WeldBooks) and fills in the
 * name, amount and due date, so the dialog never repeats that logic. Writing
 * its own text changes this e-mail only.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { CopyButton } from '@weldsuite/ui/components/copy-button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { EmailDelivery, SendEmailInput } from '@/lib/api/domains/weldbooks-sales';
import { useI18n } from '@/lib/i18n/provider';
import { addressProblem, parseAddresses, type AddressProblem } from '@/lib/weldbooks/email-addresses';

export type SendEmailKind = 'invoice' | 'credit_note' | 'quote';

export interface SendEmailDialogProps {
  kind: SendEmailKind;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The contact's e-mail address, put in "To" when the dialog opens. */
  defaultTo?: string | null;
  /** The name the mail goes out under (the entity's); left out, the words say "your company". */
  entityName?: string | null;
  /** E-mails the document. Throws when the server refuses. */
  send: (input: SendEmailInput) => Promise<EmailDelivery>;
  /** Called with a refusal first; returns true when the caller showed it (a sales tax notice). */
  onFailure?: (error: unknown) => boolean;
  /** A notice above the form (a draft that will be finalized, details that are missing). */
  notice?: ReactNode;
  /** Holds "Send" back, e.g. while the company details are missing. */
  sendDisabled?: boolean;
  /** The success line also names a document number, when there is one. */
  documentNumber?: string | null;
}

interface FormValues {
  to: string;
  cc: string;
  subject: string;
  body: string;
  attachPdf: boolean;
  includeLink: boolean;
}

const MAX_SUBJECT = 300;
const MAX_BODY = 10_000;

function statusOf(error: unknown): number | null {
  const status = error && typeof error === 'object' ? (error as { status?: unknown }).status : null;
  return typeof status === 'number' ? status : null;
}

/** The refusal in plain words: a server without mail is not the same problem as a cancelled invoice. */
function failureDescription(error: unknown, copy: { notConfigured: string }): string | undefined {
  if (statusOf(error) === 503) return copy.notConfigured;
  return error instanceof Error && error.message ? error.message : undefined;
}

function dialogTitle(
  kind: SendEmailKind,
  copy: { titleQuote: string; titleCreditNote: string; titleInvoice: string },
): string {
  if (kind === 'quote') return copy.titleQuote;
  return kind === 'credit_note' ? copy.titleCreditNote : copy.titleInvoice;
}

function SendEmailForm({
  kind,
  defaultTo,
  entityName,
  send,
  onFailure,
  notice,
  sendDisabled,
  onClose,
  onSent,
}: Readonly<Omit<SendEmailDialogProps, 'open' | 'onOpenChange' | 'documentNumber'> & { onClose: () => void; onSent: (delivery: EmailDelivery) => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.send;
  const [customize, setCustomize] = useState(false);
  const [pending, setPending] = useState(false);

  const describeProblem = (problem: AddressProblem | null): string | true => {
    if (!problem) return true;
    if (problem.kind === 'required') return copy.toRequired;
    if (problem.kind === 'tooMany') return copy.tooMany.replace('{max}', String(problem.max));
    return copy.invalidAddress.replace('{address}', problem.address);
  };
  const schema = z.object({
    to: z.string().superRefine((value, ctx) => {
      const message = describeProblem(addressProblem(value, { required: true }));
      if (message !== true) ctx.addIssue({ code: 'custom', message });
    }),
    cc: z.string().superRefine((value, ctx) => {
      const message = describeProblem(addressProblem(value, { required: false }));
      if (message !== true) ctx.addIssue({ code: 'custom', message });
    }),
    subject: z.string().max(MAX_SUBJECT),
    body: z.string().max(MAX_BODY),
    attachPdf: z.boolean(),
    includeLink: z.boolean(),
  });

  const {
    register,
    control,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { to: defaultTo ?? '', cc: '', subject: '', body: '', attachPdf: true, includeLink: true },
  });

  const submit = handleSubmit(
    async (values) => {
      const cc = parseAddresses(values.cc);
      const input: SendEmailInput = {
        to: parseAddresses(values.to),
        ...(cc.length > 0 ? { cc } : {}),
        // Left empty, the entity's template applies.
        ...(values.subject.trim() ? { subject: values.subject.trim() } : {}),
        ...(values.body.trim() ? { body: values.body } : {}),
        attachPdf: values.attachPdf,
        includeLink: values.includeLink,
      };
      setPending(true);
      try {
        onSent(await send(input));
      } catch (error) {
        if (onFailure?.(error)) {
          onClose();
          return;
        }
        toast.error(copy.failed, { description: failureDescription(error, copy) });
      } finally {
        setPending(false);
      }
    },
    // A refused form moves the focus to the first field that needs fixing.
    (invalid) => setFocus(invalid.to ? 'to' : 'cc'),
  );

  const title = dialogTitle(kind, copy);
  const who = entityName?.trim() ? entityName.trim() : copy.yourCompany;

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{copy.fromEntity.replace(/\{name\}/g, who)}</DialogDescription>
      </DialogHeader>
      {notice}

      <div className="space-y-1.5">
        <Label htmlFor="send-to">{copy.to}</Label>
        <Input
          id="send-to"
          type="email"
          multiple
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          aria-invalid={errors.to ? true : undefined}
          aria-describedby={errors.to ? 'send-to-error' : 'send-to-hint'}
          {...register('to')}
        />
        {errors.to ? (
          <p id="send-to-error" className="text-xs text-destructive">
            {errors.to.message}
          </p>
        ) : (
          <p id="send-to-hint" className="text-xs text-muted-foreground">
            {copy.addressesHint}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="send-cc">{copy.cc}</Label>
        <Input
          id="send-cc"
          type="email"
          multiple
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="next"
          aria-invalid={errors.cc ? true : undefined}
          aria-describedby={errors.cc ? 'send-cc-error' : undefined}
          {...register('cc')}
        />
        {errors.cc ? (
          <p id="send-cc-error" className="text-xs text-destructive">
            {errors.cc.message}
          </p>
        ) : null}
      </div>

      {customize ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="send-subject">{copy.subject}</Label>
            <Input id="send-subject" maxLength={MAX_SUBJECT} placeholder={copy.templatePlaceholder} {...register('subject')} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="send-body">{copy.body}</Label>
            <Textarea id="send-body" rows={7} maxLength={MAX_BODY} placeholder={copy.templatePlaceholder} {...register('body')} />
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <p className="min-w-0 flex-1 basis-56 text-[13px] text-muted-foreground">{copy.templateHint}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => setCustomize(true)}>
            {copy.customize}
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="send-pdf">{copy.attachPdf}</Label>
          <Controller
            control={control}
            name="attachPdf"
            render={({ field }) => (
              <Switch id="send-pdf" checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor="send-link">{copy.includeLink}</Label>
            <p id="send-link-hint" className="text-xs text-muted-foreground">
              {kind === 'quote' ? copy.includeLinkHintQuote : copy.includeLinkHint}
            </p>
          </div>
          <Controller
            control={control}
            name="includeLink"
            render={({ field }) => (
              <Switch id="send-link" aria-describedby="send-link-hint" checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {copy.cancel}
        </Button>
        <Button type="submit" disabled={pending || sendDisabled}>
          {pending ? copy.sending : copy.send}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What the dialog says once the e-mail is on its way. */
function Sent({ delivery, documentNumber, onClose }: Readonly<{ delivery: EmailDelivery; documentNumber?: string | null; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.weldbooksSales.send;
  const to = delivery.to.join(', ');
  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-emerald-600" aria-hidden />
          {copy.sentTitle}
        </DialogTitle>
        <DialogDescription>
          {(documentNumber ? copy.sentToNumbered.replace('{number}', documentNumber) : copy.sentTo).replace('{to}', to)}
          {delivery.cc && delivery.cc.length > 0 ? ` ${copy.sentCc.replace('{cc}', delivery.cc.join(', '))}` : ''}
        </DialogDescription>
      </DialogHeader>
      {delivery.link ? (
        <div className="space-y-1.5">
          <Label htmlFor="sent-link">{copy.linkLabel}</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input id="sent-link" readOnly value={delivery.link} className="min-w-0 flex-1 basis-56" onFocus={(event) => event.currentTarget.select()} />
            <CopyButton value={delivery.link} label={copy.copyLink} showLabel copiedLabel={copy.linkCopied} failedLabel={copy.copyFailed} />
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.noLink}</p>
      )}
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          {copy.close}
        </Button>
      </DialogFooter>
    </div>
  );
}

export function SendEmailDialog(props: Readonly<SendEmailDialogProps>) {
  const { open, onOpenChange, documentNumber, ...form } = props;
  const [delivery, setDelivery] = useState<EmailDelivery | null>(null);

  // A dialog opened again starts with an empty form, not with the last answer.
  useEffect(() => {
    if (open) setDelivery(null);
  }, [open]);

  const close = () => onOpenChange(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {delivery ? (
          <Sent delivery={delivery} documentNumber={documentNumber} onClose={close} />
        ) : (
          <SendEmailForm {...form} onClose={close} onSent={setDelivery} />
        )}
      </DialogContent>
    </Dialog>
  );
}
