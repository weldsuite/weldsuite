import { notFound } from 'next/navigation'
import { getHelpcenterConfig, getFolders } from '@/lib/api-client'
import { Header } from '@/components/Header'
import { Footer } from '@/components/Footer'
import { Sidebar } from '@/components/Sidebar'

/**
 * Workspace-supplied custom CSS is injected into a public page, so strip the
 * constructs that turn CSS into an exfiltration / script vector before it
 * reaches the DOM: `</style>` breakouts, `@import`, `expression()`,
 * `javascript:` urls, and IE `behavior` / `-moz-binding`.
 */
function sanitizeCss(css: string): string {
  return css
    .replace(/<\/?\s*style/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(/gi, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/-moz-binding/gi, '')
    .replace(/behavior\s*:/gi, '')
}

/** Only accept a real hex colour for the accent CSS var; fall back otherwise. */
function accentColor(value?: string | null): string | undefined {
  return value && /^#[0-9a-fA-F]{3,8}$/.test(value.trim()) ? value.trim() : undefined
}

export async function generateMetadata({ params }: { params: Promise<{ domain: string }> }) {
  const { domain } = await params
  const config = await getHelpcenterConfig(domain)

  if (!config) return { title: 'Help Center' }

  return {
    title: {
      template: `%s - ${config.siteName || 'Help Center'}`,
      default: config.metaTitle || config.siteName || 'Help Center',
    },
    description: config.metaDescription,
    openGraph: config.ogImage ? { images: [config.ogImage] } : undefined,
    // A workspace can override the default WeldDesk favicon (app/icon.svg) with
    // its own. When unset, the file-based default applies.
    icons: config.favicon ? { icon: config.favicon } : undefined,
  }
}

export default async function DomainLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ domain: string }>
}) {
  const { domain } = await params
  const [config, folders] = await Promise.all([getHelpcenterConfig(domain), getFolders(domain)])

  if (!config) notFound()

  const accent = accentColor(config.primaryColor)

  return (
    <div
      className="flex min-h-full w-full flex-col"
      style={accent ? ({ '--hc-accent': accent } as React.CSSProperties) : undefined}
    >
      <Header config={config} />

      <div className="mx-auto flex w-full max-w-7xl flex-auto px-4 sm:px-6 lg:px-8">
        {folders.length > 0 && (
          <aside className="hidden w-64 shrink-0 lg:block">
            <div className="sticky top-16 max-h-[calc(100vh-4rem)] overflow-y-auto py-10 pr-6">
              <Sidebar folders={folders} />
            </div>
          </aside>
        )}
        <main className="min-w-0 flex-auto">{children}</main>
      </div>

      <Footer config={config} />

      {config.customCss && (
        <style dangerouslySetInnerHTML={{ __html: sanitizeCss(config.customCss) }} />
      )}
    </div>
  )
}
