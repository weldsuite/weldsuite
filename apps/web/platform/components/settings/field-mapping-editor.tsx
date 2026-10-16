import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import type { TranslationNamespaces } from '@/lib/i18n';
import {
  ArrowLeftRight,
  ArrowDown,
  ArrowUp,
  Plus,
  Trash2,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Tabs, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { toast } from 'sonner';
import {
  useFieldMappings,
  useDefaultFieldMappings,
  useUpdateFieldMappings,
} from '@/hooks/queries/use-integration-queries';

function getEntityTypes(t: ReturnType<typeof useTranslations>) {
  return [
    { value: 'customer', label: t('sweep.settings.fieldMapping.entities.companies') },
    { value: 'contact', label: t('sweep.settings.fieldMapping.entities.contacts') },
    { value: 'lead', label: t('sweep.settings.fieldMapping.entities.leads') },
    { value: 'opportunity', label: t('sweep.settings.fieldMapping.entities.opportunities') },
    { value: 'activity', label: t('sweep.settings.fieldMapping.entities.activities') },
  ];
}

type FieldLabelKey = keyof TranslationNamespaces['settings']['fieldMappingFields'];
type FieldOption = { value: string; labelKey: FieldLabelKey };

const EXTERNAL_FIELDS: Record<string, FieldOption[]> = {
  contact: [
    { value: 'properties.firstname', labelKey: 'firstName' },
    { value: 'properties.lastname', labelKey: 'lastName' },
    { value: 'properties.email', labelKey: 'email' },
    { value: 'properties.phone', labelKey: 'phone' },
    { value: 'properties.mobilephone', labelKey: 'mobilePhone' },
    { value: 'properties.jobtitle', labelKey: 'jobTitle' },
    { value: 'properties.company', labelKey: 'company' },
    { value: 'properties.website', labelKey: 'website' },
    { value: 'properties.lifecyclestage', labelKey: 'lifecycleStage' },
    { value: 'properties.hs_lead_status', labelKey: 'leadStatus' },
    { value: 'properties.address', labelKey: 'address' },
    { value: 'properties.city', labelKey: 'city' },
    { value: 'properties.state', labelKey: 'state' },
    { value: 'properties.zip', labelKey: 'zip' },
    { value: 'properties.country', labelKey: 'country' },
  ],
  customer: [
    { value: 'properties.name', labelKey: 'companyName' },
    { value: 'properties.domain', labelKey: 'domain' },
    { value: 'properties.phone', labelKey: 'phone' },
    { value: 'properties.industry', labelKey: 'industry' },
    { value: 'properties.description', labelKey: 'description' },
    { value: 'properties.numberofemployees', labelKey: 'numberOfEmployees' },
    { value: 'properties.annualrevenue', labelKey: 'annualRevenue' },
    { value: 'properties.website', labelKey: 'website' },
    { value: 'properties.address', labelKey: 'address' },
    { value: 'properties.city', labelKey: 'city' },
    { value: 'properties.state', labelKey: 'state' },
    { value: 'properties.zip', labelKey: 'zip' },
    { value: 'properties.country', labelKey: 'country' },
  ],
  opportunity: [
    { value: 'properties.dealname', labelKey: 'dealName' },
    { value: 'properties.amount', labelKey: 'amount' },
    { value: 'properties.dealstage', labelKey: 'dealStage' },
    { value: 'properties.pipeline', labelKey: 'pipeline' },
    { value: 'properties.closedate', labelKey: 'closeDate' },
    { value: 'properties.description', labelKey: 'description' },
    { value: 'properties.deal_currency_code', labelKey: 'currency' },
  ],
  lead: [],
  activity: [],
};

const INTERNAL_FIELDS: Record<string, FieldOption[]> = {
  contact: [
    { value: 'firstName', labelKey: 'firstName' },
    { value: 'lastName', labelKey: 'lastName' },
    { value: 'fullName', labelKey: 'fullName' },
    { value: 'email', labelKey: 'email' },
    { value: 'directPhone', labelKey: 'directPhone' },
    { value: 'mobile', labelKey: 'mobile' },
    { value: 'title', labelKey: 'jobTitle' },
    { value: 'department', labelKey: 'department' },
    { value: 'status', labelKey: 'status' },
    { value: 'address', labelKey: 'address' },
    { value: 'city', labelKey: 'city' },
    { value: 'state', labelKey: 'state' },
    { value: 'zip', labelKey: 'zip' },
    { value: 'country', labelKey: 'country' },
  ],
  customer: [
    { value: 'companyName', labelKey: 'companyName' },
    { value: 'email', labelKey: 'email' },
    { value: 'phone', labelKey: 'phone' },
    { value: 'website', labelKey: 'website' },
    { value: 'industry', labelKey: 'industry' },
    { value: 'notes', labelKey: 'notes' },
    { value: 'billingAddress', labelKey: 'billingAddress' },
    { value: 'billingCity', labelKey: 'billingCity' },
    { value: 'billingCountry', labelKey: 'billingCountry' },
    { value: 'status', labelKey: 'status' },
    { value: 'source', labelKey: 'source' },
  ],
  opportunity: [
    { value: 'name', labelKey: 'dealName' },
    { value: 'amount', labelKey: 'amount' },
    { value: 'currency', labelKey: 'currency' },
    { value: 'stage', labelKey: 'stage' },
    { value: 'pipeline', labelKey: 'pipeline' },
    { value: 'closeDate', labelKey: 'closeDate' },
    { value: 'description', labelKey: 'description' },
    { value: 'probability', labelKey: 'probability' },
  ],
  lead: [],
  activity: [],
};

const DIRECTION_ICONS = {
  inbound: <ArrowDown className="h-3 w-3" />,
  outbound: <ArrowUp className="h-3 w-3" />,
  bidirectional: <ArrowLeftRight className="h-3 w-3" />,
} as const;

function getDirectionLabels(t: ReturnType<typeof useTranslations>) {
  return {
    inbound: t('sweep.settings.fieldMapping.inboundOnly'),
    outbound: t('sweep.settings.fieldMapping.outboundOnly'),
    bidirectional: t('sweep.settings.fieldMapping.bothDirections'),
  } as const;
}

interface EditableMapping {
  externalFieldPath: string;
  internalFieldPath: string;
  direction: 'inbound' | 'outbound' | 'bidirectional';
  transformType: 'direct' | 'lookup' | 'format_date' | 'custom';
  transformConfig?: Record<string, unknown>;
  isRequired?: boolean;
}

// Mappings carry no id, so each row object gets a stable render key the first
// time it is seen; updates carry the key over to the replacement object.
const mappingKeys = new WeakMap<object, string>();
let mappingKeySeq = 0;

function getMappingKey(mapping: object): string {
  let key = mappingKeys.get(mapping);
  if (!key) {
    mappingKeySeq += 1;
    key = `mapping-${mappingKeySeq}`;
    mappingKeys.set(mapping, key);
  }
  return key;
}

function carryMappingKey<T extends object>(previous: object, next: T): T {
  mappingKeys.set(next, getMappingKey(previous));
  return next;
}

export function FieldMappingEditor({ connectionId }: Readonly<{ connectionId: string }>) {
  const t = useTranslations();
  const { t: i18n } = useI18n();
  const fieldLabels = i18n.settings.fieldMappingFields;
  const ENTITY_TYPES = React.useMemo(() => getEntityTypes(t), [t]);
  const DIRECTION_LABELS = React.useMemo(() => getDirectionLabels(t), [t]);
  const [activeEntityType, setActiveEntityType] = React.useState('customer');
  const { data: mappingsRes, isLoading } = useFieldMappings(connectionId, activeEntityType);
  const { data: defaultsRes } = useDefaultFieldMappings(connectionId, activeEntityType);
  const updateMappings = useUpdateFieldMappings();

  const [localMappings, setLocalMappings] = React.useState<EditableMapping[]>([]);
  const [isDirty, setIsDirty] = React.useState(false);

  React.useEffect(() => {
    if (mappingsRes?.data) {
      setLocalMappings(mappingsRes.data.map(m => ({
        externalFieldPath: m.externalFieldPath,
        internalFieldPath: m.internalFieldPath,
        direction: m.direction,
        transformType: m.transformType,
        transformConfig: m.transformConfig || undefined,
        isRequired: m.isRequired,
      })));
      setIsDirty(false);
    }
  }, [mappingsRes]);

  const handleSave = async () => {
    try {
      await updateMappings.mutateAsync({
        connectionId,
        entityType: activeEntityType,
        mappings: localMappings,
      });
      toast.success(t('sweep.settings.fieldMapping.savedToast'));
      setIsDirty(false);
    } catch {
      toast.error(t('sweep.settings.fieldMapping.saveFailedToast'));
    }
  };

  const handleResetToDefaults = () => {
    if (defaultsRes?.data) {
      setLocalMappings(defaultsRes.data.map(m => ({
        externalFieldPath: m.externalFieldPath,
        internalFieldPath: m.internalFieldPath,
        direction: m.direction,
        transformType: m.transformType,
        transformConfig: m.transformConfig,
        isRequired: m.isRequired,
      })));
      setIsDirty(true);
    }
  };

  const handleAddMapping = () => {
    setLocalMappings(prev => [...prev, {
      externalFieldPath: '',
      internalFieldPath: '',
      direction: 'bidirectional',
      transformType: 'direct',
    }]);
    setIsDirty(true);
  };

  const handleRemoveMapping = (index: number) => {
    setLocalMappings(prev => prev.filter((_, i) => i !== index));
    setIsDirty(true);
  };

  const handleUpdateMapping = (index: number, field: keyof EditableMapping, value: string) => {
    setLocalMappings(prev => prev.map((m, i) =>
      i === index ? carryMappingKey(m, { ...m, [field]: value }) : m
    ));
    setIsDirty(true);
  };

  const cycleDirection = (index: number) => {
    const order: Array<'inbound' | 'outbound' | 'bidirectional'> = ['bidirectional', 'inbound', 'outbound'];
    setLocalMappings(prev => prev.map((m, i) => {
      if (i !== index) return m;
      const nextIdx = (order.indexOf(m.direction) + 1) % order.length;
      return carryMappingKey(m, { ...m, direction: order[nextIdx] });
    }));
    setIsDirty(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{t('sweep.settings.fieldMapping.loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <Tabs value={activeEntityType} onValueChange={setActiveEntityType}>
          <TabsList>
            {ENTITY_TYPES.map(et => (
              <TabsTrigger key={et.value} value={et.value}>{et.label}</TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleResetToDefaults}>
            <RotateCcw className="h-3 w-3 mr-1" />
            {t('sweep.settings.fieldMapping.defaults')}
          </Button>
          {isDirty && (
            <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={updateMappings.isPending}>
              {updateMappings.isPending && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
              {t('sweep.settings.fieldMapping.save')}
            </Button>
          )}
        </div>
      </div>

      {/* Mapping table */}
      {localMappings.length > 0 ? (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {/* Header */}
          <div className="grid grid-cols-[1fr_32px_1fr_80px_32px] gap-2 items-center px-4 py-2.5 border-b border-border bg-muted/30 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            <span>{t('sweep.settings.fieldMapping.externalField')}</span>
            <span />
            <span>{t('sweep.settings.fieldMapping.weldsuiteField')}</span>
            <span>{t('sweep.settings.fieldMapping.transform')}</span>
            <span />
          </div>

          {/* Rows */}
          <div className="divide-y divide-border">
            {localMappings.map((mapping, index) => (
              <div
                key={getMappingKey(mapping)}
                className="grid grid-cols-[1fr_32px_1fr_80px_32px] gap-2 items-center px-4 py-2"
              >
                <Select
                  value={mapping.externalFieldPath}
                  onValueChange={(v) => handleUpdateMapping(index, 'externalFieldPath', v)}
                >
                  <SelectTrigger className="h-7 text-xs border-0 bg-transparent shadow-none px-0 hover:bg-accent/50 rounded">
                    <SelectValue placeholder={t('sweep.settings.fieldMapping.selectFieldPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(EXTERNAL_FIELDS[activeEntityType] || []).map(f => (
                      <SelectItem key={f.value} value={f.value}>{fieldLabels[f.labelKey]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent/50 text-muted-foreground transition-colors"
                  onClick={() => cycleDirection(index)}
                  title={DIRECTION_LABELS[mapping.direction]}
                >
                  {DIRECTION_ICONS[mapping.direction]}
                </Button>

                <Select
                  value={mapping.internalFieldPath}
                  onValueChange={(v) => handleUpdateMapping(index, 'internalFieldPath', v)}
                >
                  <SelectTrigger className="h-7 text-xs border-0 bg-transparent shadow-none px-0 hover:bg-accent/50 rounded">
                    <SelectValue placeholder={t('sweep.settings.fieldMapping.selectFieldPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(INTERNAL_FIELDS[activeEntityType] || []).map(f => (
                      <SelectItem key={f.value} value={f.value}>{fieldLabels[f.labelKey]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={mapping.transformType}
                  onValueChange={(v) => handleUpdateMapping(index, 'transformType', v)}
                >
                  <SelectTrigger className="h-7 text-[10px] border-0 bg-transparent shadow-none px-0 hover:bg-accent/50 rounded">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="direct">{t('sweep.settings.fieldMapping.transformDirect')}</SelectItem>
                    <SelectItem value="lookup">{t('sweep.settings.fieldMapping.transformLookup')}</SelectItem>
                    <SelectItem value="format_date">{t('sweep.settings.fieldMapping.transformDate')}</SelectItem>
                    <SelectItem value="custom">{t('sweep.settings.fieldMapping.transformCustom')}</SelectItem>
                  </SelectContent>
                </Select>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex items-center justify-center rounded text-muted-foreground/50 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
                  onClick={() => handleRemoveMapping(index)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border rounded-xl p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t('sweep.settings.fieldMapping.noMappings')}
          </p>
        </div>
      )}

      {/* Add row */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleAddMapping}
      >
        <Plus className="h-4 w-4 mr-2" />
        {t('sweep.settings.fieldMapping.addMapping')}
      </Button>
    </div>
  );
}
