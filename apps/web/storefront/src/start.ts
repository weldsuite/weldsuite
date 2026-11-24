import { createStart } from '@tanstack/react-start'
import { csrf, documentRedirects, edgeOnly, previewEntry, securityHeaders } from '@/lib/server/middleware'

export const startInstance = createStart(() => ({
  requestMiddleware: [edgeOnly, securityHeaders, previewEntry, documentRedirects, csrf],
}))
