// The Authentication-Results header in the form Cloudflare Email Routing
// writes (ADR MAIL-010), so the ported parser and spam scorer read the same
// input on both editions: `spf=` for the MAIL FROM check (not HELO), then
// `dkim=`, then `dmarc=`, each always present (`none` when there was
// nothing to check). Haraka assembles the header from these entries
// (`connection.auth_results`) and puts it first; incoming ones are renamed
// to Original-Authentication-Results (connection.ini `clean_auth_results`).
//
// DMARC (RFC 7489) is evaluated here: the policy record of the From domain
// (or its organizational domain), relaxed or strict alignment, and a pass
// when SPF or DKIM passed for an aligned domain. Nothing is rejected: the
// spam scorer weighs the results, as on Global.
'use strict'

const dns = require('node:dns').promises
const tld = require('haraka-tld')

exports.register = function () {
  this.register_hook('data_post', 'add_auth_results')
}

/** The domain of the first address in a From header. */
function fromDomain(header) {
  const match = /<([^<>]+)>/.exec(header || '') || /([^\s<>",;]+@[^\s<>",;]+)/.exec(header || '')
  const address = (match?.[1] || '').trim().toLowerCase()
  const at = address.lastIndexOf('@')
  return at > 0 ? address.slice(at + 1) : ''
}

/** The DMARC record of `domain`: tags, `null` for none, `'temperror'` on a DNS failure. */
async function dmarcRecord(domain) {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`)
    const text = records.map((parts) => parts.join('')).find((r) => /^v\s*=\s*DMARC1\b/i.test(r))
    if (!text) return null
    const tags = {}
    for (const part of text.split(';')) {
      const eq = part.indexOf('=')
      if (eq > 0) tags[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim().toLowerCase()
    }
    return tags
  } catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err.code)) return null
    return 'temperror'
  }
}

function orgDomain(domain) {
  return tld.get_organizational_domain(domain) || domain
}

function aligned(a, b, strict) {
  if (!a || !b) return false
  return strict ? a === b : orgDomain(a) === orgDomain(b)
}

/** `pass`, `fail`, `none` or `temperror` for the message. */
async function evaluateDmarc(from, spf, spfDomain, dkimPass) {
  if (!from) return 'none'
  let record = await dmarcRecord(from)
  if (record === null) {
    const org = orgDomain(from)
    if (org !== from) record = await dmarcRecord(org)
  }
  if (record === 'temperror') return 'temperror'
  if (record === null) return 'none'
  const spfAligned = spf === 'pass' && aligned(spfDomain, from, record.aspf === 's')
  const dkimAligned = dkimPass.some((d) => aligned(d, from, record.adkim === 's'))
  return spfAligned || dkimAligned ? 'pass' : 'fail'
}

exports.add_auth_results = async function (next, connection) {
  const txn = connection.transaction
  if (!txn) return next()
  try {
    await tld.ready
    // The HELO check's `spf=` sits on the connection and would come first.
    if (Array.isArray(connection.notes.authentication_results)) {
      connection.notes.authentication_results = connection.notes.authentication_results.filter(
        (entry) => !/^spf=/i.test(entry),
      )
    }
    const entries = txn.notes.authentication_results || []
    const mailFrom = String(txn.mail_from?.host ?? '')
    const spf = String(txn.notes.spf_mail_result || 'none').toLowerCase()
    if (!entries.some((e) => /^spf=/i.test(e))) {
      connection.auth_results(`spf=none smtp.mailfrom=${mailFrom || connection.hello?.host || 'unknown'}`)
    }
    const dkimResults = Array.isArray(txn.notes.dkim_results) ? txn.notes.dkim_results : []
    if (!entries.some((e) => /^dkim=/i.test(e))) connection.auth_results('dkim=none')
    const from = fromDomain(txn.header.get_decoded('From'))
    const dkimPass = dkimResults.filter((r) => r.result === 'pass').map((r) => String(r.domain || '').toLowerCase())
    const dmarc = await evaluateDmarc(from, spf, mailFrom.toLowerCase(), dkimPass)
    connection.auth_results(`dmarc=${dmarc} header.from=${from || 'unknown'}`)
    txn.results.add(this, { dmarc, from })
  } catch (err) {
    connection.logerror(this, `authentication results: ${err.message}`)
  }
  next()
}
