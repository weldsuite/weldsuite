import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { ProjectRequest } from '@weldsuite/app-api-client/domains/flow-portfolio';
import { useI18n } from '@/lib/i18n/provider';
import { useAppApi } from '@/lib/api/use-app-api';
import { useConvertProjectRequest, useCreateProjectRequest, useUpdateProjectRequest } from '@/hooks/queries/use-flow-portfolio-queries';
import { projectKeys } from '@/hooks/queries/use-projects-queries';
import { AMOUNT, amount, needsText, parseNeededSkills } from '../_lib/intake';

const DATE = /^(\d{4}-\d{2}-\d{2})?$/;
const requestSchema = z.object({
  title: z.string().trim().min(1).max(255),
  businessCase: z.string().max(10_000),
  estimatedCost: z.string().regex(AMOUNT),
  estimatedValue: z.string().regex(AMOUNT),
  desiredStart: z.string().regex(DATE),
  desiredEnd: z.string().regex(DATE),
  needs: z.string().max(1000),
});
type RequestValues = z.infer<typeof requestSchema>;

/** File a new project request, or edit one that is still new or being assessed. */
export function RequestFormDialog({ open, request, onClose, onSaved }: Readonly<{ open: boolean; request: ProjectRequest | null; onClose: () => void; onSaved: (id: string) => void }>) {
  const { t } = useI18n();
  const copy = t.flowPortfolio.intake.form;
  const create = useCreateProjectRequest();
  const update = useUpdateProjectRequest();
  const form = useForm<RequestValues>({
    resolver: zodResolver(requestSchema),
    defaultValues: { title: '', businessCase: '', estimatedCost: '', estimatedValue: '', desiredStart: '', desiredEnd: '', needs: '' },
  });
  useEffect(() => {
    if (!open) return;
    form.reset({
      title: request?.title ?? '',
      businessCase: request?.businessCase ?? '',
      estimatedCost: request?.estimatedCost ? String(Number(request.estimatedCost)) : '',
      estimatedValue: request?.estimatedValue ? String(Number(request.estimatedValue)) : '',
      desiredStart: request?.desiredStart ?? '',
      desiredEnd: request?.desiredEnd ?? '',
      needs: request ? needsText(request.neededSkills) : '',
    });
  }, [open, request, form]);
  const submit = form.handleSubmit((values) => {
    const input = {
      title: values.title,
      businessCase: values.businessCase.trim() === '' ? null : values.businessCase,
      estimatedCost: amount(values.estimatedCost),
      estimatedValue: amount(values.estimatedValue),
      desiredStart: values.desiredStart || null,
      desiredEnd: values.desiredEnd || null,
      neededSkills: parseNeededSkills(values.needs),
    };
    const done = (id: string, message: string) => {
      toast.success(message);
      onSaved(id);
      onClose();
    };
    const failed = () => toast.error(t.flowPortfolio.common.saveFailed);
    if (request) update.mutate({ id: request.id, input }, { onSuccess: () => done(request.id, copy.updated), onError: failed });
    else create.mutate(input, { onSuccess: (res) => done(res.data.id, copy.created), onError: failed });
  });
  const invalid = (name: keyof RequestValues) => (form.formState.errors[name] ? <p className="mt-1 text-xs text-destructive">{t.flowPortfolio.common.saveFailed}</p> : null);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{request ? copy.editTitle : copy.newTitle}</DialogTitle>
          <DialogDescription className="sr-only">{copy.newTitle}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div>
            <Label htmlFor="pr-title">{copy.title}</Label>
            <Input id="pr-title" className="mt-1.5" {...form.register('title')} />
            {invalid('title')}
          </div>
          <div>
            <Label htmlFor="pr-case">{copy.businessCase}</Label>
            <Textarea id="pr-case" rows={3} className="mt-1.5" {...form.register('businessCase')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="pr-cost">{copy.cost}</Label>
              <Input id="pr-cost" inputMode="decimal" className="mt-1.5" {...form.register('estimatedCost')} />
              {invalid('estimatedCost')}
            </div>
            <div>
              <Label htmlFor="pr-value">{copy.value}</Label>
              <Input id="pr-value" inputMode="decimal" className="mt-1.5" {...form.register('estimatedValue')} />
              {invalid('estimatedValue')}
            </div>
            <div>
              <Label htmlFor="pr-start">{copy.start}</Label>
              <Input id="pr-start" type="date" className="mt-1.5" {...form.register('desiredStart')} />
            </div>
            <div>
              <Label htmlFor="pr-end">{copy.end}</Label>
              <Input id="pr-end" type="date" className="mt-1.5" {...form.register('desiredEnd')} />
            </div>
          </div>
          <div>
            <Label htmlFor="pr-needs">{copy.skills}</Label>
            <Input id="pr-needs" className="mt-1.5" {...form.register('needs')} />
            <p className="mt-1 text-xs text-muted-foreground">{copy.skillsHint}</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.flowPortfolio.common.cancel}
            </Button>
            <Button type="submit" disabled={create.isPending || update.isPending}>
              {request ? t.flowPortfolio.common.save : copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const projectSchema = z.object({ name: z.string().trim().min(1).max(255), startDate: z.string().regex(DATE), endDate: z.string().regex(DATE) });
type ProjectValues = z.infer<typeof projectSchema>;

/** "Create project": makes the project with the normal create endpoint, then links it to the approved request. */
export function CreateProjectDialog({ request, onClose }: Readonly<{ request: ProjectRequest | null; onClose: () => void }>) {
  const { t, format } = useI18n();
  const copy = t.flowPortfolio.intake.createProject;
  const { projects } = useAppApi();
  const convert = useConvertProjectRequest();
  const queryClient = useQueryClient();
  // The project made for this request: a retry after a failed convert must reuse it.
  const createdRef = useRef<{ requestId: string; projectId: string } | null>(null);
  const form = useForm<ProjectValues>({ resolver: zodResolver(projectSchema), defaultValues: { name: '', startDate: '', endDate: '' } });
  useEffect(() => {
    if (request) form.reset({ name: request.title, startDate: request.desiredStart ?? '', endDate: request.desiredEnd ?? '' });
  }, [request, form]);
  const submit = form.handleSubmit(async (values) => {
    if (!request) return;
    try {
      if (createdRef.current?.requestId !== request.id) {
        const created = await projects.create({
          name: values.name,
          ...(values.startDate ? { startDate: values.startDate } : {}),
          ...(values.endDate ? { endDate: values.endDate } : {}),
        });
        createdRef.current = { requestId: request.id, projectId: created.data.id };
        void queryClient.invalidateQueries({ queryKey: projectKeys.all });
      }
      await convert.mutateAsync({ id: request.id, input: { projectId: createdRef.current.projectId } });
      createdRef.current = null;
      toast.success(copy.done);
      onClose();
    } catch {
      toast.error(t.flowPortfolio.common.saveFailed);
    }
  });
  return (
    <Dialog open={request !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{format(copy.title, { code: request?.code ?? '' })}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3" noValidate>
          <div>
            <Label htmlFor="cp-name">{copy.name}</Label>
            <Input id="cp-name" className="mt-1.5" {...form.register('name')} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cp-start">{copy.start}</Label>
              <Input id="cp-start" type="date" className="mt-1.5" {...form.register('startDate')} />
            </div>
            <div>
              <Label htmlFor="cp-end">{copy.end}</Label>
              <Input id="cp-end" type="date" className="mt-1.5" {...form.register('endDate')} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t.flowPortfolio.common.cancel}
            </Button>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
