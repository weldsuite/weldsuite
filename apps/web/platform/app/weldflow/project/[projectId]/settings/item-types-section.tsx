import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  ITEM_TYPES,
  type DeliverySettings,
  type ItemType,
  type ItemTypeNaming,
} from '@weldsuite/app-api-client/schemas/flow-agile';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { GlyphBadge } from '@weldsuite/ui/components/glyph-badge';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { SettingRow, SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { Switch } from '@weldsuite/ui/components/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useI18n } from '@/lib/i18n/provider';
import { apiMessage } from '../close/_lib/api-error';
import { ITEM_TYPE_TONES, itemTypeGlyph } from '@/app/weldflow/lib/item-types';
import { useItemTypeLabel } from '@/components/weldflow/agile/task-type-badge';
import { useProjectDelivery, useUpdateProjectDelivery } from '@/hooks/queries/use-flow-agile-queries';

/** Types every agile project keeps: the backlog needs somewhere to put work. */
const ALWAYS_ON: readonly ItemType[] = ['story', 'task'];

interface ItemTypesSectionProps {
  projectId: string;
  isAdmin: boolean;
}

export function ItemTypesSection({ projectId, isAdmin }: Readonly<ItemTypesSectionProps>) {
  const { t } = useI18n();
  const copy = t.flowAgile.itemTypesSettings;
  const formId = useId();
  const delivery = useProjectDelivery(projectId);
  const save = useUpdateProjectDelivery(projectId);
  const typeLabel = useItemTypeLabel();
  const [draft, setDraft] = useState<DeliverySettings['itemTypes'] | null>(null);

  if (delivery.isLoading) return <PageLoader fullScreen={false} />;

  const current = draft ?? delivery.settings.itemTypes;
  const disabled = !isAdmin || !delivery.usesItemTypes || save.isPending;
  const enabled = new Set(current.enabled);
  const shownTypes = ITEM_TYPES.filter((type) => type !== 'feature' || current.featureLevel);

  const edit = (next: Partial<DeliverySettings['itemTypes']>) => setDraft({ ...current, ...next });
  const toggle = (type: ItemType, on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add(type);
    else next.delete(type);
    // Kept in the canonical order.
    edit({ enabled: ITEM_TYPES.filter((candidate) => next.has(candidate)) });
  };
  const setFeatureLevel = (on: boolean) => {
    const next = new Set(enabled);
    if (on) next.add('feature');
    else next.delete('feature');
    edit({ featureLevel: on, enabled: ITEM_TYPES.filter((candidate) => next.has(candidate)) });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft || disabled) return;
    save.mutate(
      { ...delivery.settings, itemTypes: draft },
      {
        onSuccess: () => {
          setDraft(null);
          toast.success(t.flowAgile.shared.saved);
        },
        onError: (error) => toast.error(apiMessage(error, t.flowAgile.shared.saveFailed)),
      },
    );
  };

  return (
    <form className="max-w-2xl space-y-10" aria-label={copy.title} onSubmit={submit}>
      {!delivery.usesItemTypes && <InfoBanner variant="neutral">{copy.notAgile}</InfoBanner>}
      {delivery.usesItemTypes && !isAdmin && (
        <InfoBanner variant="info">{t.flowAgile.delivery.managersOnly}</InfoBanner>
      )}

      <fieldset disabled={disabled} className="space-y-3">
        <legend className="mb-3 text-base font-semibold">{copy.namingTitle}</legend>
        <RadioGroup
          value={current.naming}
          onValueChange={(value) => edit({ naming: value as ItemTypeNaming })}
          className="space-y-1"
        >
          {(['pbi', 'story'] as const).map((naming) => (
            <div key={naming} className="flex items-center gap-2">
              <RadioGroupItem id={`${formId}-naming-${naming}`} value={naming} />
              <label htmlFor={`${formId}-naming-${naming}`} className="text-sm">
                {copy.naming[naming]}
              </label>
            </div>
          ))}
        </RadioGroup>
      </fieldset>

      <SettingRow
        label={copy.featureLevelTitle}
        description={copy.featureLevelDescription}
        htmlFor={`${formId}-feature-level`}
      >
        <Switch
          id={`${formId}-feature-level`}
          checked={current.featureLevel}
          disabled={disabled}
          onCheckedChange={setFeatureLevel}
        />
      </SettingRow>

      <SettingsSection title={copy.typesTitle} description={copy.description}>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{copy.typeColumn}</TableHead>
                <TableHead>{copy.meaningColumn}</TableHead>
                <TableHead className="w-20 text-right">{copy.enabledColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shownTypes.map((type) => {
                const label = typeLabel(type, current.naming);
                const alwaysOn = ALWAYS_ON.includes(type);
                return (
                  <TableRow key={type}>
                    <TableCell>
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <GlyphBadge
                          glyph={itemTypeGlyph(type, current.naming)}
                          tone={ITEM_TYPE_TONES[type]}
                          label={label}
                        />
                        {label}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-normal text-sm text-muted-foreground">
                      {t.flowAgile.itemTypeDescriptions[type]}
                    </TableCell>
                    <TableCell className="text-right">
                      {alwaysOn ? (
                        <span className="text-xs text-muted-foreground">{copy.alwaysOn}</span>
                      ) : (
                        <Checkbox
                          checked={enabled.has(type)}
                          disabled={disabled || (type === 'feature' && !current.featureLevel)}
                          onCheckedChange={(checked) => toggle(type, checked === true)}
                          aria-label={label}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </SettingsSection>

      <SettingsSection title={copy.rulesTitle}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted-foreground">
          <li>{copy.rules.epicDelete}</li>
          <li>{copy.rules.subtaskSprint}</li>
          <li>{copy.rules.typeChange}</li>
        </ul>
      </SettingsSection>

      {delivery.usesItemTypes && (
        <div className="flex items-center justify-end gap-2 border-t pt-4">
          {draft && (
            <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => setDraft(null)}>
              {t.flowAgile.shared.cancel}
            </Button>
          )}
          <Button type="submit" disabled={disabled || !draft}>
            {save.isPending ? t.flowAgile.shared.saving : t.flowAgile.shared.save}
          </Button>
        </div>
      )}
    </form>
  );
}
