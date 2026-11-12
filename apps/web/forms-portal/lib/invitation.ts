/**
 * An invitation link is `/i/<publicId>.<token>`: forms-api finds a form by its
 * public id (10 letters and digits), so the link carries both; the part after
 * the dot is the personal token that `startSession({ invitationToken })` sends.
 */
export function parseInvitation(param: string): { publicId: string; token: string } | null {
  const at = param.indexOf('.')
  if (at < 1) return null
  const publicId = param.slice(0, at)
  const token = param.slice(at + 1)
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(publicId) || token.length < 20 || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) return null
  return { publicId, token }
}
