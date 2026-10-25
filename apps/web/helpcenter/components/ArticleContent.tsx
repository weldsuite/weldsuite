import { Prose } from '@/components/Prose'

interface ArticleContentProps {
  /** Article HTML, already sanitized on the server (`sanitizeArticleHtml`). */
  html: string
}

export function ArticleContent({ html }: Readonly<ArticleContentProps>) {
  return (
    <Prose>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </Prose>
  )
}
