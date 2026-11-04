/**
 * The dialog that edits the scope: the statement, what is in scope (one item
 * per line) and what is out, each with a reason and, optionally, the decision it
 * relates to.
 */

import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@weldsuite/ui/components/button';
import { Form } from '@weldsuite/ui/components/form';
import { Input } from '@weldsuite/ui/components/input';
import type { Decision, Scope } from '@weldsuite/app-api-client/domains/project-governance';
import { useI18n } from '@/lib/i18n/provider';
import { usePutScope } from '@/hooks/queries/use-project-governance-queries';
import { SelectField, TextAreaField } from '../../raid/_components/form-fields';
import { FormDialog } from '../../governance/_components/parts';

const NONE = '__none__';

interface Values {
  statement: string;
  inScope: string;
  outOfScope: Array<{ text: string; reason: string; link: string }>;
}

const schema = z.object({
  statement: z.string().max(10_000),
  inScope: z.string(),
  outOfScope: z.array(z.object({ text: z.string().max(1_000), reason: z.string().max(1_000), link: z.string() })),
});

export function ScopeDialog({
  projectId,
  scope,
  decisions,
  onClose,
}: Readonly<{ projectId: string; scope: Scope; decisions: Decision[]; onClose: () => void }>) {
  const { t } = useI18n();
  const copy = t.flowGovernance.scope.statement;
  const save = usePutScope(projectId);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: {
      statement: scope.statement ?? '',
      inScope: scope.inScope.join('\n'),
      outOfScope: scope.outOfScope.map((item) => ({
        text: item.text,
        reason: item.reason ?? '',
        link: item.linkType && item.linkId ? `${item.linkType}:${item.linkId}` : NONE,
      })),
    },
  });
  const out = useFieldArray({ control: form.control, name: 'outOfScope' });

  // Links the scope already holds stay choosable even when they are not decisions of the list.
  const linkOptions = [
    { value: NONE, label: copy.outLinkNone },
    ...decisions.map((d) => ({ value: `decision:${d.id}`, label: `${d.code} · ${d.title}` })),
    ...scope.outOfScope
      .filter((item) => item.linkType && item.linkType !== 'decision' && item.linkId)
      .map((item) => ({
        value: `${item.linkType}:${item.linkId}`,
        label: [item.link?.code, item.link?.title].filter(Boolean).join(' · ') || `${item.linkType}:${item.linkId}`,
      })),
  ];

  const submit = form.handleSubmit(async (values) => {
    try {
      await save.mutateAsync({
        statement: values.statement.trim() || null,
        inScope: values.inScope
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        outOfScope: values.outOfScope
          .filter((item) => item.text.trim())
          .map((item) => {
            const [linkType, ...rest] = item.link === NONE ? [] : item.link.split(':');
            return {
              text: item.text.trim(),
              reason: item.reason.trim() || null,
              ...(linkType ? { linkType: linkType as 'decision' | 'change_request' | 'project', linkId: rest.join(':') } : {}),
            };
          }),
      });
      toast.success(copy.saved);
      onClose();
    } catch {
      toast.error(t.flowGovernance.common.saveFailed);
    }
  });

  return (
    <FormDialog
      open
      wide
      onClose={onClose}
      title={copy.editTitle}
      description={copy.editDescription}
      submitLabel={t.flowGovernance.common.save}
      pending={save.isPending}
      onSubmit={() => void submit()}
    >
      <Form {...form}>
        <TextAreaField control={form.control} name="statement" label={copy.statement} placeholder={copy.statementPlaceholder} rows={4} />
        <TextAreaField control={form.control} name="inScope" label={copy.inScope} description={copy.inScopeHelp} rows={5} />
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{copy.outOfScope}</legend>
          {out.fields.map((field, index) => (
            <div key={field.id} className="flex items-start gap-2">
              <div className="grid flex-1 gap-2 sm:grid-cols-3">
                <Input aria-label={`${copy.outText} ${index + 1}`} placeholder={copy.outText} {...form.register(`outOfScope.${index}.text`)} />
                <Input aria-label={`${copy.outReason} ${index + 1}`} placeholder={copy.outReason} {...form.register(`outOfScope.${index}.reason`)} />
                <SelectField control={form.control} name={`outOfScope.${index}.link`} label={copy.outLink} options={linkOptions} />
              </div>
              <Button type="button" variant="ghost" size="icon" aria-label={copy.removeOut} className="mt-5" onClick={() => out.remove(index)}>
                <Trash2 aria-hidden />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => out.append({ text: '', reason: '', link: NONE })}>
            <Plus aria-hidden />
            {copy.addOut}
          </Button>
        </fieldset>
      </Form>
    </FormDialog>
  );
}
