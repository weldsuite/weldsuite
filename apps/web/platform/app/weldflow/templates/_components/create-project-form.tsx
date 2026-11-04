import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import type { ProjectTemplateDetail } from '@weldsuite/app-api-client/schemas/project-closing';
import { useAuth } from '@/lib/auth';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useCreateProjectFromTemplate } from '@/hooks/queries/use-project-closing-queries';
import { intlLocaleOf } from '@/app/weldflow/project/[projectId]/raid/_lib/locale';
import { apiMessage } from '@/app/weldflow/project/[projectId]/close/_lib/api-error';
import { closingResolverOptions } from '@/app/weldflow/project/[projectId]/close/_lib/form';
import { useMemberDirectory } from '@/app/weldflow/project/[projectId]/close/_lib/members';
import { MemberSelect } from '@/app/weldflow/project/[projectId]/close/_components/member-select';
import {
  COPY_KEYS,
  buildInstantiateBody,
  copyCounts,
  createProjectFormSchema,
  defaultCopy,
  defaultRoles,
  defaultStartDate,
  endDateOf,
  workingDaysOf,
  type CreateProjectFormValues,
} from '../_lib/template';
import { CompanyPicker } from './company-picker';

/** The Create project form: name, client, start (with the end it leads to), roles and what to copy. */
export function CreateProjectForm({ template, canCreate }: Readonly<{ template: ProjectTemplateDetail | null; canCreate: boolean }>) {
  const { t, language, format } = useI18n();
  const copy = t.flowClosing.templates.form;
  const router = useRouter();
  const { userId } = useAuth();
  const { members, isLoading: membersLoading } = useMemberDirectory();
  const create = useCreateProjectFromTemplate();
  const [formError, setFormError] = useState<string | null>(null);
  const blueprint = template?.blueprint ?? null;
  const locale = intlLocaleOf(language);
  const options = useMemo(() => closingResolverOptions(t.flowClosing.shared.validation, format), [t, format]);

  const form = useForm<CreateProjectFormValues>({
    resolver: zodResolver(createProjectFormSchema, options),
    defaultValues: {
      name: '',
      client: null,
      startDate: defaultStartDate(new Date(), blueprint ? workingDaysOf(blueprint) : undefined),
      roles: blueprint ? defaultRoles(blueprint, userId ?? null) : {},
      copy: defaultCopy(),
    },
  });

  // A different template brings its own roles and calendar; what the person typed (name, client) stays.
  const templateId = template?.id ?? null;
  const lastTemplate = useRef(templateId);
  useEffect(() => {
    if (!blueprint || lastTemplate.current === templateId) return;
    lastTemplate.current = templateId;
    form.setValue('roles', defaultRoles(blueprint, userId ?? null));
    form.setValue('copy', defaultCopy());
    if (!form.getFieldState('startDate').isDirty) form.setValue('startDate', defaultStartDate(new Date(), workingDaysOf(blueprint)));
    setFormError(null);
  }, [templateId, blueprint, userId, form]);

  // The first template that loads fills the roles (the form was built before it arrived).
  useEffect(() => {
    if (blueprint && Object.keys(form.getValues('roles')).length === 0) {
      form.setValue('roles', defaultRoles(blueprint, userId ?? null));
    }
  }, [blueprint, userId, form]);

  const start = form.watch('startDate');
  const end = blueprint ? endDateOf(start, blueprint) : null;
  const counts = blueprint ? copyCounts(blueprint) : null;

  const submit = async (values: CreateProjectFormValues) => {
    if (!template) return;
    setFormError(null);
    const body = buildInstantiateBody(values);
    if (!body) {
      setFormError(copy.failed);
      return;
    }
    try {
      const res = await create.mutateAsync({ id: template.id, data: body });
      toast.success(format(copy.created, { name: res.data.project.name }));
      router.push(`/weldflow/project/${res.data.project.id}`);
    } catch (error) {
      const message = apiMessage(error, copy.failed);
      setFormError(message);
      toast.error(message);
    }
  };

  if (!canCreate) {
    return (
      <section aria-labelledby="create-project-title" className="rounded-xl border bg-card p-4">
        <h2 id="create-project-title" className="text-[15px] font-semibold">{copy.title}</h2>
        <p className="mt-2 text-sm text-muted-foreground">{copy.noAccess}</p>
      </section>
    );
  }

  return (
    <Form {...form}>
      <form
        noValidate
        aria-labelledby="create-project-title"
        onSubmit={form.handleSubmit(submit)}
        className="flex flex-col gap-3.5 rounded-xl border bg-card p-4"
      >
        <h2 id="create-project-title" className="text-[15px] font-semibold">{copy.title}</h2>
        {template ? null : <p className="text-sm text-muted-foreground">{copy.selectFirst}</p>}

        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{copy.name}</FormLabel>
              <FormControl>
                <Input {...field} placeholder={copy.namePlaceholder} disabled={!template} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="client"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                {copy.client} <span className="text-xs font-normal text-muted-foreground">{copy.clientHint}</span>
              </FormLabel>
              <FormControl>
                <CompanyPicker value={field.value} onChange={field.onChange} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-2.5">
          <FormField
            control={form.control}
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{copy.start}</FormLabel>
                <FormControl>
                  <Input {...field} type="date" disabled={!template} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <div className="flex flex-col gap-2">
            <span className="text-sm leading-none font-medium">{copy.end}</span>
            <output
              aria-label={copy.end}
              className="flex h-9 items-center rounded-md bg-muted/50 px-3 text-sm"
            >
              {end ? new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(end) : '—'}
            </output>
          </div>
        </div>
        <p className="-mt-1.5 text-xs text-muted-foreground">{copy.datesHint}</p>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] font-semibold">{copy.roles.title}</legend>
          {blueprint && blueprint.roles.length === 0 ? <p className="text-xs text-muted-foreground">{copy.roles.none}</p> : null}
          {blueprint?.roles.map((role) => (
            <FormField
              key={role.key}
              control={form.control}
              name={`roles.${role.key}`}
              render={({ field }) => (
                <FormItem className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-2.5 space-y-0">
                  <FormLabel className="font-normal text-foreground/80">{role.label}</FormLabel>
                  <FormControl>
                    <MemberSelect
                      members={members}
                      value={field.value ?? null}
                      onChange={field.onChange}
                      noneLabel={t.flowClosing.shared.noOne}
                      placeholder={membersLoading ? '…' : t.flowClosing.shared.choosePerson}
                    />
                  </FormControl>
                </FormItem>
              )}
            />
          ))}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-[13px] font-semibold">{copy.copy.title}</legend>
          {COPY_KEYS.map((key) => (
            <FormField
              key={key}
              control={form.control}
              name={`copy.${key}`}
              render={({ field }) => (
                <FormItem className="flex flex-row items-center gap-2.5 space-y-0">
                  <FormControl>
                    <Checkbox checked={field.value === true} onCheckedChange={(checked) => field.onChange(checked === true)} />
                  </FormControl>
                  <FormLabel className="font-normal text-foreground/80">
                    {copy.copy[key]}
                    {counts?.[key] !== undefined ? <span className="ml-1.5 text-xs text-muted-foreground">({counts[key]})</span> : null}
                  </FormLabel>
                </FormItem>
              )}
            />
          ))}
        </fieldset>

        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}

        <div className="flex justify-end border-t pt-3">
          <Button type="submit" disabled={!template || create.isPending}>
            {create.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {create.isPending ? copy.submitting : copy.submit}
          </Button>
        </div>
      </form>
    </Form>
  );
}
