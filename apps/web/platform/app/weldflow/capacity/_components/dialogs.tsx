import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useI18n } from '@/lib/i18n/provider';
import { useProjects } from '@/hooks/queries/use-projects-queries';
import { useCreateResourceRequest, useMemberProfile, useSaveMemberProfile } from '@/hooks/queries/use-flow-portfolio-queries';
import { splitSkills } from '../_lib/capacity';

const requestSchema = z.object({
  projectId: z.string().min(1),
  skill: z.string().trim().min(1).max(100),
  hoursPerWeek: z.coerce.number().min(0.01).max(168),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
type RequestValues = z.infer<typeof requestSchema>;

/** "Request a person": a skill, hours per week and a period for one project. */
export function RequestDialog({ open, onClose }: Readonly<{ open: boolean; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowPortfolio.capacity.requestDialog;
  const projects = useProjects({ pageSize: 100 });
  const create = useCreateResourceRequest();
  const form = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: { projectId: '', skill: '', hoursPerWeek: 16, startsOn: '', endsOn: '' },
  });
  useEffect(() => {
    if (open) form.reset();
  }, [open, form]);
  const submit = form.handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: () => {
        toast.success(copy.created);
        onClose();
      },
      onError: () => toast.error(t.flowPortfolio.common.saveFailed),
    }),
  );
  const error = (name: keyof RequestValues) =>
    form.formState.errors[name] ? <p className="mt-1 text-xs text-destructive">{form.formState.errors[name]?.message ?? ''}</p> : null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div>
            <Label htmlFor="rr-project">{copy.project}</Label>
            <Controller
              control={form.control}
              name="projectId"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="rr-project" className="mt-1.5 w-full">
                    <SelectValue placeholder={copy.projectPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {(projects.data?.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {error('projectId')}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rr-skill">{copy.skill}</Label>
              <Input id="rr-skill" className="mt-1.5" {...form.register('skill')} />
              {error('skill')}
            </div>
            <div>
              <Label htmlFor="rr-hours">{copy.hours}</Label>
              <Input id="rr-hours" type="number" step="0.5" className="mt-1.5" {...form.register('hoursPerWeek')} />
              {error('hoursPerWeek')}
            </div>
            <div>
              <Label htmlFor="rr-from">{copy.from}</Label>
              <Input id="rr-from" type="date" className="mt-1.5" {...form.register('startsOn')} />
              {error('startsOn')}
            </div>
            <div>
              <Label htmlFor="rr-to">{copy.to}</Label>
              <Input id="rr-to" type="date" className="mt-1.5" {...form.register('endsOn')} />
              {error('endsOn')}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.flowPortfolio.common.cancel}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const profileSchema = z.object({
  weeklyHours: z.coerce.number().min(0).max(168),
  skills: z.string().max(2000),
});
type ProfileValues = z.infer<typeof profileSchema>;

/** Contract hours and skills of one member. */
export function ProfileDialog({ memberId, name, onClose }: Readonly<{ memberId: string | null; name: string; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowPortfolio.capacity.profile;
  const profile = useMemberProfile(memberId);
  const save = useSaveMemberProfile();
  const form = useForm<ProfileValues>({ resolver: zodResolver(profileSchema), defaultValues: { weeklyHours: 40, skills: '' } });
  useEffect(() => {
    if (profile.data) form.reset({ weeklyHours: profile.data.weeklyHours, skills: profile.data.skills.join(', ') });
  }, [profile.data, form]);
  const submit = form.handleSubmit((values) => {
    if (!memberId) return;
    save.mutate(
      { memberId, input: { weeklyHours: values.weeklyHours, skills: splitSkills(values.skills) } },
      {
        onSuccess: () => {
          toast.success(copy.saved);
          onClose();
        },
        onError: () => toast.error(t.flowPortfolio.common.saveFailed),
      },
    );
  });
  return (
    <Dialog open={memberId !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{format(copy.title, { name })}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div>
            <Label htmlFor="pf-hours">{copy.hours}</Label>
            <Input id="pf-hours" type="number" step="0.5" className="mt-1.5" {...form.register('weeklyHours')} />
          </div>
          <div>
            <Label htmlFor="pf-skills">{copy.skills}</Label>
            <Input id="pf-skills" className="mt-1.5" {...form.register('skills')} />
            <p className="mt-1 text-xs text-muted-foreground">{t.flowPortfolio.common.skillsHint}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.flowPortfolio.common.cancel}
            </Button>
            <Button type="submit" disabled={save.isPending || profile.isLoading}>
              {t.flowPortfolio.common.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
