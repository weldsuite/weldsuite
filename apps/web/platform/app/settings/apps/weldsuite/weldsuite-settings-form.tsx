import * as React from 'react';
import { toast } from 'sonner';
import { Trash2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useUserPreferences, useUpdateUserPreferences } from '@/hooks/queries/use-settings-queries';
import { PageLoader } from '@/components/page-loader';
import { AppIcon } from '@/components/app-icon';
import { HOME_WIDGETS, WIDGETS_BY_MODULE, emptySlots, isWidgetEnabled, type NullableSlot } from '@/lib/home-widgets/registry';
import { WIDGET_MODULES, type HomeWidgetSlot, type WidgetId, type WidgetModule } from '@/lib/home-widgets/types';

function readSlotsFrom(prefs: ReturnType<typeof useUserPreferences>['data']): [NullableSlot, NullableSlot] {
  const persisted = prefs?.uiPreferences?.homeWidgets?.slots;
  if (!persisted) return emptySlots();
  return persisted.map((slot) => {
    if (!slot) return null;
    const def = HOME_WIDGETS[slot.widgetId as WidgetId];
    if (!def) return null;
    const parsed = def.schema.safeParse(slot.settings);
    return {
      widgetId: slot.widgetId as WidgetId,
      settings: parsed.success ? parsed.data : def.defaultSettings,
    } as HomeWidgetSlot;
  }) as [NullableSlot, NullableSlot];
}

function SlotEditor({
  slotIndex,
  value,
  onChange,
}: {
  slotIndex: 0 | 1;
  value: NullableSlot;
  onChange: (next: NullableSlot) => void;
}) {
  const { t } = useI18n();
  const tH = t.weldsuiteHome;

  const handlePickWidget = (id: string) => {
    if (id === '__clear__') {
      onChange(null);
      return;
    }
    const widgetId = id as WidgetId;
    const newDef = HOME_WIDGETS[widgetId];
    if (!newDef || !isWidgetEnabled(widgetId)) return;
    onChange({ widgetId, settings: newDef.defaultSettings });
  };

  const def = value ? HOME_WIDGETS[value.widgetId] : null;
  const SettingsForm = def?.SettingsForm;
  const Preview = def?.HomeRender;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">{slotIndex === 0 ? tH.settingsPage.slot1 : tH.settingsPage.slot2}</CardTitle>
        {value && (
          <Button variant="ghost" size="sm" onClick={() => onChange(null)} className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-950/40">
            <Trash2 className="h-3.5 w-3.5" />
            {tH.settingsPage.delete}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <Label className="mb-2 block">{tH.settingsPage.pickWidget}</Label>
          <Select value={value?.widgetId ?? ''} onValueChange={handlePickWidget}>
            <SelectTrigger>
              <SelectValue placeholder={tH.settingsPage.pickAWidget} />
            </SelectTrigger>
            <SelectContent>
              {WIDGET_MODULES.map((m: WidgetModule) => {
                const widgets = WIDGETS_BY_MODULE[m];
                if (widgets.length === 0) return null;
                return (
                  <SelectGroup key={m}>
                    <SelectLabel>{tH.groups[m]}</SelectLabel>
                    {widgets.map((w) => {
                      const label = tH.widgets[w.id].title;
                      const disabled = !!w.disabled;
                      return (
                        <SelectItem key={w.id} value={w.id} disabled={disabled}>
                          <span className="flex items-center gap-2">
                            <AppIcon icon={w.module} className="h-4 w-4 shrink-0" />
                            <span>{label}{disabled ? ` · ${tH.settingsPage.comingSoon}` : ''}</span>
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectGroup>
                );
              })}
            </SelectContent>
          </Select>
          {value && (
            <p className="mt-1.5 text-xs text-muted-foreground">{tH.widgets[value.widgetId].description}</p>
          )}
        </div>

        {value && SettingsForm && Preview ? (
          <>
            <div>
              <Label className="mb-2 block">{tH.settingsPage.preview}</Label>
              <SettingsForm
                value={value.settings as never}
                onChange={(next: unknown) => onChange({ widgetId: value.widgetId, settings: next as Record<string, unknown> })}
              />
            </div>
            <div>
              <Preview settings={value.settings as never} />
            </div>
          </>
        ) : (
          <div className="rounded-md border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            {tH.settingsPage.pickAWidget}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function WeldsuiteSettingsForm() {
  const { t } = useI18n();
  const tH = t.weldsuiteHome;
  const prefsQuery = useUserPreferences();
  const update = useUpdateUserPreferences();

  const initial = React.useMemo(() => readSlotsFrom(prefsQuery.data), [prefsQuery.data]);
  const [slots, setSlots] = React.useState<[NullableSlot, NullableSlot]>(initial);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (!dirty) setSlots(initial);
  }, [initial, dirty]);

  if (prefsQuery.isLoading) return <PageLoader fullScreen={false} />;

  const setSlot = (i: 0 | 1) => (next: NullableSlot) => {
    setSlots((prev) => {
      const copy = [...prev] as [NullableSlot, NullableSlot];
      copy[i] = next;
      return copy;
    });
    setDirty(true);
  };

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        uiPreferences: {
          homeWidgets: { slots },
        },
      });
      toast.success(tH.settingsPage.saved);
      setDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : tH.settingsPage.saveError);
    }
  };

  const handleCancel = () => {
    setSlots(initial);
    setDirty(false);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tH.settingsPage.title}</h1>
        <p className="text-muted-foreground">{tH.settingsPage.description}</p>
      </div>

      <div className="space-y-4">
        <SlotEditor slotIndex={0} value={slots[0]} onChange={setSlot(0)} />
        <SlotEditor slotIndex={1} value={slots[1]} onChange={setSlot(1)} />
      </div>

      <div className="sticky bottom-0 -mx-4 flex items-center justify-end gap-2 border-t bg-background/80 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        {dirty && <span className="mr-auto text-xs text-muted-foreground">{tH.settingsPage.unsavedChanges}</span>}
        <Button variant="ghost" onClick={handleCancel} disabled={!dirty || update.isPending}>{tH.settingsPage.cancel}</Button>
        <Button onClick={handleSave} disabled={!dirty || update.isPending}>{tH.settingsPage.save}</Button>
      </div>
    </div>
  );
}
