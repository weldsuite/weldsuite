
import { UserPlus, User, Settings, Building2, Award } from 'lucide-react';
import { EntityFormLayout, type FormSection } from '@/components/entity-overview';
import { Field, FieldLabel, FieldError } from '@weldsuite/ui/components/field';
import { Input } from '@weldsuite/ui/components/input';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useMemberForm, type Member, type User as UserType, type MemberFormValues } from '../hooks/use-member-form';

interface MemberFormProps {
  departmentId: string;
  departmentName: string;
  users: UserType[];
  member?: Member;
  mode: 'add' | 'edit';
}

export function MemberForm({ departmentId, departmentName, users, member, mode }: MemberFormProps) {
  const { t } = useI18n();
  const mf = t.helpdesk.memberForm;
  const { form, onSubmit, isSubmitting, handleUserSelect } = useMemberForm({
    departmentId,
    users,
    member,
    mode,
  });

  const { register, watch, setValue, handleSubmit, formState: { errors } } = form;

  // Watch form values
  const userId = watch('userId');
  const name = watch('name');
  const email = watch('email');
  const role = watch('role');
  const status = watch('status');
  const availability = watch('availability');

  const backHref = `/welddesk/teams/${departmentId}`;

  const sections: FormSection[] = [
    {
      title: mf.basicInformationSection,
      icon: User,
      content: (
        <div className="space-y-4">
          <div className="p-3 bg-muted rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <Building2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">{mf.departmentLabel}</span>
            </div>
            <Badge variant="secondary" className="mt-1">
              {departmentName}
            </Badge>
          </div>

          <Field data-invalid={!!errors.userId}>
            <FieldLabel>{mf.selectUserLabel}</FieldLabel>
            <Select value={userId} onValueChange={handleUserSelect}>
              <SelectTrigger className="shadow-none">
                <SelectValue placeholder={mf.selectUserPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                {users.map((user) => (
                  <SelectItem key={user.id} value={user.id}>
                    {user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email} ({user.email})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {mf.selectUserHint}
            </p>
            <FieldError errors={[errors.userId]} />
          </Field>

          {userId && (
            <>
              <Field data-invalid={!!errors.name}>
                <FieldLabel>{mf.fullNameLabel}</FieldLabel>
                <Input
                  {...register('name')}
                  disabled
                  className="shadow-none bg-muted"
                />
                <FieldError errors={[errors.name]} />
              </Field>

              <Field data-invalid={!!errors.email}>
                <FieldLabel>{mf.emailAddressLabel}</FieldLabel>
                <Input
                  {...register('email')}
                  type="email"
                  disabled
                  className="shadow-none bg-muted"
                />
                <FieldError errors={[errors.email]} />
              </Field>
            </>
          )}
        </div>
      ),
    },
    {
      title: mf.roleStatusSection,
      icon: Award,
      content: (
        <div className="space-y-4">
          <Field data-invalid={!!errors.role}>
            <FieldLabel>{mf.roleLabel}</FieldLabel>
            <Select
              value={role}
              onValueChange={(value: MemberFormValues['role']) => setValue('role', value)}
            >
              <SelectTrigger className="shadow-none">
                <SelectValue placeholder={mf.selectRolePlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="agent">{mf.agent}</SelectItem>
                <SelectItem value="senior_agent">{mf.seniorAgent}</SelectItem>
                <SelectItem value="team_lead">{mf.teamLead}</SelectItem>
                <SelectItem value="supervisor">{mf.supervisor}</SelectItem>
                <SelectItem value="admin">{mf.admin}</SelectItem>
              </SelectContent>
            </Select>
            <FieldError errors={[errors.role]} />
          </Field>

          <Field data-invalid={!!errors.status}>
            <FieldLabel>{mf.employmentStatusLabel}</FieldLabel>
            <Select
              value={status}
              onValueChange={(value: MemberFormValues['status']) => setValue('status', value)}
            >
              <SelectTrigger className="shadow-none">
                <SelectValue placeholder={mf.selectStatusPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{mf.active}</SelectItem>
                <SelectItem value="inactive">{mf.inactive}</SelectItem>
                <SelectItem value="on_leave">{mf.onLeave}</SelectItem>
                <SelectItem value="training">{mf.training}</SelectItem>
              </SelectContent>
            </Select>
            <FieldError errors={[errors.status]} />
          </Field>

          <Field data-invalid={!!errors.availability}>
            <FieldLabel>{mf.availabilityLabel}</FieldLabel>
            <Select
              value={availability}
              onValueChange={(value: MemberFormValues['availability']) => setValue('availability', value)}
            >
              <SelectTrigger className="shadow-none">
                <SelectValue placeholder={mf.selectAvailabilityPlaceholder} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="available">{mf.available}</SelectItem>
                <SelectItem value="busy">{mf.busy}</SelectItem>
                <SelectItem value="away">{mf.away}</SelectItem>
                <SelectItem value="offline">{mf.offline}</SelectItem>
              </SelectContent>
            </Select>
            <FieldError errors={[errors.availability]} />
          </Field>
        </div>
      ),
    },
    {
      title: mf.settingsSkillsSection,
      icon: Settings,
      content: (
        <div className="space-y-4">
          <Field data-invalid={!!errors.maxActiveTickets}>
            <FieldLabel>{mf.maxActiveTicketsLabel}</FieldLabel>
            <Input
              {...register('maxActiveTickets')}
              type="number"
              placeholder={mf.maxActiveTicketsPlaceholder}
              min="1"
              className="shadow-none"
            />
            <p className="text-sm text-muted-foreground">
              {mf.maxActiveTicketsHint}
            </p>
            <FieldError errors={[errors.maxActiveTickets]} />
          </Field>

          <Field data-invalid={!!errors.skills}>
            <FieldLabel>{mf.skillsLabel}</FieldLabel>
            <Input
              {...register('skills')}
              placeholder={mf.skillsPlaceholder}
              className="shadow-none"
            />
            <p className="text-sm text-muted-foreground">
              {mf.skillsHint}
            </p>
            <FieldError errors={[errors.skills]} />
          </Field>

          <Field data-invalid={!!errors.languages}>
            <FieldLabel>{mf.languagesLabel}</FieldLabel>
            <Input
              {...register('languages')}
              placeholder={mf.languagesPlaceholder}
              className="shadow-none"
            />
            <p className="text-sm text-muted-foreground">
              {mf.languagesHint}
            </p>
            <FieldError errors={[errors.languages]} />
          </Field>
        </div>
      ),
    },
  ];

  const formatLabel = (value: string) =>
    value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const summaryFields = [
    { label: mf.summaryUserLabel, value: userId ? name : mf.summaryNoUser },
    { label: mf.summaryEmailLabel, value: userId ? email : '-' },
    { label: mf.summaryRoleLabel, value: formatLabel(role) },
    { label: mf.summaryDepartmentLabel, value: departmentName },
    { label: mf.summaryStatusLabel, value: formatLabel(status) },
  ];

  return (
    <EntityFormLayout
      title={mode === 'add' ? mf.addTitle : mf.editTitle}
      subtitle={mode === 'edit' && member ? mf.editSubtitle.replace('{name}', member.name) : undefined}
      sections={sections}
      summaryTitle={mf.summaryTitle}
      summaryIcon={UserPlus}
      summaryFields={summaryFields}
      onSubmit={handleSubmit(onSubmit)}
      isPending={isSubmitting}
      submitText={mode === 'add' ? mf.addSubmit : mf.editSubmit}
      cancelLink={backHref}
      showBackButton={true}
      backLink={backHref}
      backButtonText={mf.backToTeam}
    />
  );
}
