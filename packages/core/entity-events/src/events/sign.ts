/**
 * WeldSign entity events. Payloads carry ids, title and status only: field
 * values, signature images and access codes never ride the bus (EVT-005).
 * `sign_events` is the legal evidence trail, not these events.
 */
export const SIGN_ENTITY_EVENTS = {
  /**
   * `updated`: anything about a draft changed (settings, documents,
   * recipients, fields), or a sent request's recipients did (a reminder, a
   * new link, a corrected email). `sent`: the request went out. `signed`: one
   * signer signed (the payload names no one; read the envelope). `declined`:
   * a signer declined, which closes the request. `completed`: everyone signed
   * and the signed PDF is ready ("contract signed" in WeldConnect).
   * `voided`: the sender stopped the request. `expired`: it passed its expiry
   * before everyone signed.
   */
  sign_envelope: ['created', 'updated', 'deleted', 'sent', 'signed', 'declined', 'completed', 'voided', 'expired'],
} as const;
