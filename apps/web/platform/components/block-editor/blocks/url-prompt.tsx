import { useState, type FormEvent } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { getBlockEditorStrings } from '../strings';

interface UrlPromptProps {
  placeholder: string;
  /** Return false when the link cannot be used; the prompt then shows an error. */
  onSubmit: (value: string) => boolean;
}

/**
 * The "paste a link" row an embed or bookmark block shows until it has a URL.
 * It lives inside the editor, so key and mouse events are kept away from
 * ProseMirror — otherwise typing in the field would edit the document.
 */
export function UrlPrompt({ placeholder, onSubmit }: Readonly<UrlPromptProps>) {
  const t = getBlockEditorStrings();
  const [value, setValue] = useState('');
  const [invalid, setInvalid] = useState(false);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setInvalid(!onSubmit(value));
  };

  return (
    <form
      contentEditable={false}
      onSubmit={handleSubmit}
      onKeyDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className="flex w-full flex-col gap-1.5 rounded-md border border-dashed bg-muted/40 p-2"
    >
      <div className="flex items-center gap-2">
        <LinkIcon className="ml-1 h-4 w-4 shrink-0 text-muted-foreground" />
        <Input
          autoFocus
          // Not type="url": the browser would refuse "youtube.com/…" before
          // onSubmit can add the scheme, and show its own untranslated error.
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
          className="h-8 flex-1 text-sm"
        />
        <Button type="submit" size="sm" disabled={!value.trim()}>
          {t.urlPrompt.submit}
        </Button>
      </div>
      {invalid && <p className="px-1 text-xs text-destructive">{t.urlPrompt.invalid}</p>}
    </form>
  );
}
