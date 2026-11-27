import type { ReactNode } from 'react'

/** A calm page with a title and a sentence: the landing page, a dead link, an error. */
export function MessageScreen({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <main className="mx-auto grid min-h-svh max-w-md content-center gap-4 px-4 py-10 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
      {children}
    </main>
  )
}
