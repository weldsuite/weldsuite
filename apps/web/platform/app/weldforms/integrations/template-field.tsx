import { useMemo, useRef } from 'react';
import { Braces } from 'lucide-react';
import type { FormDefinition } from '@weldsuite/forms-engine';
import { Button } from '@weldsuite/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Textarea } from '@weldsuite/ui/components/textarea';
import { useI18n } from '@/lib/i18n/provider';
import { definitionTokens, extraTokens, insertAtSelection, wrapToken } from './tokens';

/**
 * A recall template (subject, body, title, description) with an "Insert" menu
 * that puts `{{form:title}}`, a question's answer or a hidden field in at the
 * caret.
 */
export function TemplateField({
  id,
  label,
  hint,
  value,
  onChange,
  definition,
  multiline = false,
}: Readonly<{
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  definition: Pick<FormDefinition, 'blocks' | 'hidden'>;
  multiline?: boolean;
}>) {
  const { t } = useI18n();
  const ti = t.weldformsResults.integrations;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const tokens = useMemo(() => definitionTokens(definition), [definition]);
  const extraLabels: Record<string, string> = {
    'form:title': ti.tokenMenu.formTitle,
    'response:number': ti.tokenMenu.responseNumber,
    'response:url': ti.tokenMenu.responseUrl,
  };

  function insert(token: string) {
    const el = inputRef.current;
    const next = insertAtSelection(value, token, el?.selectionStart ?? null, el?.selectionEnd ?? null);
    onChange(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2">
              <Braces className="mr-1.5 h-3.5 w-3.5" />
              {ti.insertToken}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-64 overflow-auto">
            <DropdownMenuLabel>{ti.tokenMenu.form}</DropdownMenuLabel>
            {extraTokens().map((token) => (
              <DropdownMenuItem key={token} onSelect={() => insert(wrapToken(token))}>
                <span className="truncate">{extraLabels[token] ?? token}</span>
              </DropdownMenuItem>
            ))}
            {tokens.questions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{ti.tokenMenu.questions}</DropdownMenuLabel>
                {tokens.questions.map((option) => (
                  <DropdownMenuItem key={option.token} onSelect={() => insert(option.token)}>
                    <span className="truncate">{option.label}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
            {tokens.hidden.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{ti.tokenMenu.hidden}</DropdownMenuLabel>
                {tokens.hidden.map((option) => (
                  <DropdownMenuItem key={option.token} onSelect={() => insert(option.token)}>
                    <span className="truncate">{option.label}</span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {multiline ? (
        <Textarea
          id={id}
          ref={inputRef as React.Ref<HTMLTextAreaElement>}
          rows={4}
          value={value}
          maxLength={5000}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <Input id={id} ref={inputRef as React.Ref<HTMLInputElement>} value={value} maxLength={5000} onChange={(e) => onChange(e.target.value)} />
      )}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
