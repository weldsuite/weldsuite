import { notFound } from 'next/navigation'
import { getArticle, getFolders } from '@/lib/api-client'
import { ArticleContent } from '@/components/ArticleContent'
import { ArticleFeedback } from '@/components/ArticleFeedback'
import { Breadcrumbs } from '@/components/Breadcrumbs'
import { TableOfContents } from '@/components/TableOfContents'

export async function generateMetadata({ params }: { params: Promise<{ domain: string; slug: string }> }) {
  const { domain, slug } = await params
  const article = await getArticle(domain, slug)
  if (!article) return { title: 'Article Not Found' }
  return { title: article.title, description: article.excerpt }
}

export default async function ArticlePage({ params }: { params: Promise<{ domain: string; slug: string }> }) {
  const { domain, slug } = await params
  const [article, folders] = await Promise.all([
    getArticle(domain, slug),
    getFolders(domain),
  ])

  if (!article) notFound()

  const folder = folders.find((f) => f.id === article.folderId)
  const headings = extractHeadings(article.content || '')

  return (
    <div className="flex gap-12 py-10 lg:py-14">
      <div className="min-w-0 max-w-3xl flex-auto">
        <article>
          <Breadcrumbs folder={folder} articleTitle={article.title} />

          {article.updatedAt && (
            <p className="mt-2 text-sm text-zinc-400 dark:text-zinc-500">
              Last updated{' '}
              {new Date(article.updatedAt).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>
          )}

          <ArticleContent html={article.content || ''} />
        </article>

        <div className="mt-14 border-t border-zinc-200 pt-8 dark:border-zinc-800">
          <ArticleFeedback articleId={article.id} domain={domain} />
        </div>
      </div>

      <TableOfContents headings={headings} />
    </div>
  )
}

function extractHeadings(html: string): { id: string; text: string; level: number }[] {
  const headings: { id: string; text: string; level: number }[] = []
  // Capture the open-tag attributes and inner HTML separately. `[\s\S]` so inner
  // content spanning newlines still matches; `\1` so the close tag matches level.
  const regex = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    const level = parseInt(match[1], 10)
    const attrs = match[2]
    const inner = match[3]
    const text = inner.replace(/<[^>]*>/g, '').trim()
    const idAttr = attrs.match(/\bid="([^"]*)"/i)?.[1]
    const id =
      idAttr ||
      text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (text) headings.push({ id, text, level })
  }
  return headings
}
