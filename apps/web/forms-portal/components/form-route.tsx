import { useEffect } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { isEmbedMode, type EmbedMode } from '@weldsuite/forms-embed/protocol'
import type { PublicFormState } from '@weldsuite/app-api-client/schemas/weldforms'
import type { FormPageData } from '@/lib/page-data'
import { FormPage } from './form-page'
import { MessageScreen } from './message-screen'
import { usePortal } from './portal-context'

/** The embed mode in a query string, if any (`?embed=popup`). */
export function embedFromSearch(search: string): EmbedMode | null {
  const value = new URLSearchParams(search).get('embed')
  return isEmbedMode(value) ? value : null
}

type StateKey = Exclude<PublicFormState, 'open'>

/** What a `/f/...` or `/i/...` page shows: the not-found page, the closed states, or the form. */
export function FormRoute({ data, invitationToken }: Readonly<{ data: FormPageData; invitationToken?: string }>) {
  const { t } = usePortal()
  const search = useRouterState({ select: (s) => s.location.searchStr })
  const embed = embedFromSearch(search)
  const queryInvitation = new URLSearchParams(search).get('invitation') ?? undefined
  const token = invitationToken ?? (queryInvitation && queryInvitation.length >= 20 && queryInvitation.length <= 200 ? queryInvitation : undefined)

  const href = data.kind === 'redirect' ? data.href : null
  useEffect(() => {
    if (href) window.location.replace(href)
  }, [href])

  if (data.kind === 'not_found') return <MessageScreen title={t.notFound.title} body={t.notFound.body} />
  if (data.kind === 'redirect') return <MessageScreen title={t.members.title} body={t.members.body} />

  const { form } = data
  if (form.state !== 'open') {
    const text = t.states[form.state as StateKey]
    return <MessageScreen title={text.title} body={form.closedMessage || text.body} form={form} embedded={embed !== null} />
  }
  if (form.respondentMode === 'members') {
    // Inside an embed the visitor cannot be sent away; give them the way in.
    return (
      <MessageScreen title={t.members.title} body={t.members.body} form={form} embedded>
        {form.membersUrl ? (
          <a className="mt-2 rounded-md border px-4 py-2 text-sm font-medium" href={form.membersUrl} target="_blank" rel="noopener noreferrer">
            {t.members.button}
          </a>
        ) : null}
      </MessageScreen>
    )
  }
  return <FormPage form={form} seed={data.seed} embed={embed} search={search} {...(token ? { invitationToken: token } : {})} />
}
