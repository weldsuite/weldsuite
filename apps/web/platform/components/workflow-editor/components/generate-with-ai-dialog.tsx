
/**
 * "Generate with AI" dialog for the WeldConnect workflow editor.
 *
 * Single-shot prompt → draft flow: POST /api/workflows/generate (app-api,
 * see apps/workers/app-api/src/routes/workflows/generate.ts) returns a full workflow
 * draft (trigger + steps) that is never persisted server-side. This dialog
 * only collects the prompt, shows the result's review warnings, and hands
 * the draft back to the caller via `onApply` — the editor itself decides how
 * to load it into local (unsaved) state and whether to confirm replacing an
 * existing trigger/steps first (see workflow-editor-client.tsx).
 *
 * Not offered for helpdesk workflows — those still run on the legacy worker.
 */

import { useState } from 'react';
import { Loader2, Sparkles, AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { Alert, AlertTitle, AlertDescription } from '@weldsuite/ui/components/alert';
import { useRouter } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import {
  useGenerateWorkflow,
  type GeneratedWorkflowDraft,
} from '@/hooks/queries/use-automation-queries';

const PROMPT_MAX = 2000;

type ErrorKind = 'insufficientCredits' | 'permission' | 'generic';

function classifyError(err: unknown): ErrorKind {
  const message = err instanceof Error ? err.message : '';
  if (/insufficient credits/i.test(message)) return 'insufficientCredits';
  if (/permission/i.test(message)) return 'permission';
  return 'generic';
}

interface GenerateWithAiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Passed straight through to `onApply` once the user confirms loading the draft. */
  onApply: (workflow: GeneratedWorkflowDraft, warnings: string[]) => void;
}

export function GenerateWithAiDialog({ open, onOpenChange, onApply }: GenerateWithAiDialogProps) {
  const { t } = useI18n();
  const tg = t.weldconnect.generateWithAi;
  const tbc = t.weldconnect.builderChat;
  const router = useRouter();
  const generateMutation = useGenerateWorkflow();

  const [prompt, setPrompt] = useState('');
  const [errorKind, setErrorKind] = useState<ErrorKind | null>(null);
  const [result, setResult] = useState<{ workflow: GeneratedWorkflowDraft; warnings: string[] } | null>(null);

  const examples = [tg.examples.newLead, tg.examples.urgentTicket, tg.examples.weeklyDigest];
  const canSubmit = prompt.trim().length >= 3 && prompt.length <= PROMPT_MAX && !generateMutation.isPending;

  const reset = () => {
    setPrompt('');
    setErrorKind(null);
    setResult(null);
    generateMutation.reset();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    setErrorKind(null);
    try {
      const res = await generateMutation.mutateAsync(prompt.trim());
      setResult({ workflow: res.data.workflow, warnings: res.data.warnings });
    } catch (err) {
      setErrorKind(classifyError(err));
    }
  };

  const handleLoadIntoEditor = () => {
    if (!result) return;
    onApply(result.workflow, result.warnings);
    handleOpenChange(false);
  };

  const handleTryAgain = () => {
    setResult(null);
    setErrorKind(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-violet-600" />
            {tg.dialogTitle}
          </DialogTitle>
          <DialogDescription>{tg.dialogDescription}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3">
            <Alert>
              <Sparkles className="h-4 w-4" />
              <AlertTitle>{result.workflow.name}</AlertTitle>
              {result.workflow.description && <AlertDescription>{result.workflow.description}</AlertDescription>}
            </Alert>
            {result.warnings.length > 0 && (
              <Alert className="border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950">
                <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <AlertTitle className="text-amber-800 dark:text-amber-300">{tg.warningsIntro}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc pl-4 space-y-0.5 text-amber-700 dark:text-amber-400">
                    {result.warnings.map((warning, i) => (
                      <li key={i}>{warning}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value.slice(0, PROMPT_MAX))}
                placeholder={tbc.placeholderDescribe}
                rows={5}
                disabled={generateMutation.isPending}
              />
              <div className="text-right text-xs text-muted-foreground">
                {tg.charCount.replace('{count}', String(prompt.length)).replace('{max}', String(PROMPT_MAX))}
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{tg.examplesLabel}</p>
              <div className="flex flex-wrap gap-1.5">
                {examples.map((example, i) => (
                  <Button
                    key={i}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-auto whitespace-normal py-1 text-left text-xs"
                    onClick={() => setPrompt(example)}
                    disabled={generateMutation.isPending}
                  >
                    {example}
                  </Button>
                ))}
              </div>
            </div>

            {errorKind === 'insufficientCredits' && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{tbc.errors.insufficientCredits.title}</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{tbc.errors.insufficientCredits.body}</p>
                  <Button type="button" size="sm" variant="outline" onClick={() => router.push('/settings/billing')}>
                    {tg.errors.topUpCta}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {errorKind === 'permission' && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{tg.errors.permission.title}</AlertTitle>
                <AlertDescription>{tg.errors.permission.body}</AlertDescription>
              </Alert>
            )}
            {errorKind === 'generic' && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>{tbc.errors.default.title}</AlertTitle>
                <AlertDescription className="space-y-2">
                  <p>{tbc.errors.default.body}</p>
                  <Button type="button" size="sm" variant="outline" onClick={handleSubmit}>
                    {tg.errors.retry}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <DialogFooter>
          {result ? (
            <>
              <Button type="button" variant="outline" onClick={handleTryAgain}>
                {tg.tryAgain}
              </Button>
              <Button type="button" onClick={handleLoadIntoEditor}>
                {tg.loadIntoEditor}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                {tg.cancel}
              </Button>
              <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
                {generateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {generateMutation.isPending ? tg.generating : tg.submit}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
