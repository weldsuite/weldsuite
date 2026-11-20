import type { ReactNode } from 'react'
import { themeStyle } from '@weldsuite/forms-renderer'
import type { PublicForm } from '@weldsuite/app-api-client/schemas/weldforms'
import { Footer } from './footer'

interface MessageScreenProps {
  title: string
  body?: string | null
  /** The form's branding and theme; without it the screen is plain. */
  form?: Pick<PublicForm, 'theme' | 'branding'>
  embedded?: boolean
  children?: ReactNode
  onReport?: () => void
}

/** A centred title and line of text, for the states where there is no form to fill in. */
export function MessageScreen({ title, body, form, embedded = false, children, onReport }: Readonly<MessageScreenProps>) {
  const logo = form?.theme.logoUrl ?? form?.branding.logoUrl ?? null
  return (
    <div className="wf-page-shell" style={form ? themeStyle(form.theme) : undefined} data-embed={embedded ? 'inline' : undefined}>
      <main className="flex flex-1 items-center justify-center p-6">
        <div className="flex w-full max-w-md flex-col items-center gap-3 text-center">
          {logo ? <img src={logo} alt={form?.branding.workspaceName ?? ''} className="mb-2 max-h-12 max-w-48 object-contain" /> : null}
          <h1 className="text-xl font-semibold">{title}</h1>
          {body ? <p className="text-sm opacity-70">{body}</p> : null}
          {children}
        </div>
      </main>
      {form && onReport ? <Footer showBadge={form.branding.showBadge} embedded={embedded} onReport={onReport} /> : null}
    </div>
  )
}
