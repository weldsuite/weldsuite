/**
 * The tags that make a form link preview well in chat and social apps:
 * `<title>`, description and an image, from what the form already holds.
 */

import { recall, type Block, type FormDefinition, type FormMedia } from '@weldsuite/forms-engine'
import type { PublicForm } from '@weldsuite/app-api-client/schemas/weldforms'

export interface FormMeta {
  title: string
  description: string
  image: string | null
}

function plain(text: string | undefined, def: FormDefinition): string {
  if (!text) return ''
  // Recall tokens are answers; there are none yet, so they read as empty.
  return recall(text, def, { answers: {} }).replace(/\s+/g, ' ').trim()
}

function mediaOf(block: Block): FormMedia | undefined {
  return block.type === 'page_break' ? undefined : block.media
}

function imageOf(media: FormMedia | undefined): string | null {
  return media && media.kind === 'image' ? media.url : null
}

/** Title, description and image of a published form. */
export function formMeta(form: PublicForm): FormMeta {
  const def = form.definition
  const title = (def ? plain(form.title, def) : form.title) || form.branding.workspaceName
  if (!def) return { title, description: '', image: form.branding.logoUrl }

  const description =
    plain(def.welcome?.description, def) ||
    plain(def.welcome?.title, def) ||
    def.blocks.map((b) => (b.type === 'page_break' ? '' : plain(b.description, def))).find(Boolean) ||
    ''
  const image =
    imageOf(def.welcome?.media) ??
    def.blocks.map((b) => imageOf(mediaOf(b))).find((url): url is string => url !== null && url !== undefined) ??
    form.theme.background.imageUrl ??
    form.theme.logoUrl ??
    form.branding.logoUrl ??
    null
  return { title, description: description.slice(0, 200), image }
}

/** The `<head>` entries for a form page. */
export function formHeadMeta(meta: FormMeta, url: string | null, siteName: string): Array<Record<string, string>> {
  const tags: Array<Record<string, string>> = [
    { title: meta.title },
    { property: 'og:type', content: 'website' },
    { property: 'og:title', content: meta.title },
    { property: 'og:site_name', content: siteName },
    { name: 'twitter:card', content: meta.image ? 'summary_large_image' : 'summary' },
    { name: 'twitter:title', content: meta.title },
  ]
  if (meta.description) {
    tags.push({ name: 'description', content: meta.description })
    tags.push({ property: 'og:description', content: meta.description })
    tags.push({ name: 'twitter:description', content: meta.description })
  }
  if (meta.image) {
    tags.push({ property: 'og:image', content: meta.image })
    tags.push({ name: 'twitter:image', content: meta.image })
  }
  if (url) tags.push({ property: 'og:url', content: url })
  return tags
}
