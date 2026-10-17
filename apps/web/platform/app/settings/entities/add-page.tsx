import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { AddressFields } from '@/components/address/address-fields';
import { cleanPostalAddress, type PostalAddress } from '@/components/address/postal-address';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { useAccountingJurisdictions } from '@/hooks/queries/use-accounting-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { entityTypesFor } from '@/lib/weldbooks/entity-types';
import { isUsJurisdictionCode } from '@/lib/weldbooks/us-entity';
import { isValidIban } from '@/lib/weldbooks/identifiers';
import { BrEntityCreateForm } from './components/br-entity-create-form';
import { UsEntityCreateForm } from './components/us-entity-create-form';

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN', 'INR', 'BRL'];

const JURISDICTION_DEFAULTS: Record<string, { baseCurrency: string; locale: string; timezone: string; country: string }> = {
  NL: { baseCurrency: 'EUR', locale: 'nl-NL', timezone: 'Europe/Amsterdam', country: 'NL' },
  IN: { baseCurrency: 'INR', locale: 'en-IN', timezone: 'Asia/Kolkata', country: 'IN' },
  BR: { baseCurrency: 'BRL', locale: 'pt-BR', timezone: 'America/Sao_Paulo', country: 'BR' },
};

/** A business address an invoice can print: street, city and country. */
function isUsableAddress(address: PostalAddress): boolean {
  return Boolean(address.line1?.trim() && address.city?.trim() && address.country?.trim());
}

