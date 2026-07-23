import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Label } from '@weldsuite/ui/components/label';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import {
  useSocialSettings,
  useUpdateSocialSettings,
  useSocialTimezones,
} from '@/hooks/queries/use-social-queries';

const settingsSchema = z.object({
  defaultTimezone: z.string().optional(),
  defaultApprovalRequired: z.boolean().optional(),
  autoScheduleEnabled: z.boolean().optional(),
  hashtagSuggestions: z.boolean().optional(),
  linkShortening: z.boolean().optional(),
});

type SettingsForm = z.infer<typeof settingsSchema>;

export function SettingsClient() {
  const { t } = useI18n();
  const st = useTranslations();
  const { data: settingsData, isLoading } = useSocialSettings();
  const { data: timezonesData } = useSocialTimezones();
  const updateSettings = useUpdateSocialSettings();

  const settings = (settingsData as any)?.data;
  const timezones = (timezonesData as any)?.data || [];

  const { handleSubmit, setValue, watch, reset } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      defaultTimezone: '',
      defaultApprovalRequired: false,
      autoScheduleEnabled: false,
      hashtagSuggestions: false,
      linkShortening: false,
    },
  });

  useEffect(() => {
    if (settings) {
      reset({
        defaultTimezone: settings.defaultTimezone || '',
        defaultApprovalRequired: settings.defaultApprovalRequired ?? false,
        autoScheduleEnabled: settings.autoScheduleEnabled ?? false,
        hashtagSuggestions: settings.hashtagSuggestions ?? false,
        linkShortening: settings.linkShortening ?? false,
      });
    }
  }, [settings, reset]);

  const onSubmit = async (data: SettingsForm) => {
    try {
      await updateSettings.mutateAsync(data as Record<string, unknown>);
      toast.success(t.social.actions.save);
    } catch {
      // ignore
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const tz = watch('defaultTimezone');

  return (
    <div className="p-6 max-w-lg space-y-6">
      <h1 className="text-2xl font-semibold">{t.social.settings.title}</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.social.settings.general}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Default timezone */}
            <div className="space-y-1.5">
              <Label>{t.social.settings.defaultTimezone}</Label>
              <Select value={tz || ''} onValueChange={(v) => setValue('defaultTimezone', v)}>
                <SelectTrigger>
                  <SelectValue placeholder={st('sweep.miscA.socialSettings.selectTimezone')} />
                </SelectTrigger>
                <SelectContent>
                  {timezones.map((tz: string) => (
                    <SelectItem key={tz} value={tz}>
                      {tz}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Checkboxes */}
            {[
              { field: 'defaultApprovalRequired' as const, label: t.social.settings.requireApproval },
              { field: 'autoScheduleEnabled' as const, label: t.social.settings.autoPublish },
              { field: 'hashtagSuggestions' as const, label: st('sweep.miscA.socialSettings.hashtagSuggestions') },
              { field: 'linkShortening' as const, label: st('sweep.miscA.socialSettings.linkShortening') },
            ].map(({ field, label }) => (
              <div key={field} className="flex items-center gap-2">
                <Checkbox
                  id={field}
                  checked={watch(field) ?? false}
                  onCheckedChange={(v) => setValue(field, Boolean(v))}
                />
                <Label htmlFor={field}>{label}</Label>
              </div>
            ))}
          </CardContent>
        </Card>

        <Button type="submit" disabled={updateSettings.isPending}>
          {updateSettings.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {t.social.actions.save}
        </Button>
      </form>
    </div>
  );
}
