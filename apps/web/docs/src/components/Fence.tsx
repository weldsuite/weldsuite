'use client'

import { Fragment } from 'react'
import { Highlight } from 'prism-react-renderer'

// Tokens carry no identity, so derive stable keys from their content plus how
// many identical entries came before (avoids using the array index as a key).
function withOccurrenceKeys<T>(
  items: T[],
  getText: (item: T) => string,
): { key: string; item: T }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const text = getText(item)
    const count = seen.get(text) ?? 0
    seen.set(text, count + 1)
    return { key: `${count}:${text}`, item }
  })
}

export function Fence({
  children,
  language,
}: Readonly<{
  children: string
  language: string
}>) {
  return (
    <Highlight
      code={children.trimEnd()}
      language={language}
      theme={{ plain: {}, styles: [] }}
    >
      {({ className, style, tokens, getTokenProps }) => (
        <pre className={className} style={style}>
          <code>
            {withOccurrenceKeys(tokens, (line) =>
              line.map((token) => token.content).join(''),
            ).map(({ key: lineKey, item: line }) => (
              <Fragment key={lineKey}>
                {withOccurrenceKeys(
                  line.filter((token) => !token.empty),
                  (token) => token.content,
                ).map(({ key: tokenKey, item: token }) => (
                  <span key={tokenKey} {...getTokenProps({ token })} />
                ))}
                {'\n'}
              </Fragment>
            ))}
          </code>
        </pre>
      )}
    </Highlight>
  )
}
