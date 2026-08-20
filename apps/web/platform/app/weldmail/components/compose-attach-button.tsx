import { useRef } from 'react';
import { Paperclip } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';

/**
 * Paperclip toolbar control that opens the native file picker.
 *
 * A wrapping `<label>` + hidden input looks equivalent, but the compose
 * toolbar calls `preventDefault()` on mousedown to keep the editor focused
 * — that also stops the label from activating the file input, so the click
 * did nothing except show the "Attach file" tooltip. Programmatic
 * `input.click()` from the button's `onClick` still opens the picker.
 */
export function ComposeAttachButton({
  onFilesSelected,
  title,
  testId = 'compose-attach-input',
  className,
  iconClassName,
}: {
  onFilesSelected: (files: File[]) => void;
  title: string;
  testId?: string;
  className?: string;
  iconClassName?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        multiple
        data-testid={testId}
        onChange={(e) => {
          if (e.target.files?.length) {
            onFilesSelected(Array.from(e.target.files));
          }
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className={cn('p-1.5 hover:bg-muted rounded-md transition-colors', className)}
        title={title}
        aria-label={title}
      >
        <Paperclip className={cn('h-4 w-4', iconClassName)} />
      </Button>
    </>
  );
}
