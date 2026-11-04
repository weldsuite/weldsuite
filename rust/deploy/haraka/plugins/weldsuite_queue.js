// The hand-off to WeldSuite (ADR MAIL-010): the raw message goes to the mail
// bucket, then its key and the SMTP envelope are published on the
// `mail.inbound` JetStream subject (Nats-Msg-Id = the key). The sender gets
// 250 only after the object is stored and the publish is acknowledged;
// anything else is a 451, so it retries. `weldsuite consume` stores it.
// Local plugins run in Haraka's sandbox: no AbortSignal or import().
//
// Env: S3_ENDPOINT, S3_REGION (us-east-1), S3_BUCKET_MAIL, S3_ACCESS_KEY_ID,
// S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE; NATS_URL, NATS_USER and
// NATS_PASSWORD or NATS_TOKEN, NATS_MAIL_INBOUND_SUBJECT (mail.inbound).
'use strict'

const DSN = require('haraka-dsn')
const crypto = require('node:crypto')
const { URL } = require('node:url')

/** An envelope address as text (a property in @haraka/email-address 3, a method before). */
function addressOf(a) {
  if (!a) return ''
  return typeof a.address === 'function' ? a.address() : String(a.address ?? '')
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding of one path segment, as SigV4 wants it. */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** `promise`, or a rejection after `ms` (plugins run in a sandbox without AbortSignal). */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** PUT `body` at `key` with an AWS Signature Version 4 (any S3 store). */
async function s3Put(cfg, key, body, contentType) {
  const endpoint = new URL(cfg.endpoint)
  const path = key.split('/').map(encodeSegment).join('/')
  const host = cfg.pathStyle ? endpoint.host : `${cfg.bucket}.${endpoint.host}`
  const canonicalPath = cfg.pathStyle ? `/${encodeSegment(cfg.bucket)}/${path}` : `/${path}`
  const url = `${endpoint.protocol}//${host}${canonicalPath}`
  const now = new Date()
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const payloadHash = sha256(body)
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonical = ['PUT', canonicalPath, '', `host:${host}`, `x-amz-content-sha256:${payloadHash}`, `x-amz-date:${amzDate}`, '', signedHeaders, payloadHash].join('\n')
  const scope = `${day}/${cfg.region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), cfg.region), 's3'), 'aws4_request')
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex')
  const res = await withTimeout(
    fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'content-type': contentType,
    },
      body,
    }),
    30_000,
  )
  if (!res.ok) throw new Error(`S3 PUT ${res.status}: ${(await res.text()).slice(0, 200)}`)
}

exports.register = function () {
  const env = process.env
  this.s3 = {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || 'us-east-1',
    bucket: env.S3_BUCKET_MAIL,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    pathStyle: env.S3_FORCE_PATH_STYLE === 'true',
  }
  this.subject = env.NATS_MAIL_INBOUND_SUBJECT || 'mail.inbound'
  if (!this.s3.endpoint || !this.s3.bucket || !env.NATS_URL) {
    this.logerror('S3_ENDPOINT, S3_BUCKET_MAIL and NATS_URL are required: every message is deferred')
  }
  this.register_hook('queue', 'hand_off')
}

/** The JetStream client, connected once and reconnecting on its own. */
exports.jetstream = function () {
  if (!this.js) {
    this.js = (async () => {
      const { connect } = require('@nats-io/transport-node')
      const { jetstream } = require('@nats-io/jetstream')
      const env = process.env
      const nc = await connect({
        servers: env.NATS_URL.split(','),
        name: 'weldsuite-haraka',
        ...(env.NATS_USER ? { user: env.NATS_USER, pass: env.NATS_PASSWORD } : {}),
        ...(env.NATS_TOKEN ? { token: env.NATS_TOKEN } : {}),
        maxReconnectAttempts: -1,
      })
      return jetstream(nc)
    })().catch((err) => {
      this.js = null
      throw err
    })
  }
  return this.js
}

/** The message as it was received, Haraka's headers included. */
function messageBytes(txn) {
  return new Promise((resolve) => txn.message_stream.get_data(resolve))
}

exports.hand_off = async function (next, connection) {
  const txn = connection.transaction
  if (!this.s3.endpoint || !this.s3.bucket || !process.env.NATS_URL) {
    return next(DENYSOFT, DSN.sys_unspecified('Mail storage is not configured, try again later', 451))
  }
  const day = new Date().toISOString().slice(0, 10).replaceAll('-', '/')
  const key = `inbound/${day}/${txn.uuid}.eml`
  try {
    const body = await messageBytes(txn)
    await s3Put(this.s3, key, body, 'message/rfc822')
    const envelope = {
      key,
      mailFrom: addressOf(txn.mail_from),
      rcptTo: txn.rcpt_to.map(addressOf),
      remoteIp: connection.remote?.ip || null,
      helo: connection.hello?.host || null,
      receivedAt: new Date().toISOString(),
      size: body.length,
    }
    const js = await this.jetstream()
    await js.publish(this.subject, JSON.stringify(envelope), { msgID: key, timeout: 10_000 })
    connection.loginfo(this, `spooled ${key} (${body.length} bytes) for ${envelope.rcptTo.length} recipient(s)`)
    return next(OK, `Queued as ${txn.uuid}`)
  } catch (err) {
    connection.logerror(this, `hand-off of ${key} failed: ${err.message}`)
    return next(DENYSOFT, DSN.sys_unspecified('Temporary storage failure, try again later', 451))
  }
}
