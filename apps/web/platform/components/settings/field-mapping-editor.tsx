import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
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

const EXTERNAL_FIELDS: Record<string, { value: string; label: string }[]> = {
  contact: [
    { value: 'properties.firstname', label: 'First Name' },
    { value: 'properties.lastname', label: 'Last Name' },
    { value: 'properties.email', label: 'Email' },
    { value: 'properties.phone', label: 'Phone' },
    { value: 'properties.mobilephone', label: 'Mobile Phone' },
    { value: 'properties.jobtitle', label: 'Job Title' },
    { value: 'properties.company', label: 'Company' },
    { value: 'properties.website', label: 'Website' },
    { value: 'properties.lifecyclestage', label: 'Lifecycle Stage' },
    { value: 'properties.hs_lead_status', label: 'Lead Status' },
    { value: 'properties.address', label: 'Address' },
    { value: 'properties.city', label: 'City' },
    { value: 'properties.state', label: 'State' },
    { value: 'properties.zip', label: 'Zip' },
    { value: 'properties.country', label: 'Country' },
  ],
  customer: [
    { value: 'properties.name', label: 'Company Name' },
    { value: 'properties.domain', label: 'Domain' },
    { value: 'properties.phone', label: 'Phone' },
    { value: 'properties.industry', label: 'Industry' },
    { value: 'properties.description', label: 'Description' },
    { value: 'properties.numberofemployees', label: 'Number of Employees' },
    { value: 'properties.annualrevenue', label: 'Annual Revenue' },
    { value: 'properties.website', label: 'Website' },
    { value: 'properties.address', label: 'Address' },
    { value: 'properties.city', label: 'City' },
    { value: 'properties.state', label: 'State' },
    { value: 'properties.zip', label: 'Zip' },
    { value: 'properties.country', label: 'Country' },
  ],
  opportunity: [
    { value: 'properties.dealname', label: 'Deal Name' },
    { value: 'properties.amount', label: 'Amount' },
    { value: 'properties.dealstage', label: 'Deal Stage' },
    { value: 'properties.pipeline', label: 'Pipeline' },
    { value: 'properties.closedate', label: 'Close Date' },
    { value: 'properties.description', label: 'Description' },
    { value: 'properties.deal_currency_code', label: 'Currency' },
  ],
  lead: [],
  activity: [],
};

const INTERNAL_FIELDS: Record<string, { value: string; label: string }[]> = {
  contact: [
    { value: 'firstName', label: 'First Name' },
    { value: 'lastName', label: 'Last Name' },
    { value: 'fullName', label: 'Full Name' },
    { value: 'email', label: 'Email' },
    { value: 'directPhone', label: 'Direct Phone' },
    { value: 'mobile', label: 'Mobile' },
    { value: 'title', label: 'Job Title' },
    { value: 'department', label: 'Department' },
    { value: 'status', label: 'Status' },
    { value: 'address', label: 'Address' },
    { value: 'city', label: 'City' },
    { value: 'state', label: 'State' },
    { value: 'zip', label: 'Zip' },
    { value: 'country', label: 'Country' },
  ],
  customer: [
    { value: 'companyName', label: 'Company Name' },
    { value: 'email', label: 'Email' },
    { value: 'phone', label: 'Phone' },
    { value: 'website', label: 'Website' },
    { value: 'industry', label: 'Industry' },
    { value: 'notes', label: 'Notes' },
    { value: 'billingAddress', label: 'Billing Address' },
    { value: 'billingCity', label: 'Billing City' },
    { value: 'billingCountry', label: 'Billing Country' },
    { value: 'status', label: 'Status' },
    { value: 'source', label: 'Source' },
  ],
  opportunity: [
    { value: 'name', label: 'Deal Name' },
    { value: 'amount', label: 'Amount' },
    { value: 'currency', label: 'Currency' },
    { value: 'stage', label: 'Stage' },
    { value: 'pipeline', label: 'Pipeline' },
    { value: 'closeDate', label: 'Close Date' },
    { value: 'description', label: 'Description' },
    { value: 'probability', label: 'Probability' },
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

export function FieldMappingEditor({ connectionId }: { connectionId: string }) {
  const t = useTranslations();
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
      i === index ? { ...m, [field]: value } : m
    ));
    setIsDirty(true);
  };

  const cycleDirection = (index: number) => {
    const order: Array<'inbound' | 'outbound' | 'bidirectional'> = ['bidirectional', 'inbound', 'outbound'];
    setLocalMappings(prev => prev.map((m, i) => {
      if (i !== index) return m;
      const nextIdx = (order.indexOf(m.direction) + 1) % order.length;
      return { ...m, direction: order[nextIdx] };
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
                key={index}
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
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
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
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
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
