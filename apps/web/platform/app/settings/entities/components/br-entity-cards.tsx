import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import { BR_STATES } from '@/components/address/br-states';
import { useI18n } from '@/lib/i18n/provider';
import {
  BR_SIMPLES_ANEXOS,
  allowedBrRegimes,
  isSimplesBrRegime,
  type BrEntityValues,
  type BrSimplesAnexo,
} from '@/lib/weldbooks/br-entity';

const NO_ANEXO = '__none__';

interface BrFieldProps {
  id: string;
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
  className?: string;
}

/** A labelled field with its help line and error message. */
export function BrField({ id, label, help, error, children, className }: Readonly<BrFieldProps>) {
  const helpLine = help ? <p className="text-xs text-muted-foreground" id={`${id}-help`}>{help}</p> : null;
  return (
    <div className={className ?? 'space-y-2'}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-sm text-destructive" id={`${id}-error`}>{error}</p>
      ) : helpLine}
    </div>
  );
}

/** The messages of the BR fields, by field. */
export type BrEntityFieldErrors = Partial<Record<keyof BrEntityValues, string>>;

interface BrEntityCardsProps {
  value: BrEntityValues;
  onChange: (next: BrEntityValues) => void;
  errors?: BrEntityFieldErrors;
  /** The entity's legal form: it decides which regimes are offered. */
  entityType: string | null | undefined;
  disabled?: boolean;
  /** Prefix of the field ids, so the form can share a page with other forms. */
  idPrefix: string;
  /** The UF changed: the address follows it. */
  onUfChange?: (uf: string) => void;
}

/**
 * The Brazil-specific cards of the entity form: tax regime (with the Simples
 * annex and payroll for the fator R), fiscal registrations (municipality,
 * inscrição municipal, CNAE, ISS rate), fiscal documents and Pix, and the CBS /
 * IBS rates of the tax reform. One nested form value, edited as a whole. The
 * CNPJ and the inscrição estadual are the entity's tax identifiers and are
 * shown by the caller next to the other identifiers.
 */
