import { createFileRoute } from '@tanstack/react-router'
import { FormRoute } from '@/components/form-route'
import { MessageScreen } from '@/components/message-screen'
import { usePortal } from '@/components/portal-context'
import { getHomePage } from '@/lib/page-data'
import { formHeadMeta, formMeta } from '@/lib/seo'

/**
 * `/`: the landing message, or on a workspace's custom domain its home form
 * (chosen in WeldForms' settings), rendered as `/f/<publicId>` renders it.
 */
export const Route = createFileRoute('/')({
  loader: () => getHomePage(),
  head: ({ loaderData }) => {
    if (!loaderData || loaderData.kind !== 'ready') return { meta: [{ name: 'robots', content: 'noindex' }] }
    const { form, strings } = loaderData
    return { meta: [...formHeadMeta(formMeta(form), null, form.branding.workspaceName || strings.meta.landingTitle), { name: 'robots', content: 'noindex, nofollow' }] }
  },
  component: Home,
})

function Home() {
  const data = Route.useLoaderData()
  const { t } = usePortal()
  if (data.kind === 'landing') return <MessageScreen title={t.landing.title} body={t.landing.body} />
  return <FormRoute data={data} />
}
