import { useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
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
import { BR_STATES } from '@/components/address/br-states';
import { useExportEcd } from '@/hooks/queries/use-weldbooks-br-queries';
import type { EcdSignatory } from '@/lib/api/domains/weldbooks-br';
import { useI18n } from '@/lib/i18n/provider';
import { downloadBlob } from '@/lib/weldbooks/download';
import { isValidCpf, normalizeCpf } from '@/lib/weldbooks/identifiers';

/** Qualification codes of the legal representative (J930): code and the text printed with it. */
const REPRESENTATIVE_CODES = ['205', '203', '801'] as const;
const NO_UF = '__none__';

const REPRESENTATIVE_QUALIFICATIONS: Record<(typeof REPRESENTATIVE_CODES)[number], string> = {
  '205': 'Administrador',
  '203': 'Diretor',
  '801': 'Empresário',
};

interface Messages {
  year: string;
  required: string;
  cpf: string;
  email: string;
  phone: string;
}

function createSchema(m: Messages) {
  const cpf = z.string().trim().min(1, m.required).refine((value) => isValidCpf(value), m.cpf);
  return z.object({
    year: z.coerce.number().int().min(2000, m.year).max(2100, m.year),
    contadorName: z.string().trim().min(1, m.required).max(255),
    contadorCpf: cpf,
    contadorCrc: z.string().trim().min(1, m.required).max(20),
    contadorCrcUf: z.string().length(2, m.required),
    contadorEmail: z.string().trim().email(m.email).max(60).or(z.literal('')),
    contadorPhone: z.string().trim().max(14, m.phone),
    repName: z.string().trim().min(1, m.required).max(255),
    repCpf: cpf,
    repCode: z.enum(REPRESENTATIVE_CODES),
  });
}

type FormValues = z.infer<ReturnType<typeof createSchema>>;

interface EcdExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The year the dialog opens on. */
  defaultYear?: number;
}

/**
 * SPED ECD export: the year and the people who sign it (the contador, with CRC,
 * and the legal representative). The server builds the file as ISO-8859-1 text
 * and attaches its notes (what is left for the contador to check), shown here
 * after the download.
 */
export function EcdExportDialog({ open, onOpenChange, defaultYear }: Readonly<EcdExportDialogProps>) {
  const { t } = useI18n();
  const te = t.weldbooksBr.ecd;
  const exportEcd = useExportEcd();
  const [warnings, setWarnings] = useState<string[]>([]);

  const schema = useMemo(
    () => createSchema({ year: te.errors.year, required: te.errors.required, cpf: te.errors.cpf, email: te.errors.email, phone: te.errors.phone }),
    [te.errors],
  );
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      year: defaultYear ?? new Date().getFullYear() - 1,
      contadorName: '',
      contadorCpf: '',
      contadorCrc: '',
      contadorCrcUf: '',
      contadorEmail: '',
      contadorPhone: '',
      repName: '',
      repCpf: '',
      repCode: '205',
    },
  });
  const errors = form.formState.errors;

  const submit = async (values: FormValues) => {
    const signatories: EcdSignatory[] = [
      {
        name: values.contadorName,
        taxId: normalizeCpf(values.contadorCpf),
        code: '900',
        qualification: 'Contador',
        crc: values.contadorCrc,
        crcUf: values.contadorCrcUf,
        ...(values.contadorEmail ? { email: values.contadorEmail } : {}),
        ...(values.contadorPhone ? { phone: values.contadorPhone.replace(/\D/g, '') } : {}),
        legalRepresentative: false,
      },
      {
        name: values.repName,
        taxId: normalizeCpf(values.repCpf),
        code: values.repCode,
        qualification: REPRESENTATIVE_QUALIFICATIONS[values.repCode],
        legalRepresentative: true,
      },
    ];
    try {
      const result = await exportEcd.mutateAsync({ year: values.year, signatories });
      downloadBlob(result.blob, result.filename ?? `ECD-${values.year}.txt`);
      setWarnings(result.warnings);
      toast.success(te.downloaded);
      if (result.warnings.length === 0) onOpenChange(false);
    } catch (err) {
      toast.error(te.failed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  const field = (name: keyof FormValues, label: string, props: React.ComponentProps<typeof Input> = {}) => (
    <div className="space-y-2">
      <Label htmlFor={`ecd-${name}`}>{label}</Label>
      <Input id={`ecd-${name}`} aria-invalid={Boolean(errors[name])} {...props} {...form.register(name)} />
      {errors[name] && <p className="text-sm text-destructive">{errors[name]?.message as string}</p>}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setWarnings([]);
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{te.title}</DialogTitle>
          <DialogDescription>{te.description}</DialogDescription>
        </DialogHeader>

        <form id="ecd-form" onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate>
          <div className="max-w-40">{field('year', te.year, { type: 'number', inputMode: 'numeric' })}</div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{te.contador}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field('contadorName', te.name)}
              {field('contadorCpf', te.cpf, { placeholder: '000.000.000-00', autoComplete: 'off' })}
              {field('contadorCrc', te.crc, { placeholder: '1SP123456/O-8' })}
              <div className="space-y-2">
                <Label htmlFor="ecd-contadorCrcUf">{te.crcUf}</Label>
                <Controller
                  control={form.control}
                  name="contadorCrcUf"
                  render={({ field: f }) => (
                    <Select value={f.value || NO_UF} onValueChange={(v) => f.onChange(v === NO_UF ? '' : v)}>
                      <SelectTrigger id="ecd-contadorCrcUf">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="max-h-72">
                        <SelectItem value={NO_UF}>{te.selectUf}</SelectItem>
                        {BR_STATES.map((s) => (
                          <SelectItem key={s.uf} value={s.uf}>
                            {s.name} ({s.uf})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                {errors.contadorCrcUf && <p className="text-sm text-destructive">{errors.contadorCrcUf.message}</p>}
              </div>
              {field('contadorEmail', te.email, { type: 'email' })}
              {field('contadorPhone', te.phone, { inputMode: 'tel', placeholder: '11987654321' })}
            </div>
          </fieldset>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">{te.representative}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {field('repName', te.name)}
              {field('repCpf', te.cpf, { placeholder: '000.000.000-00', autoComplete: 'off' })}
              <div className="space-y-2">
                <Label htmlFor="ecd-repCode">{te.qualification}</Label>
                <Controller
                  control={form.control}
                  name="repCode"
                  render={({ field: f }) => (
                    <Select value={f.value} onValueChange={f.onChange}>
                      <SelectTrigger id="ecd-repCode">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {REPRESENTATIVE_CODES.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code} · {(te.qualifications as Record<string, string>)[code]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </div>
            </div>
          </fieldset>
        </form>

        {warnings.length > 0 && (
          <Alert data-testid="ecd-warnings">
            <AlertTriangle />
            <AlertDescription>
              <p className="font-medium">{te.warningsTitle}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={exportEcd.isPending}>
            {warnings.length > 0 ? te.close : te.cancel}
          </Button>
          <Button type="submit" form="ecd-form" disabled={exportEcd.isPending}>
            {exportEcd.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : <Download className="mr-1 h-4 w-4" aria-hidden />}
            {exportEcd.isPending ? te.building : te.download}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
