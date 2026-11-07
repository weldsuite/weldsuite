import { useState } from 'react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { RaciLetter, RaciSubject, Stakeholder } from '@weldsuite/app-api-client/domains/project-reporting';
import { useI18n } from '@/lib/i18n/provider';
import { usePutRaci, useRaci } from '@/hooks/queries/use-project-reporting-queries';
import { EditorDialog } from './editor-dialog';
import { RACI_CELL_LETTERS, assignmentsAfter, raciSubjectTitle, stakeholderName } from './stakeholder-model';

/** Radix selects cannot hold an empty string, so "no letter" is this value. */
const NO_LETTER = '__none__';

interface RaciDialogProps {
  projectId: string;
  open: boolean;
  /** Every stakeholder of the project: the columns of the matrix. */
  stakeholders: readonly Stakeholder[];
  /** Whether the member may change the matrix; otherwise it is only shown. */
  canEdit: boolean;
  onClose: () => void;
}

/** Who is responsible, accountable, consulted and informed, per deliverable and decision. */
export function RaciDialog({ open, ...props }: Readonly<RaciDialogProps>) {
  return open ? <RaciEditor {...props} /> : null;
}

function RaciEditor({ projectId, stakeholders, canEdit, onClose }: Readonly<Omit<RaciDialogProps, 'open'>>) {
  const { t } = useI18n();
  const copy = t.flowReporting.stakeholders.raci;
  const query = useRaci(projectId);
  const put = usePutRaci();
  const [message, setMessage] = useState<string | null>(null);

  const subjectTitle = (subject: RaciSubject) => raciSubjectTitle(subject, copy);

  // One letter per cell; the API takes the whole row of a subject.
  const setCell = (subject: RaciSubject, stakeholderId: string, letter: RaciLetter | '') => {
    put.mutate(
      { projectId, input: { subjectType: subject.subjectType, subjectId: subject.subjectId, assignments: assignmentsAfter(subject, stakeholderId, letter) } },
      { onSuccess: () => setMessage(letter === 'A' ? copy.oneA : copy.saved), onError: () => setMessage(t.flowReporting.stakeholders.saveFailed) },
    );
  };

  let body;
  if (query.isLoading) body = <InlineSpinner />;
  else if (query.isError && !query.data) body = <ErrorState onRetry={() => void query.refetch()} />;
  else if (stakeholders.length === 0) body = <p className="py-6 text-center text-sm text-muted-foreground">{copy.empty}</p>;
  else {
    body = (
      <div className="-mx-6 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="h-[35px] border-b border-border text-xs font-medium text-muted-foreground">
              <th scope="col" className="px-6 text-left font-medium">
                {copy.subject}
              </th>
              {stakeholders.map((row) => (
                <th key={row.id} scope="col" title={stakeholderName(row)} className="px-1 text-center font-medium">
                  <span className="mx-auto block max-w-[5rem] truncate">{stakeholderName(row).split(' ')[0]}</span>
                </th>
              ))}
              <th aria-hidden className="w-5 p-0" />
            </tr>
          </thead>
          <tbody>
            {(query.data?.subjects ?? []).map((subject) => (
              <tr key={`${subject.subjectType}-${subject.subjectId ?? ''}`} className="h-12 border-b border-gray-200/70 dark:border-border">
                <th scope="row" className="px-6 text-left font-medium text-gray-900 dark:text-foreground">
                  {subjectTitle(subject)}
                </th>
                {stakeholders.map((row) => {
                  const letter = subject.assignments.find((assignment) => assignment.stakeholderId === row.id)?.letter ?? '';
                  return (
                    <td key={row.id} className="px-1 text-center">
                      <Select
                        value={letter || NO_LETTER}
                        disabled={!canEdit || put.isPending}
                        onValueChange={(value) => setCell(subject, row.id, value === NO_LETTER ? '' : (value as RaciLetter))}
                      >
                        <SelectTrigger size="sm" aria-label={`${subjectTitle(subject)}: ${stakeholderName(row)}`} className="mx-auto w-14 justify-center gap-1 px-2 text-xs font-semibold">
                          <SelectValue>{letter || '—'}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {RACI_CELL_LETTERS.map((value) => (
                            <SelectItem key={value || NO_LETTER} value={value || NO_LETTER}>
                              {value ? `${value} · ${copy.letters[value]}` : '—'}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  );
                })}
                <td aria-hidden className="w-5 p-0" />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <EditorDialog
      title={copy.title}
      description={copy.legend}
      size="xl"
      onClose={onClose}
      footer={
        <>
          <p role="status" className="mr-auto text-xs text-muted-foreground">
            {message}
          </p>
          <Button type="button" variant="outline" onClick={onClose}>
            {t.flowGovernance.common.close}
          </Button>
        </>
      }
    >
      {body}
    </EditorDialog>
  );
}
