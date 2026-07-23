import sanitizeHtml from 'sanitize-html'
import { Prose } from '@/components/Prose'

interface ArticleContentProps {
  html: string
}

// Safe value patterns for the few CSS properties the editor emits. None can
// contain `url(`, parens (except rgb/hsl), or `;`, so the CSS-exfiltration /
// expression() vectors stay closed while real formatting renders.
const HEX = /^#(?:[0-9a-fA-F]{3,8})$/
const RGB = /^rgba?\(\s*[\d.,\s%]+\)$/
const HSL = /^hsla?\(\s*[\d.,\s%]+\)$/
const NAMED = /^[a-zA-Z]+$/
const COLORS = [HEX, RGB, HSL, NAMED]

/**
 * Server component — sanitizes attacker-controllable article HTML at render
 * time (never ships sanitize-html to the browser). Allows the formatting the
 * WeldSuite editor produces (bold, italic, underline, alignment, colours,
 * highlight, font family/size, lists, tables, images, links) via a tight
 * tag + attribute + inline-style allowlist.
 */
export function ArticleContent({ html }: ArticleContentProps) {
  const clean = sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img', 'h1', 'h2',
      'u', 's', 'del', 'ins', 'mark', 'sub', 'sup',
      'span', 'font', 'figure', 'figcaption',
    ]),
    allowedAttributes: {
      '*': ['id', 'class', 'style', 'align'],
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'loading', 'style'],
      font: ['color', 'face', 'size'],
      ol: ['start', 'type'],
      td: ['colspan', 'rowspan'],
      th: ['colspan', 'rowspan', 'scope'],
    },
    allowedStyles: {
      '*': {
        'text-align': [/^(left|right|center|justify)$/],
        'color': COLORS,
        'background-color': COLORS,
        'font-weight': [/^(bold|bolder|lighter|normal|[1-9]00)$/],
        'font-style': [/^(italic|normal|oblique)$/],
        'text-decoration': [/^(underline|line-through|overline|none)(\s+\S+)*$/],
        'font-family': [/^[\w\s,"'-]+$/],
        'font-size': [/^\d+(\.\d+)?(px|em|rem|pt|%)$/],
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow' }, true),
    },
  })

  return (
    <Prose>
      <div dangerouslySetInnerHTML={{ __html: clean }} />
    </Prose>
  )
}
