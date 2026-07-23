
import { useState } from 'react';
import { Building2, Settings, CheckCircle2, Clock } from 'lucide-react';
import { EntityFormLayout, type FormSection } from '@/components/entity-overview';
import { Field, FieldLabel, FieldError } from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useDepartmentForm, type Department, type DepartmentFormValues } from '../hooks/use-department-form';
import { DayScheduleRow } from './day-schedule-row';

interface DepartmentFormProps {
  department?: Department;
  mode: 'add' | 'edit';
}

export function DepartmentForm({ department, mode }: DepartmentFormProps) {
  const { t } = useI18n();
  const df = t.helpdesk.departmentForm;
  const { form, onSubmit, isPending } = useDepartmentForm({ department, mode });

  // Calculate back link
  const backHref = mode === 'edit' && department
    ? `/welddesk/teams/${department.id}`
    : '/welddesk/teams';

  // Get form values for controlled inputs
  const { register, watch, setValue, handleSubmit, formState: { errors } } = form;

  const name = watch('name');
  const autoAssignment = watch('autoAssignment');
  const roundRobinAssignment = watch('roundRobinAssignment');
  const defaultPriority = watch('defaultPriority');
  const isActive = watch('isActive');
  const replyTime = watch('replyTime');
  const businessHours = watch('businessHours');
  const [enableBusinessHours, setEnableBusinessHours] = useState(!!businessHours);

  const defaultDayHours = { isOpen: true, openTime: '09:00', closeTime: '17:00' };
  const defaultClosedDay = { isOpen: false, openTime: '09:00', closeTime: '17:00' };

  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
  const dayLabels: Record<string, string> = {
    monday: df.monday,
    tuesday: df.tuesday,
    wednesday: df.wednesday,
    thursday: df.thursday,
    friday: df.friday,
    saturday: df.saturday,
    sunday: df.sunday,
  };

  const timezones = (() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return ['UTC', 'Europe/Amsterdam', 'Europe/London', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles'];
    }
  })();

  const handleEnableBusinessHours = (enabled: boolean) => {
    setEnableBusinessHours(enabled);
    if (enabled && !businessHours) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setValue('businessHours', {
        timezone: tz,
        monday: { ...defaultDayHours },
        tuesday: { ...defaultDayHours },
        wednesday: { ...defaultDayHours },
        thursday: { ...defaultDayHours },
        friday: { ...defaultDayHours },
        saturday: { ...defaultClosedDay },
        sunday: { ...defaultClosedDay },
      });
    } else if (!enabled) {
      setValue('businessHours', undefined);
    }
  };

  const sections: FormSection[] = [
    {
      title: df.basicInformationSection,
      icon: Building2,
      content: (
        <div className="space-y-4">
          <Field data-invalid={!!errors.name}>
            <FieldLabel>{df.departmentNameLabel}</FieldLabel>
            <Input
              {...register('name')}
              placeholder={df.departmentNamePlaceholder}
              className="shadow-none"
            />
            <FieldError errors={[errors.name]} />
          </Field>

          <Field data-invalid={!!errors.description}>
            <FieldLabel>{t.helpdesk.teams.description}</FieldLabel>
            <Textarea
              {...register('description')}
              placeholder={df.descriptionPlaceholder}
              rows={4}
              className="shadow-none"
            />
            <FieldError errors={[errors.description]} />
          </Field>

          <Field data-invalid={!!errors.email}>
            <FieldLabel>{df.departmentEmailLabel}</FieldLabel>
            <Input
              {...register('email')}
              type="email"
              placeholder={df.emailPlaceholder}
              className="shadow-none"
            />
            <FieldError errors={[errors.email]} />
          </Field>
        </div>
      ),
    },
    {
      title: df.assignmentSettingsSection,
      icon: Settings,
      content: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="autoAssignment">{df.autoAssignmentLabel}</Label>
              <p className="text-sm text-muted-foreground">
                {df.autoAssignmentDesc}
              </p>
            </div>
            <Switch
              id="autoAssignment"
              checked={autoAssignment}
              onCheckedChange={(checked) => setValue('autoAssignment', checked)}
            />
          </div>
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="roundRobinAssignment">{df.roundRobinLabel}</Label>
              <p className="text-sm text-muted-foreground">
                {df.roundRobinDesc}
              </p>
            </div>
            <Switch
              id="roundRobinAssignment"
              checked={roundRobinAssignment}
              onCheckedChange={(checked) => setValue('roundRobinAssignment', checked)}
              disabled={!autoAssignment}
            />
          </div>
          <Field>
            <FieldLabel>{df.defaultPriorityLabel}</FieldLabel>
            <Select
              value={defaultPriority}
              onValueChange={(value: DepartmentFormValues['defaultPriority']) => setValue('defaultPriority', value)}
            >
              <SelectTrigger className="shadow-none">
                <SelectValue placeholder={df.selectPriorityPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{df.low}</SelectItem>
                <SelectItem value="medium">{df.medium}</SelectItem>
                <SelectItem value="high">{df.high}</SelectItem>
                <SelectItem value="urgent">{df.urgent}</SelectItem>
                <SelectItem value="critical">{df.critical}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      ),
    },
    {
      title: df.officeHoursSection,
      icon: Clock,
      content: (
        <div className="space-y-4">
          <Field>
            <FieldLabel>{df.expectedReplyTimeLabel}</FieldLabel>
            <Select
              value={replyTime || ''}
              onValueChange={(value: 'few_minutes' | 'few_hours' | 'a_day') => setValue('replyTime', value)}
            >
              <SelectTrigger className="shadow-none">
                <SelectValue placeholder={df.selectReplyTimePlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="few_minutes">{df.fewMinutes}</SelectItem>
                <SelectItem value="few_hours">{df.fewHours}</SelectItem>
                <SelectItem value="a_day">{df.aDay}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">
              {df.replyTimeHint}
            </p>
          </Field>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="enableBusinessHours">{df.businessHoursLabel}</Label>
              <p className="text-sm text-muted-foreground">
                {df.businessHoursDesc}
              </p>
            </div>
            <Switch
              id="enableBusinessHours"
              checked={enableBusinessHours}
              onCheckedChange={handleEnableBusinessHours}
            />
          </div>

          {enableBusinessHours && businessHours && (
            <div className="space-y-3 pt-2">
              <Field>
                <FieldLabel>{df.timezoneLabel}</FieldLabel>
                <Select
                  value={businessHours.timezone}
                  onValueChange={(value) => setValue('businessHours.timezone', value)}
                >
                  <SelectTrigger className="shadow-none">
                    <SelectValue placeholder={df.selectTimezonePlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {timezones.map((tz) => (
                      <SelectItem key={tz} value={tz}>{tz.replace(/_/g, ' ')}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <div className="space-y-1">
                {days.map((day) => (
                  <DayScheduleRow
                    key={day}
                    day={day}
                    label={dayLabels[day]}
                    isOpen={businessHours[day]?.isOpen ?? false}
                    openTime={businessHours[day]?.openTime}
                    closeTime={businessHours[day]?.closeTime}
                    onToggle={(isOpen) =>
                      setValue(`businessHours.${day}`, {
                        isOpen,
                        openTime: businessHours[day]?.openTime || '09:00',
                        closeTime: businessHours[day]?.closeTime || '17:00',
                      })
                    }
                    onOpenTimeChange={(time) =>
                      setValue(`businessHours.${day}.openTime`, time)
                    }
                    onCloseTimeChange={(time) =>
                      setValue(`businessHours.${day}.closeTime`, time)
                    }
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      title: df.statusSection,
      icon: CheckCircle2,
      content: (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="isActive">{df.activeDepartmentLabel}</Label>
              <p className="text-sm text-muted-foreground">
                {df.activeDepartmentDesc}
              </p>
            </div>
            <Switch
              id="isActive"
              checked={isActive}
              onCheckedChange={(checked) => setValue('isActive', checked)}
            />
          </div>
        </div>
      ),
    },
  ];

  const replyTimeLabels: Record<string, string> = {
    few_minutes: df.fewMinutes,
    few_hours: df.fewHours,
    a_day: df.aDay,
  };

  const summaryFields = [
    { label: df.summaryNameLabel, value: name || df.untitledDepartment },
    { label: df.summaryStatusLabel, value: isActive ? df.summaryStatusActive : df.summaryStatusInactive },
    { label: df.summaryAutoAssignmentLabel, value: autoAssignment ? df.summaryAutoAssignmentEnabled : df.summaryAutoAssignmentDisabled },
    { label: df.summaryDefaultPriorityLabel, value: defaultPriority.charAt(0).toUpperCase() + defaultPriority.slice(1) },
    { label: df.summaryReplyTimeLabel, value: replyTime ? replyTimeLabels[replyTime] : df.summaryReplyTimeNotSet },
    { label: df.summaryBusinessHoursLabel, value: enableBusinessHours ? df.summaryBusinessHoursConfigured : df.summaryBusinessHoursNotSet },
  ];

  return (
    <EntityFormLayout
      title={mode === 'add' ? df.createTitle : df.editTitle}
      subtitle={mode === 'edit' ? df.editSubtitle.replace('{name}', department?.name || '') : undefined}
      sections={sections}
      summaryTitle={df.summaryTitle}
      summaryIcon={Building2}
      summaryFields={summaryFields}
      onSubmit={handleSubmit(onSubmit)}
      isPending={isPending}
      submitText={mode === 'add' ? df.createSubmit : df.editSubmit}
      cancelLink={backHref}
      showBackButton={true}
      backLink={backHref}
      backButtonText={df.backToTeams}
    />
  );
}
