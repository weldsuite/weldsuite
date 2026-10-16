import { useEffect, useMemo } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import type { InvoiceDocumentData } from '@weldsuite/books-domain/invoice-template/data';
import { TEMPLATE_PRESETS, presetTemplate, type TemplatePreset } from '@weldsuite/books-domain/invoice-template/presets';
import type { PaperSize } from '@weldsuite/books-domain/invoice-template/schema';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { ColorField } from '@/app/weldhr/settings/components/color-field';
import { useCreateInvoiceTemplate } from '@/hooks/queries/use-invoice-template-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import { normalizeHex } from './designer/model/colors';
import { TemplateThumbnail } from './template-thumbnail';

function createSchema(messages: { nameRequired: string }) {
  return z.object({
    name: z.string().trim().min(1, messages.nameRequired).max(120),
    paperSize: z.enum(['a4', 'letter']),
    preset: z.enum(TEMPLATE_PRESETS),
    accent: z.string(),
  });
}

type FormValues = z.infer<ReturnType<typeof createSchema>>;

interface NewTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  /** Letter for US and Canadian companies, A4 elsewhere. */
  defaultPaperSize: PaperSize;
  /** The company's accent colour, when it has one. */
  defaultAccent: string | null;
  /** Sample invoice the preset thumbnails are laid out with. */
  previewData: InvoiceDocumentData;
}

/** Name, paper size and a preset as the starting point of a new template; creates it and opens the designer. */
export function NewTemplateDialog({ open, onOpenChange, entityId, defaultPaperSize, defaultAccent, previewData }: Readonly<NewTemplateDialogProps>) {
  const { t } = useI18n();
  const ti = t.accounting.invoiceTemplates;
  const tn = ti.newDialog;
  const router = useRouter();
  const createTemplate = useCreateInvoiceTemplate();
  const schema = useMemo(() => createSchema({ nameRequired: tn.nameRequired }), [tn.nameRequired]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', paperSize: defaultPaperSize, preset: 'classic', accent: defaultAccent ?? '' },
  });

  useEffect(() => {
    if (!open) return;
    form.reset({ name: '', paperSize: defaultPaperSize, preset: 'classic', accent: defaultAccent ?? '' });
    // Reset only when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const paperSize = form.watch('paperSize');
  const accentInput = form.watch('accent');
  const accent = normalizeHex(accentInput ?? '');
  const selectedPreset = form.watch('preset');

  const presets = useMemo(
    () => TEMPLATE_PRESETS.map((preset) => ({ preset, document: presetTemplate(preset, paperSize, accent) })),
    [paperSize, accent],
  );

  const submit = async (values: FormValues) => {
    try {
      const created = await createTemplate.mutateAsync({
        entityId,
        name: values.name.trim(),
        document: presetTemplate(values.preset, values.paperSize, normalizeHex(values.accent)),
      });
      onOpenChange(false);
      router.push(`/weldbooks/settings/invoice-templates/${created.id}`);
    } catch (err) {
      toast.error(tn.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const pending = createTemplate.isPending;
  const errors = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate>
          <DialogHeader>
            <DialogTitle>{tn.title}</DialogTitle>
            <DialogDescription>{tn.description}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 sm:grid-cols-[1fr_9rem_11rem]">
            <div className="space-y-2">
              <Label htmlFor="template-name">{tn.name} *</Label>
              <Input
                id="template-name"
                autoFocus
                placeholder={tn.namePlaceholder}
                aria-invalid={errors.name ? true : undefined}
                {...form.register('name')}
              />
              {errors.name ? <p className="text-sm text-destructive">{errors.name.message}</p> : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-paper">{tn.paperSize}</Label>
              <Controller
                control={form.control}
                name="paperSize"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="template-paper">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="a4">{ti.paper.a4}</SelectItem>
                      <SelectItem value="letter">{ti.paper.letter}</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>

            <Controller
              control={form.control}
              name="accent"
              render={({ field }) => (
                <ColorField id="template-accent" label={tn.accent} value={field.value} onChange={field.onChange} />
              )}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{tn.startingPoint}</legend>
            <div role="radiogroup" aria-label={tn.startingPoint} className="grid grid-cols-3 gap-3">
              {presets.map(({ preset, document }) => {
                const selected = selectedPreset === preset;
                const info = tn.presets[preset as TemplatePreset];
                return (
                  <button
                    key={preset}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => form.setValue('preset', preset, { shouldDirty: true })}
                    className={cn(
                      'flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors outline-none',
                      'hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      selected ? 'border-primary ring-2 ring-primary/30' : 'border-border',
                    )}
                  >
                    <TemplateThumbnail
                      document={document}
                      data={previewData}
                      alt={info.name}
                      className="rounded border border-border/60 shadow-sm"
                    />
                    <span className="px-0.5">
                      <span className="block text-sm font-medium">{info.name}</span>
                      <span className="block text-xs text-muted-foreground line-clamp-2">{info.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
              {tn.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              {pending ? tn.creating : tn.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
