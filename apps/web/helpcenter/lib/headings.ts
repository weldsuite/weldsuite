export interface Heading {
  id: string
  text: string
  level: number
}

/** The h2/h3 outline of article HTML, for the "On this page" list. */
export function extractHeadings(html: string): Heading[] {
  const headings: Heading[] = []
  // Capture the open-tag attributes and inner HTML separately. `[\s\S]` so inner
  // content spanning newlines still matches; `\1` so the close tag matches level.
  const regex = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi
  let match
  while ((match = regex.exec(html)) !== null) {
    const level = Number.parseInt(match[1]!, 10)
    const attrs = match[2]!
    const inner = match[3]!
    const text = inner.replace(/<[^<>]*>/g, '').trim()
    const idAttr = /\bid="([^"]*)"/i.exec(attrs)?.[1]
    const id =
      idAttr ||
      text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    if (text) headings.push({ id, text, level })
  }
  return headings
}
