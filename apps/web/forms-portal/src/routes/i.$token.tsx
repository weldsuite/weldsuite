import { createFileRoute } from '@tanstack/react-router'
import { FormRoute } from '@/components/form-route'
import { getFormPage } from '@/lib/page-data'
import { parseInvitation } from '@/lib/invitation'
import { formHeadMeta, formMeta } from '@/lib/seo'

/**
 * `/i/<publicId>.<token>`: a personal invitation link. Opening it starts a
 * session as the invited person, with no code. The public id travels in the
 * link because forms-api looks a form up by it; the token is what
 * `startSession({ invitationToken })` takes. (`/f/<publicId>?invitation=<token>`
 * is the same thing.)
 */
export const Route = createFileRoute('/i/$token')({
  loader: ({ params }) => getFormPage({ data: { publicId: parseInvitation(params.token)?.publicId ?? '' } }),
  head: ({ loaderData }) => {
    if (!loaderData || loaderData.kind !== 'ready') return { meta: [{ name: 'robots', content: 'noindex' }] }
    const { form, strings } = loaderData
    return { meta: [...formHeadMeta(formMeta(form), null, form.branding.workspaceName || strings.meta.landingTitle), { name: 'robots', content: 'noindex, nofollow' }] }
  },
  component: InvitationRoute,
})

function InvitationRoute() {
  const data = Route.useLoaderData()
  const { token } = Route.useParams()
  return <FormRoute data={data} invitationToken={parseInvitation(token)?.token ?? ''} />
}
