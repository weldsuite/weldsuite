import { AlertTriangle } from 'lucide-react';
import type { DefinitionIssue } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { useI18n } from '@/lib/i18n/provider';
import { useIssueText } from './issue-text';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  issues: DefinitionIssue[];
  /** Why we are here: the engine found issues, the server refused, or there are no questions. */
  reason: 'issues' | 'no_questions';
  /** Jump to the block an issue belongs to. */
  onGoTo?: (issue: DefinitionIssue) => void;
}

/** What stops a form from being published, listed with a way to go and fix each. */
export function PublishIssuesDialog({ open, onOpenChange, issues, reason, onGoTo }: Readonly<Props>) {
  const { t } = useI18n();
  const text = useIssueText();
  const tp = t.weldforms.publish;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{reason === 'no_questions' ? tp.noQuestionsTitle : tp.issuesTitle}</DialogTitle>
          <DialogDescription>{reason === 'no_questions' ? tp.noQuestionsDescription : tp.issuesDescription}</DialogDescription>
        </DialogHeader>
        {reason === 'issues' && (
          <ScrollArea className="max-h-72">
            <ul className="space-y-2 pr-3">
              {issues.map((issue, index) => (
                <li key={`${issue.path}:${issue.code}:${index}`} className="flex items-start gap-2 rounded-md border bg-muted/30 p-2.5 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
                  <span className="min-w-0 flex-1">{text(issue)}</span>
                  {onGoTo && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        onGoTo(issue);
                        onOpenChange(false);
                      }}
                    >
                      {tp.goTo}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t.common.actions.close}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