export function BrEntityCards({
  value,
  onChange,
  errors = {},
  entityType,
  disabled,
  idPrefix,
  onUfChange,
}: Readonly<BrEntityCardsProps>) {
  const { t } = useI18n();
  const tb = t.weldbooksBr.entity;
  const update = (patch: Partial<BrEntityValues>) => onChange({ ...value, ...patch });
  const id = (field: string) => `${idPrefix}-${field}`;
  const regimes = allowedBrRegimes(entityType);
  const regimeLabels = tb.regimes as Record<string, string>;
  const regimeHelp = tb.regimeDescriptions as Record<string, string>;
  const simples = isSimplesBrRegime(value.regime);
  const ufState = BR_STATES.find((s) => s.uf === value.uf);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{tb.regimeTitle}</CardTitle>
          <CardDescription>{tb.regimeDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <BrField id={id('regime')} label={tb.regime} help={regimeHelp[value.regime]} error={errors.regime} className="space-y-2 sm:col-span-2">
            <Select value={value.regime} onValueChange={(next) => update({ regime: next as BrEntityValues['regime'] })} disabled={disabled}>
              <SelectTrigger id={id('regime')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {regimes.map((regime) => (
                  <SelectItem key={regime} value={regime}>
                    {regimeLabels[regime]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </BrField>
          <p className="text-xs text-muted-foreground sm:col-span-2">{tb.regimeChangeNote}</p>
          {simples && (
            <>
              <BrField id={id('simplesAnexo')} label={tb.simplesAnexo} help={tb.simplesAnexoHelp}>
                <Select
                  value={value.simplesAnexo || NO_ANEXO}
                  onValueChange={(next) => update({ simplesAnexo: next === NO_ANEXO ? '' : (next as BrSimplesAnexo) })}
                  disabled={disabled}
                >
                  <SelectTrigger id={id('simplesAnexo')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ANEXO}>{tb.simplesAnexoNone}</SelectItem>
                    {BR_SIMPLES_ANEXOS.map((anexo) => (
                      <SelectItem key={anexo} value={anexo}>
                        {(tb.anexos as Record<string, string>)[anexo]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </BrField>
              <BrField id={id('payroll12m')} label={tb.payroll12m} help={tb.payroll12mHelp} error={errors.payroll12m}>
                <Input
                  id={id('payroll12m')}
                  inputMode="decimal"
                  value={value.payroll12m}
                  disabled={disabled}
                  onChange={(e) => update({ payroll12m: e.target.value })}
                />
              </BrField>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tb.registrationsTitle}</CardTitle>
          <CardDescription>{tb.registrationsDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <BrField id={id('uf')} label={tb.uf} error={errors.uf}>
            <Select
              value={value.uf || undefined}
              onValueChange={(next) => {
                update({ uf: next });
                onUfChange?.(next);
              }}
              disabled={disabled}
            >
              <SelectTrigger id={id('uf')}>
                <SelectValue placeholder={tb.selectUf} />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {BR_STATES.map((state) => (
                  <SelectItem key={state.uf} value={state.uf}>
                    {state.name} ({state.uf})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </BrField>
          <BrField
            id={id('municipalityCode')}
            label={tb.municipalityCode}
            help={ufState ? tb.municipalityCodeHelpUf.replace('{ibge}', ufState.ibge) : tb.municipalityCodeHelp}
            error={errors.municipalityCode}
          >
            <Input
              id={id('municipalityCode')}
              inputMode="numeric"
              maxLength={7}
              placeholder="3550308"
              value={value.municipalityCode}
              disabled={disabled}
              aria-invalid={Boolean(errors.municipalityCode)}
              onChange={(e) => update({ municipalityCode: e.target.value.replace(/\D/g, '') })}
            />
          </BrField>
          <BrField id={id('municipalityName')} label={tb.municipalityName}>
            <Input
              id={id('municipalityName')}
              placeholder="São Paulo"
              value={value.municipalityName}
              disabled={disabled}
              onChange={(e) => update({ municipalityName: e.target.value })}
            />
          </BrField>
          <BrField id={id('inscricaoMunicipal')} label={tb.inscricaoMunicipal} help={tb.inscricaoMunicipalHelp}>
            <Input
              id={id('inscricaoMunicipal')}
              value={value.inscricaoMunicipal}
              disabled={disabled}
              onChange={(e) => update({ inscricaoMunicipal: e.target.value })}
            />
          </BrField>
          <BrField id={id('cnae')} label={tb.cnae} help={tb.cnaeHelp} error={errors.cnae}>
            <Input
              id={id('cnae')}
              placeholder="6201-5/01"
              value={value.cnae}
              disabled={disabled}
              aria-invalid={Boolean(errors.cnae)}
              onChange={(e) => update({ cnae: e.target.value })}
            />
          </BrField>
          <BrField id={id('issRate')} label={tb.issRate} help={tb.issRateHelp} error={errors.issRate}>
            <Input
              id={id('issRate')}
              inputMode="decimal"
              placeholder="2"
              value={value.issRate}
              disabled={disabled}
              aria-invalid={Boolean(errors.issRate)}
              onChange={(e) => update({ issRate: e.target.value })}
            />
          </BrField>
          <div className="flex items-start justify-between gap-3 rounded-md border border-border p-3 sm:col-span-2">
            <div className="space-y-1">
              <Label htmlFor={id('icmsContributor')}>{tb.icmsContributor}</Label>
              <p className="text-xs text-muted-foreground">{tb.icmsContributorHelp}</p>
            </div>
            <Switch
              id={id('icmsContributor')}
              checked={value.icmsContributor}
              disabled={disabled}
              onCheckedChange={(checked) => update({ icmsContributor: checked })}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tb.fiscalTitle}</CardTitle>
          <CardDescription>{tb.fiscalDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <BrField id={id('nfseStandard')} label={tb.nfseStandard} help={tb.nfseStandardHelp}>
            <Select
              value={value.nfseStandard}
              onValueChange={(next) => update({ nfseStandard: next as BrEntityValues['nfseStandard'] })}
              disabled={disabled}
            >
              <SelectTrigger id={id('nfseStandard')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nacional">{tb.nfseStandards.nacional}</SelectItem>
                <SelectItem value="municipal">{tb.nfseStandards.municipal}</SelectItem>
              </SelectContent>
            </Select>
          </BrField>
          <BrField id={id('nfeSeries')} label={tb.nfeSeries} help={tb.nfeSeriesHelp} error={errors.nfeSeries}>
            <Input
              id={id('nfeSeries')}
              inputMode="numeric"
              maxLength={3}
              placeholder="1"
              value={value.nfeSeries}
              disabled={disabled}
              aria-invalid={Boolean(errors.nfeSeries)}
              onChange={(e) => update({ nfeSeries: e.target.value.replace(/\D/g, '') })}
            />
          </BrField>
          <BrField id={id('pixKey')} label={tb.pixKey} help={tb.pixKeyHelp} error={errors.pixKey}>
            <Input
              id={id('pixKey')}
              autoComplete="off"
              value={value.pixKey}
              disabled={disabled}
              aria-invalid={Boolean(errors.pixKey)}
              onChange={(e) => update({ pixKey: e.target.value })}
            />
          </BrField>
          <BrField id={id('pixCity')} label={tb.pixCity} help={tb.pixCityHelp} error={errors.pixCity}>
            <Input
              id={id('pixCity')}
              maxLength={15}
              value={value.pixCity}
              disabled={disabled}
              aria-invalid={Boolean(errors.pixCity)}
              onChange={(e) => update({ pixCity: e.target.value })}
            />
          </BrField>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tb.reformTitle}</CardTitle>
          <CardDescription>{tb.reformDescription}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <BrField id={id('cbsRate')} label={tb.cbsRate} error={errors.cbsRate}>
            <Input
              id={id('cbsRate')}
              inputMode="decimal"
              value={value.cbsRate}
              disabled={disabled}
              aria-invalid={Boolean(errors.cbsRate)}
              onChange={(e) => update({ cbsRate: e.target.value })}
            />
          </BrField>
          <BrField id={id('ibsRate')} label={tb.ibsRate} error={errors.ibsRate}>
            <Input
              id={id('ibsRate')}
              inputMode="decimal"
              value={value.ibsRate}
              disabled={disabled}
              aria-invalid={Boolean(errors.ibsRate)}
              onChange={(e) => update({ ibsRate: e.target.value })}
            />
          </BrField>
        </CardContent>
      </Card>
    </>
  );
}
