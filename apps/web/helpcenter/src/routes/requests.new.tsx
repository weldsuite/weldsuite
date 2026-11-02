import { Link, createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import type { DeskPortalRequestType } from '@weldsuite/app-api-client/schemas/desk-portal'
import { getRequestTypes } from '@/lib/portal'
import { usePortalStrings } from '@/lib/portal-i18n'
import { pageTitle } from '@/lib/site'
import { PortalError, PortalPage } from '@/components/portal/PortalShell'
import { RequestForm } from '@/components/portal/RequestForm'
import { cardClass } from '@/components/portal/styles'

export const Route = createFileRoute('/requests/new')({
  validateSearch: (search: Record<string, unknown>): { type?: string } =>
    typeof search.type === 'string' && search.type ? { type: search.type } : {},
  loader: async ({ location }) => {
    const result = await getRequestTypes()
    if (!result.signedIn) throw redirect({ to: '/sign-in', search: { next: location.href } })
    return result.data
  },
  head: ({ matches }) => ({
    meta: [{ title: pageTitle(matches, 'Submit a request') }, { name: 'robots', content: 'noindex' }],
  }),
  errorComponent: PortalError,
  component: NewRequestPage,
})

function NewRequestPage() {
  return (
    <PortalPage>
      <NewRequest />
    </PortalPage>
  )
}

function NewRequest() {
  const t = usePortalStrings()
  const types = Route.useLoaderData()
  const { type: typeId } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })

  const only = types.length === 1 ? types[0] : undefined
  const chosen = only ?? types.find((type) => type.id === typeId)

  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-white">{t.form.title}</h1>
      <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">{t.form.intro}</p>

      <div className="mt-8">
        {types.length === 0 && <p className="text-sm text-zinc-500 dark:text-zinc-400">{t.form.noTypes}</p>}

        {chosen && (
          <RequestForm
            // A fresh form per type: answers to one type's fields don't carry over.
            key={chosen.id}
            type={chosen}
            onChangeType={only ? undefined : () => void navigate({ search: {} })}
          />
        )}

        {!chosen && types.length > 1 && <TypePicker types={types} heading={t.form.chooseType} />}
      </div>
    </>
  )
}

function TypePicker({ types, heading }: Readonly<{ types: DeskPortalRequestType[]; heading: string }>) {
  return (
    <section aria-labelledby="hc-type-heading">
      <h2 id="hc-type-heading" className="text-base font-semibold text-zinc-900 dark:text-white">
        {heading}
      </h2>
      <ul className="mt-4 grid gap-3 sm:grid-cols-2">
        {types.map((type) => (
          <li key={type.id}>
            <Link
              from="/requests/new"
              search={{ type: type.id }}
              className={`${cardClass} group flex h-full items-start gap-3 p-4 transition-all hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md dark:hover:border-zinc-700`}
            >
              <span
                className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--hc-accent)]"
                style={type.color && /^#[0-9a-fA-F]{3,8}$/.test(type.color) ? { backgroundColor: type.color } : undefined}
                aria-hidden="true"
              />
              <span className="min-w-0">
                <span className="block font-medium text-zinc-900 group-hover:text-[var(--hc-accent)] dark:text-white">
                  {type.name}
                </span>
                {type.description && (
                  <span className="mt-1 line-clamp-2 block text-sm text-zinc-500 dark:text-zinc-400">
                    {type.description}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}
