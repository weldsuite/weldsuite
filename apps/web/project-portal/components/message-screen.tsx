import type { ReactNode } from 'react'

/** A centred title and sentence, for the pages that have little to say: home, not found, errors. */
export function MessageScreen({
  title,
  body,
  children,
}: Readonly<{ title: string; body: string; children?: ReactNode }>) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      {children}
    </div>
  )
}
