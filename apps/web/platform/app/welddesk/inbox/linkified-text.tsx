import { Fragment, useMemo } from 'react';
import { linkifyText } from '@weldsuite/app-api-client/schemas/desk-linkify';
import { cn } from '@/lib/utils';

/**
 * A plain-text message body with its URLs as links. The text is never parsed
 * as HTML: each part renders as text or as an `<a>` to an http(s) address.
 */
export function LinkifiedText({ text, linkClassName }: Readonly<{ text: string; linkClassName?: string }>) {
  const parts = useMemo(() => {
    let offset = 0;
    return linkifyText(text).map((part) => {
      const key = String(offset);
      offset += part.text.length;
      return { ...part, key };
    });
  }, [text]);

  return (
    <>
      {parts.map((part) =>
        part.type === 'link' ? (
          <a
            key={part.key}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('underline underline-offset-2 break-all hover:opacity-80', linkClassName)}
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={part.key}>{part.text}</Fragment>
        ),
      )}
    </>
  );
}
