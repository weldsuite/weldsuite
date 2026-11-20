import { createFileRoute } from '@tanstack/react-router'
import { FormRoute } from '@/components/form-route'
import { formHeadMeta, formMeta } from '@/lib/seo'
import { getFormPage } from '@/lib/page-data'

/**
 * `/f/<publicId>`: the form. Rendered on the server with its theme, so the
 * first paint is branded and chat and social apps get a link preview.
 * `?embed=<mode>` is the embed view (no footer chrome but the password line,
 * postMessage to the host page).
 */
export const Route = createFileRoute('/f/$publicId')({
  loaderDeps: ({ search }) => ({ embed: typeof (search as Record<string, unknown>).embed === 'string' ? ((search as Record<string, unknown>).embed as string) : undefined }),
  loader: ({ params, deps }) => getFormPage({ data: { publicId: params.publicId, ...(deps.embed ? { embed: deps.embed } : {}) } }),
  head: ({ loaderData }) => {
    if (!loaderData || loaderData.kind !== 'ready') return { meta: [{ name: 'robots', content: 'noindex' }] }
    const { form, strings } = loaderData
    const meta = formMeta(form)
    return {
      meta: [
        ...formHeadMeta(meta, null, form.branding.workspaceName || strings.meta.landingTitle),
        // A form is for the people it was sent to, not for a search index.
        { name: 'robots', content: 'noindex, nofollow' },
      ],
    }
  },
  component: FormPageRoute,
})

function FormPageRoute() {
  const data = Route.useLoaderData()
  return <FormRoute data={data} />
}
