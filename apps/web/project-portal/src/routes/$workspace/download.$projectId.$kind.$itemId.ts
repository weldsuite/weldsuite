import { createFileRoute } from '@tanstack/react-router'
import { downloadResponse } from '@/lib/server/download'

/**
 * `/<workspace>/download/<project>/<files|documents>/<id>`: a shared file or
 * document as a download. Not a page: the handler answers with the bytes (see
 * lib/server/download.ts).
 */
export const Route = createFileRoute('/$workspace/download/$projectId/$kind/$itemId')({
  server: {
    handlers: {
      GET: ({ request, params }) => downloadResponse(request, params),
    },
  },
})
