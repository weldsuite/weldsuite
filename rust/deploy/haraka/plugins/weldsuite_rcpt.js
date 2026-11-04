// The RCPT TO check (ADR MAIL-010): asks weldsuite serve whether the master
// registry (MAIL-002) has the address, live, so an address created a second
// ago already receives mail.
//
//   200 → 250, 404 → 550 5.1.1, anything else (or no answer) → 451
//
// Local plugins run in Haraka's sandbox: no AbortSignal, URL or import().
//
// Env: WELDSUITE_RCPT_URL (…/internal/mail-inbound/recipients),
// MAIL_INBOUND_SECRET, WELDSUITE_RCPT_TIMEOUT_MS (default 5000).
'use strict'

const DSN = require('haraka-dsn')

/** An envelope address as text (a property in @haraka/email-address 3, a method before). */
function addressOf(a) {
  if (!a) return ''
  return typeof a.address === 'function' ? a.address() : String(a.address ?? '')
}

/** `promise`, or a rejection after `ms` (plugins run in a sandbox without AbortSignal). */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

exports.register = function () {
  this.url = process.env.WELDSUITE_RCPT_URL
  this.secret = process.env.MAIL_INBOUND_SECRET
  this.timeout = Number(process.env.WELDSUITE_RCPT_TIMEOUT_MS || 5000)
  if (!this.url || !this.secret) {
    this.logerror('WELDSUITE_RCPT_URL and MAIL_INBOUND_SECRET are required: every recipient is deferred')
  }
  this.register_hook('rcpt', 'check_recipient')
}

exports.check_recipient = async function (next, connection, params) {
  const address = addressOf(params[0])
  if (!this.url || !this.secret) {
    return next(DENYSOFT, DSN.sys_unspecified('Recipient check not configured', 451))
  }
  try {
    const res = await withTimeout(
      fetch(this.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      }),
      this.timeout,
    )
    if (res.status === 200) {
      connection.transaction?.results.add(this, { pass: address })
      return next(OK)
    }
    if (res.status === 404) {
      connection.transaction?.results.add(this, { fail: address })
      return next(DENY, DSN.no_such_user())
    }
    connection.logwarn(this, `recipient check for ${address} answered ${res.status}`)
  } catch (err) {
    connection.logwarn(this, `recipient check for ${address} failed: ${err.message}`)
  }
  return next(DENYSOFT, DSN.sys_unspecified('Recipient check unavailable, try again later', 451))
}
