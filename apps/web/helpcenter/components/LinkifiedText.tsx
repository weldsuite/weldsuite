import { Fragment } from 'react'
import { linkifyText } from '@weldsuite/app-api-client/schemas/desk-linkify'

/**
 * Plain text with its URLs as links. Every part is rendered as text or an
 * anchor, never as HTML, so a message body can't inject markup.
 */
export function LinkifiedText({ text, linkClassName }: Readonly<{ text: string; linkClassName?: string }>) {
  // Keyed by where each part starts in the text: unique and stable.
  let offset = 0
  const parts = linkifyText(text).map((part) => {
    const start = offset
    offset += part.text.length
    return { ...part, key: `${part.type}-${start}` }
  })
  return (
    <>
      {parts.map((part) =>
        part.type === 'link' ? (
          <a
            key={part.key}
            href={part.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className={linkClassName ?? 'break-all underline underline-offset-2 hover:opacity-80'}
          >
            {part.text}
          </a>
        ) : (
          <Fragment key={part.key}>{part.text}</Fragment>
        ),
      )}
    </>
  )
}
