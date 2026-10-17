import { Controller, useFormContext } from 'react-hook-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { useI18n } from '@/lib/i18n/provider';
import type { BrContactValues, BrIcmsChoice } from '@/lib/weldbooks/br-contact';

/** The part of the contact form's values this section reads and writes. */
interface BrContactFormShape {
  br: BrContactValues;
}

/**
 * Brazil: the fiscal details the tax engine reads from a counterparty:
 * municipal registration and IBGE code (ISS is owed where the service is taken),
 * whether it is an ICMS taxpayer and whether it is in the Simples Nacional (no
 * IRRF / CSRF withholding on its services).
 */
export function BrContactSection() {
  const { t } = useI18n();
  const tb = t.weldbooksBr.contact;
  const form = useFormContext<BrContactFormShape>();
  const municipalityError = (form.formState.errors.br as { municipalityCode?: { message?: string } } | undefined)
    ?.municipalityCode?.message;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tb.title}</CardTitle>
        <CardDescription>{tb.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="br-inscricaoMunicipal">{tb.inscricaoMunicipal}</Label>
          <Input id="br-inscricaoMunicipal" {...form.register('br.inscricaoMunicipal')} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="br-municipalityCode">{tb.municipalityCode}</Label>
          <Input
            id="br-municipalityCode"
            inputMode="numeric"
            maxLength={7}
            placeholder="3550308"
            aria-invalid={Boolean(municipalityError)}
            aria-describedby="br-municipalityCode-help"
            {...form.register('br.municipalityCode')}
          />
          {municipalityError ? (
            <p className="text-sm text-destructive">{municipalityError}</p>
          ) : (
            <p id="br-municipalityCode-help" className="text-xs text-muted-foreground">{tb.municipalityCodeHelp}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="br-icmsContributor">{tb.icmsContributor}</Label>
          <Controller
            control={form.control}
            name="br.icmsContributor"
            render={({ field }) => (
              <Select value={field.value} onValueChange={(next) => field.onChange(next as BrIcmsChoice)}>
                <SelectTrigger id="br-icmsContributor" aria-describedby="br-icmsContributor-help">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{tb.icmsOptions.auto}</SelectItem>
                  <SelectItem value="yes">{tb.icmsOptions.yes}</SelectItem>
                  <SelectItem value="no">{tb.icmsOptions.no}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          <p id="br-icmsContributor-help" className="text-xs text-muted-foreground">{tb.icmsContributorHelp}</p>
        </div>
        <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3">
          <div className="space-y-1">
            <Label htmlFor="br-simplesNacional">{tb.simplesNacional}</Label>
            <p className="text-xs text-muted-foreground">{tb.simplesNacionalHelp}</p>
          </div>
          <Controller
            control={form.control}
            name="br.simplesNacional"
            render={({ field }) => (
              <Switch id="br-simplesNacional" checked={field.value} onCheckedChange={field.onChange} />
            )}
          />
        </div>
      </CardContent>
    </Card>
  );
}