export default function AddEntityPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setEntityId } = useCurrentAccountingEntity();
  const { t } = useI18n();
  const st = useTranslations();
  const te = t.accounting.entities;

  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [entityType, setEntityType] = useState('bv');
  const [jurisdictionCode, setJurisdictionCode] = useState('NL');
  const [baseCurrency, setBaseCurrency] = useState('EUR');
  const [vatNumber, setVatNumber] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [iban, setIban] = useState('');
  const [address, setAddress] = useState<PostalAddress>({ country: JURISDICTION_DEFAULTS.NL.country });
  const [isDefault, setIsDefault] = useState(false);
  const [seedDefaults, setSeedDefaults] = useState(true);

  const isIndia = jurisdictionCode === 'IN';
  const jurisdictionDefaults = JURISDICTION_DEFAULTS[jurisdictionCode];
  const entityTypes = entityTypesFor(jurisdictionCode, entityType).map((value) => ({
    value,
    label: t.accounting.entityTypes[value],
  }));

  const { data: jurisdictions = [] } = useAccountingJurisdictions();
  const isUs = isUsJurisdictionCode(jurisdictionCode);
  const isBr = jurisdictionCode === 'BR';
  const usJurisdiction = jurisdictions.find((j) => isUsJurisdictionCode(j.code));

  // An IBAN needs the length of its country and valid check digits; an Indian account number is free text.
  const ibanInvalid = !isIndia && iban.trim() !== '' && !isValidIban(iban);

  function buildBankDetails() {
    if (!iban) return undefined;
    if (isIndia) return { accountNumber: iban };
    return { iban };
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      return weldbooksApi.post<{ data: { id: string } } | { id: string }>('/accounting-entities', {
        name,
        legalName: legalName || undefined,
        entityType,
        jurisdictionCode,
        baseCurrency,
        locale: jurisdictionDefaults?.locale,
        timezone: jurisdictionDefaults?.timezone,
        taxIdentifiers: {
          vatNumber: vatNumber || undefined,
          registrationNumber: registrationNumber || undefined,
        },
        bankDetails: buildBankDetails(),
        address: cleanPostalAddress(address),
        isDefault,
        seedDefaults,
      });
    },
    onSuccess: (res) => {
      const created = 'data' in res ? res.data : res;
      if (created?.id) setEntityId(created.id);
      queryClient.invalidateQueries({ queryKey: ['accounting', 'entities'] });
      navigate({ to: '/settings/entities' });
    },
  });

  const handleJurisdictionChange = (v: string) => {
    setJurisdictionCode(v);
    const d = JURISDICTION_DEFAULTS[v];
    if (d) setBaseCurrency(d.baseCurrency);
    // The address country follows the jurisdiction until the user picks another one.
    const previous = JURISDICTION_DEFAULTS[jurisdictionCode]?.country;
    if (d && (!address.country || address.country === previous)) setAddress({ ...address, country: d.country, state: '' });
    const allowed = entityTypesFor(v);
    if (!allowed.includes(entityType as (typeof allowed)[number])) setEntityType(allowed[0]);
  };

  const jurisdictionPicker = (
    <Select value={jurisdictionCode} onValueChange={handleJurisdictionChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {jurisdictions.map((j) => (
          <SelectItem key={j.code} value={j.code}>{j.name} ({j.code})</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  // A US entity has its own form: legal form and tax classification, EIN or SSN, accounting method, fiscal year.
  if (isUs && usJurisdiction?.entityTypes) {
    return <UsEntityCreateForm jurisdictionPicker={jurisdictionPicker} entityTypes={usJurisdiction.entityTypes} />;
  }

  // A Brazilian entity has its own form: legal form and tax regime, CNPJ and state registration, municipality, Pix.
  if (isBr) return <BrEntityCreateForm jurisdictionPicker={jurisdictionPicker} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{te.newLegalEntity}</h1>
        <p className="text-sm text-muted-foreground">
          {te.newLegalEntityDesc}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Label>{te.displayName}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={te.displayNamePlaceholders[jurisdictionCode] ?? te.displayNamePlaceholder} />
        </div>
        <div className="col-span-2">
          <Label>{te.legalName}</Label>
          <Input
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            placeholder={te.legalNamePlaceholders[jurisdictionCode] ?? te.legalNamePlaceholder2}
          />
        </div>

        <div>
          <Label>{te.entityType}</Label>
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {entityTypes.map((et) => (
                <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>{te.jurisdiction}</Label>
          {jurisdictionPicker}
        </div>

        <div>
          <Label>{te.baseCurrency}</Label>
          <Select value={baseCurrency} onValueChange={setBaseCurrency}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>{isIndia ? st('sweep.weldbooks.createEntity.gstinLabel') : te.vatNumber}</Label>
          <Input
            value={vatNumber}
            onChange={(e) => setVatNumber(e.target.value)}
            placeholder={
              isIndia
                ? st('sweep.weldbooks.createEntity.gstinPlaceholder')
                : te.taxIdPlaceholder
            }
          />
        </div>

        <div className="col-span-2">
          <Label>{isIndia ? st('sweep.weldbooks.createEntity.panLabel') : te.registrationNumber}</Label>
          <Input
            value={registrationNumber}
            onChange={(e) => setRegistrationNumber(e.target.value)}
            placeholder={isIndia ? 'AAAAA9999A' : '12345678'}
          />
        </div>

        <div className="col-span-2 space-y-3 rounded-md border border-border p-4" data-testid="entity-address">
          <div>
            <p className="text-sm font-medium">{t.weldbooksIn.address.title}</p>
            <p className="text-xs text-muted-foreground">{t.weldbooksIn.address.description}</p>
          </div>
          <AddressFields idPrefix="new-entity-address" value={address} onChange={setAddress} />
          {!isUsableAddress(address) && (
            <p className="text-xs text-muted-foreground">{t.weldbooksIn.address.required}</p>
          )}
        </div>

        <div className="col-span-2">
          <Label>{isIndia ? st('sweep.weldbooks.createEntity.bankAccountLabel') : te.ibanLabel}</Label>
          <Input
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            aria-invalid={ibanInvalid}
            placeholder={isIndia ? te.accountNumberIfscPlaceholder : 'NL91 ABNA 0417 1643 00'}
          />
          {ibanInvalid && <p className="mt-1 text-sm text-destructive">{t.accounting.contacts.ibanInvalid}</p>}
        </div>

        <label className="flex items-center gap-2 col-span-2">
          <Checkbox checked={isDefault} onCheckedChange={(v) => setIsDefault(!!v)} />
          <span className="text-sm">{te.makeDefault}</span>
        </label>

        <label className="flex items-center gap-2 col-span-2">
          <Checkbox checked={seedDefaults} onCheckedChange={(v) => setSeedDefaults(!!v)} />
          <span className="text-sm">{te.seedDefaults}</span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={() => createMutation.mutate()}
          disabled={!name || !isUsableAddress(address) || ibanInvalid || createMutation.isPending}
        >
          {createMutation.isPending ? te.creatingEntity : te.createEntity2}
        </Button>
        <Button variant="outline" onClick={() => navigate({ to: '/settings/entities' })}>
          {te.cancel}
        </Button>
      </div>

      {createMutation.isError ? (
        <p className="text-sm text-destructive">
          {(createMutation.error as Error)?.message ?? te.failedToCreate}
        </p>
      ) : null}
    </div>
  );
}
