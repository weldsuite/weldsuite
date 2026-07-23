import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';

interface Jurisdiction {
  code: string;
  name: string;
}

const ENTITY_TYPE_VALUES: Array<{ value: string; label?: string }> = [
  { value: 'bv', label: 'BV (Besloten Vennootschap)' },
  { value: 'nv', label: 'NV (Naamloze Vennootschap)' },
  { value: 'gmbh', label: 'GmbH' },
  { value: 'ag', label: 'AG' },
  { value: 'ltd', label: 'Ltd' },
  { value: 'inc', label: 'Inc' },
  { value: 'sarl', label: 'SARL' },
  { value: 'sole' },
];

const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'DKK', 'NOK', 'PLN'];

export default function AddEntityPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setEntityId } = useCurrentAccountingEntity();
  const { t } = useI18n();
  const st = useTranslations();
  const te = t.accounting.entities;
  const ENTITY_TYPES = ENTITY_TYPE_VALUES.map((et) => ({
    value: et.value,
    label: et.label ?? st('sweep.weldbooks.entityForm.soleProprietor'),
  }));

  const [name, setName] = useState('');
  const [legalName, setLegalName] = useState('');
  const [entityType, setEntityType] = useState('bv');
  const [jurisdictionCode, setJurisdictionCode] = useState('NL');
  const [baseCurrency, setBaseCurrency] = useState('EUR');
  const [vatNumber, setVatNumber] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [iban, setIban] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [seedDefaults, setSeedDefaults] = useState(true);

  const { data: jurisdictions = [] } = useQuery<Jurisdiction[]>({
    queryKey: ['accounting', 'jurisdictions'],
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: Jurisdiction[] } | Jurisdiction[]>(
        '/accounting-entities/jurisdictions',
      );
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      return weldbooksApi.post<{ data: { id: string } } | { id: string }>('/accounting-entities', {
        name,
        legalName: legalName || undefined,
        entityType,
        jurisdictionCode,
        baseCurrency,
        taxIdentifiers: {
          vatNumber: vatNumber || undefined,
          registrationNumber: registrationNumber || undefined,
        },
        bankDetails: iban ? { iban } : undefined,
        isDefault,
        seedDefaults,
      });
    },
    onSuccess: (res) => {
      const created = (res as any).data ?? res;
      if (created?.id) setEntityId(created.id);
      queryClient.invalidateQueries({ queryKey: ['accounting', 'entities'] });
      navigate({ to: '/weldbooks/entities' });
    },
  });

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{te.newLegalEntity}</h1>
        <p className="text-sm text-muted-foreground">
          {te.newLegalEntityDesc}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2">
          <Label>{te.displayName}</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={te.displayNamePlaceholder} />
        </div>
        <div className="col-span-2">
          <Label>{te.legalName}</Label>
          <Input
            value={legalName}
            onChange={(e) => setLegalName(e.target.value)}
            placeholder={te.legalNamePlaceholder2}
          />
        </div>

        <div>
          <Label>{te.entityType}</Label>
          <Select value={entityType} onValueChange={setEntityType}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {ENTITY_TYPES.map((et) => (
                <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>{te.jurisdiction}</Label>
          <Select value={jurisdictionCode} onValueChange={setJurisdictionCode}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {jurisdictions.map((j) => (
                <SelectItem key={j.code} value={j.code}>{j.name} ({j.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          <Label>{te.vatNumber}</Label>
          <Input
            value={vatNumber}
            onChange={(e) => setVatNumber(e.target.value)}
            placeholder={te.taxIdPlaceholder}
          />
        </div>

        <div className="col-span-2">
          <Label>{te.registrationNumber}</Label>
          <Input
            value={registrationNumber}
            onChange={(e) => setRegistrationNumber(e.target.value)}
            placeholder="12345678"
          />
        </div>

        <div className="col-span-2">
          <Label>{te.ibanLabel}</Label>
          <Input value={iban} onChange={(e) => setIban(e.target.value)} placeholder="NL91 ABNA 0417 1643 00" />
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
          disabled={!name || createMutation.isPending}
        >
          {createMutation.isPending ? te.creatingEntity : te.createEntity2}
        </Button>
        <Button variant="outline" onClick={() => navigate({ to: '/weldbooks/entities' })}>
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
