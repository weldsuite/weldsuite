/**
 * "New workspace": create a customer workspace, choose what it may use and
 * record the price. The customer's owner is invited by email; the partner user
 * is not added to the workspace.
 *
 * Name, country and owner email use react-hook-form + zod. The licence part is
 * a draft of plain strings validated with the same schema the server uses
 * (`parseDraft`), because its fields depend on each other (pricing model,
 * package defaults).
 */

import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { createManagedWorkspaceSchema } from '@weldsuite/app-api-client/schemas/partners';
import {
  useCreateManagedWorkspace,
  usePartnerCatalog,
  usePartnerOverview,
  usePartnerPackages,
} from '@/hooks/queries/use-partner-queries';
import { COUNTRIES } from '@/lib/constants/countries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import {
  emptyDraft,
  parseDraft,
  type LicenceDraft,
  type LicenceDraftErrors,
} from '../lib/licence-draft';
import { errorText, FieldMessage } from './kit';
import { LicenceEditor } from './licence-editor';
import { LicencePreview } from './licence-preview';

/** What a territory request pre-fills. */
export interface NewWorkspacePrefill {
  requestId: string;
  companyName: string;
  countryCode: string;
  ownerEmail: string;
  selectedApps: string[];
}

const formSchema = z.object({
  name: z.string().trim().min(1).max(255),
  country: z.string().length(2),
  ownerEmail: z.string().trim().email().max(255),
});
type FormValues = z.infer<typeof formSchema>;

interface NewWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: NewWorkspacePrefill;
}

export function NewWorkspaceDialog({ open, onOpenChange, prefill }: Readonly<NewWorkspaceDialogProps>) {
  const { t, format } = useI18n();
  const tn = t.partner.newWorkspace;
  const router = useRouter();
  const create = useCreateManagedWorkspace();
  const overview = usePartnerOverview();
  const catalogQuery = usePartnerCatalog();
  const packagesQuery = usePartnerPackages();

  const catalog = catalogQuery.data;
  const packages = packagesQuery.data;

  const [draft, setDraft] = useState<LicenceDraft>(emptyDraft);
  const [draftErrors, setDraftErrors] = useState<LicenceDraftErrors>({});
  const [seats, setSeats] = useState(1);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: '', country: '', ownerEmail: '' },
  });

  // Start fresh every time the dialog opens; a request pre-fills it.
  const prefillApps = prefill?.selectedApps;
  const catalogCodes = useMemo(() => catalog?.apps.map((a) => a.code) ?? [], [catalog]);
  useEffect(() => {
    if (!open) return;
    form.reset({
      name: prefill?.companyName ?? '',
      country: prefill?.countryCode ?? '',
      ownerEmail: prefill?.ownerEmail ?? '',
    });
    setDraft({ ...emptyDraft(), allowedApps: [] });
    setDraftErrors({});
    setSubmitError(null);
    setSeats(1);
    // `prefill` identity changes only when a different request is picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill?.requestId]);

  // Apps a request asked for, once the catalog tells us which of them exist.
  useEffect(() => {
    if (!open || !prefillApps || catalogCodes.length === 0) return;
    setDraft((d) =>
      d.allowedApps.length > 0 ? d : { ...d, allowedApps: prefillApps.filter((code) => catalogCodes.includes(code)) },
    );
  }, [open, prefillApps, catalogCodes]);

  const onSubmit = form.handleSubmit(async (values) => {
    setSubmitError(null);
    const licence = parseDraft(draft);
    if (!licence.ok) {
      setDraftErrors(licence.errors);
      return;
    }
    setDraftErrors({});

    const body = createManagedWorkspaceSchema.safeParse({
      name: values.name,
      country: values.country,
      ownerEmail: values.ownerEmail,
      licence: licence.value,
      ...(prefill?.requestId ? { requestId: prefill.requestId } : {}),
    });
    if (!body.success) {
      setSubmitError(t.partner.licence.invalid);
      return;
    }

    try {
      const res = await create.mutateAsync(body.data);
      toast.success(tn.created);
      onOpenChange(false);
      router.push(`/partner/workspaces/${res.data.workspaceId}`);
    } catch (err) {
      setSubmitError(errorText(err, tn.failed));
    }
  });

  const pending = create.isPending;
  // The overview says there is no contract in force: the server would refuse the licence.
  const noContract = overview.isSuccess && !overview.data.contract;
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{tn.title}</DialogTitle>
          <DialogDescription>
            {prefill ? format(tn.fromRequest, { company: prefill.companyName }) : tn.description}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5 sm:col-span-2">
              <Label htmlFor="nw-name">{tn.name}</Label>
              <Input
                id="nw-name"
                placeholder={tn.namePlaceholder}
                aria-invalid={Boolean(errors.name)}
                disabled={pending}
                {...form.register('name')}
              />
              {errors.name && <FieldMessage>{tn.nameRequired}</FieldMessage>}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="nw-country">{tn.country}</Label>
              <Controller
                control={form.control}
                name="country"
                render={({ field }) => (
                  <Select value={field.value || undefined} onValueChange={field.onChange} disabled={pending}>
                    <SelectTrigger id="nw-country" aria-invalid={Boolean(errors.country)}>
                      <SelectValue placeholder={tn.countryPlaceholder} />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {COUNTRIES.map((c) => (
                        <SelectItem key={c.code} value={c.code}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              {errors.country && <FieldMessage>{tn.countryRequired}</FieldMessage>}
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="nw-owner">{tn.ownerEmail}</Label>
              <Input
                id="nw-owner"
                type="email"
                placeholder={tn.ownerEmailPlaceholder}
                aria-invalid={Boolean(errors.ownerEmail)}
                disabled={pending}
                {...form.register('ownerEmail')}
              />
              {errors.ownerEmail && <FieldMessage>{tn.ownerEmailInvalid}</FieldMessage>}
              <p className="text-xs text-muted-foreground">{tn.ownerEmailHint}</p>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{tn.licenceHeading}</h3>
            <LicenceEditor
              draft={draft}
              onChange={setDraft}
              errors={draftErrors}
              catalog={catalog}
              packages={packages}
              disabled={pending}
              idPrefix="nw"
            />
          </div>

          <LicencePreview
            contract={overview.data?.contract}
            draft={draft}
            seats={seats}
            onSeatsChange={setSeats}
          />

          {noContract && (
            <p role="alert" className="text-sm text-destructive">
              {tn.noContract}
            </p>
          )}
          {submitError && (
            <p role="alert" className="text-sm text-destructive">
              {submitError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {t.partner.common.cancel}
            </Button>
            <Button type="submit" disabled={pending || noContract}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />}
              {pending ? tn.submitting : tn.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
