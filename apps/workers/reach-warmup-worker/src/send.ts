/**
 * Sender (queue `reach-warmup-send`): sends one scheduled warmup email over
 * the sender mailbox's own SMTP login.
 *
 * The message carries nothing that says "warmup": plain text from the corpus
 * with the pair's names filled in, the stored Message-ID, and the usual
 * In-Reply-To / References on a reply. No List-Unsubscribe, no X-Mailer, no
 * custom headers at all.
 *
 * Outcomes:
 *   ok                 -> `sent`, engagement scheduled 10-120 minutes later
 *   login rejected     -> sender mailbox `error` (login_failed), message `failed`
 *   delivery uncertain -> treated as sent (it may have arrived; the engager
 *                         finds it or marks it missing)
 *   anything else      -> `failed` with the reason, never retried
 *
 * The queue message is acked in every case but an unexpected exception (a
 * database or network error of ours), which retries it.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { buildMimeMessage, sendMail, type SmtpSendResult, type SmtpSocketFactory } from '@weldsuite/smtp';
import { openWarmupCredentials } from '@weldsuite/reach-domain/warmup-pool';
import type { Env, WarmupSendMessage } from './env';
import { loadCorpusForLookup, renderCorpusMessage, type CorpusThread } from './corpus';
import {
  displayName,
  isEligible,
  messages,
  openMaster,
  personOf,
  pool,
  type JobDeps,
  type MasterDatabase,
  type PoolMailbox,
  type WarmupMessage,
} from './lib/db';
import { takeClaim } from './lib/claim';
import { isWarmupEnabled } from './lib/flag';
import { pauseForCredentials, recordLoginFailure, recordLoginSuccess } from './lib/pool-state';
import { messageIdsOf, parseMessageId } from './lib/queue';
import { MINUTE_MS, randomBetween, randomFloat, type Rng } from './lib/random';
import { clip } from './lib/sql';

/** Engagement follows the send by this many minutes. */
export const ENGAGE_DELAY_MIN_MINUTES = 10;
export const ENGAGE_DELAY_MAX_MINUTES = 120;
const RETRY_DELAY_SECONDS = 60;

export interface SendDeps extends JobDeps {
  /** Tests inject a scripted SMTP socket; production uses `cloudflare:sockets`. */
  connect?: SmtpSocketFactory;
}

export type SendOutcome =
  | { status: 'sent' }
  | { status: 'uncertain' }
  | { status: 'failed'; error: string }
  | { status: 'paused'; error: string }
  | { status: 'skipped'; reason: string };

export interface SendContext {
  env: Env;
  master: MasterDatabase;
  now: Date;
  rng: Rng;
  connect?: SmtpSocketFactory;
  corpus: () => Promise<CorpusThread[]>;
}

/** Read once per batch, on first use. */
function lazyCorpus(env: Env): () => Promise<CorpusThread[]> {
  let loaded: Promise<CorpusThread[]> | null = null;
  return () => {
    loaded ??= loadCorpusForLookup(env);
    return loaded;
  };
}

/** Free the claim and record how the send ended. Only touches a row that is still `scheduled`. */
async function settle(
  ctx: SendContext,
  id: string,
  patch: Partial<typeof messages.$inferInsert>,
): Promise<void> {
  await ctx.master
    .update(messages)
    .set({ ...patch, claimedAt: null })
    .where(and(eq(messages.id, id), eq(messages.status, 'scheduled')));
}

async function fail(ctx: SendContext, id: string, error: string): Promise<SendOutcome> {
  const text = clip(error);
  await settle(ctx, id, { status: 'failed', error: text });
  return { status: 'failed', error: text };
}

async function loadParties(
  ctx: SendContext,
  row: WarmupMessage,
): Promise<{ sender: PoolMailbox; recipient: PoolMailbox } | null> {
  const rows = await ctx.master
    .select()
    .from(pool)
    .where(inArray(pool.id, [row.fromMailboxId, row.toMailboxId]));
  const sender = rows.find((mailbox) => mailbox.id === row.fromMailboxId);
  const recipient = rows.find((mailbox) => mailbox.id === row.toMailboxId);
  return sender && recipient ? { sender, recipient } : null;
}

function describeFailure(result: Extract<SmtpSendResult, { ok: false }>): string {
  const code = result.code === undefined ? '' : ` ${result.code}`;
  return `smtp ${result.stage}${code}: ${result.response}`;
}

function referenceList(row: WarmupMessage): string[] | undefined {
  if (!row.references) return undefined;
  const ids = row.references.split(' ').filter((id) => id.length > 0);
  return ids.length > 0 ? ids : undefined;
}

async function recordSent(ctx: SendContext, id: string, uncertain: boolean): Promise<void> {
  const delay = randomBetween(ctx.rng, ENGAGE_DELAY_MIN_MINUTES, ENGAGE_DELAY_MAX_MINUTES) * MINUTE_MS;
  await settle(ctx, id, {
    status: 'sent',
    sentAt: ctx.now,
    engageAt: new Date(ctx.now.getTime() + delay),
    error: uncertain ? 'delivery_uncertain' : null,
  });
}

async function recordSendResult(
  ctx: SendContext,
  row: WarmupMessage,
  sender: PoolMailbox,
  result: SmtpSendResult,
): Promise<SendOutcome> {
  if (result.ok) {
    await recordLoginSuccess(ctx.env, ctx.master, sender, ctx.now);
    await recordSent(ctx, row.id, false);
    return { status: 'sent' };
  }
  if (result.authFailed) {
    await recordLoginFailure(ctx.env, ctx.master, sender, 'smtp', result.response, ctx.now);
    return fail(ctx, row.id, describeFailure(result));
  }
  if (result.deliveryUncertain) {
    await recordSent(ctx, row.id, true);
    return { status: 'uncertain' };
  }
  return fail(ctx, row.id, describeFailure(result));
}

async function renderFor(
  ctx: SendContext,
  row: WarmupMessage,
  sender: PoolMailbox,
  recipient: PoolMailbox,
): Promise<{ text: string } | { error: string }> {
  const thread = (await ctx.corpus()).find((candidate) => candidate.id === row.corpusThreadId);
  if (!thread) return { error: 'corpus_thread_missing' };
  try {
    return { text: renderCorpusMessage(thread, row.step, personOf(sender), personOf(recipient)).text };
  } catch (err) {
    return { error: `render_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function processSend(env: Env, messageId: string, ctx: SendContext): Promise<SendOutcome> {
  const [row] = await ctx.master.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!row || row.status !== 'scheduled') return { status: 'skipped', reason: 'not_scheduled' };
  if (!(await takeClaim(ctx.master, row, 'scheduled', ctx.now))) return { status: 'skipped', reason: 'claim_lost' };

  const parties = await loadParties(ctx, row);
  if (!parties || !isEligible(parties.sender.status) || !isEligible(parties.recipient.status)) {
    return fail(ctx, row.id, 'mailbox_inactive');
  }
  const { sender, recipient } = parties;

  const smtp = await openWarmupCredentials(env, sender.smtpCredentials);
  if (!smtp) {
    await pauseForCredentials(ctx.env, ctx.master, sender, ctx.now);
    await settle(ctx, row.id, { status: 'failed', error: 'credentials_unavailable' });
    return { status: 'paused', error: 'credentials_unavailable' };
  }

  const rendered = await renderFor(ctx, row, sender, recipient);
  if ('error' in rendered) return fail(ctx, row.id, rendered.error);

  const raw = buildMimeMessage({
    from: { email: sender.email, name: displayName(sender) },
    to: [{ email: recipient.email, name: displayName(recipient) }],
    subject: row.subject,
    text: rendered.text,
    messageId: row.messageIdHeader,
    inReplyTo: row.inReplyTo ?? undefined,
    references: referenceList(row),
    date: ctx.now,
  });
  const result = await sendMail(
    { host: smtp.host, port: smtp.port, secure: smtp.port === 465, username: smtp.username, password: smtp.password },
    { from: sender.email, to: [recipient.email] },
    raw,
    ctx.connect ? { connect: ctx.connect } : undefined,
  );
  return recordSendResult(ctx, row, sender, result);
}

export async function handleSendBatch(
  batch: MessageBatch<WarmupSendMessage>,
  env: Env,
  _ctx: ExecutionContext,
  deps: SendDeps = {},
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  const master = openMaster(env, deps);

  if (!(await isWarmupEnabled(env, now))) {
    // Switched off: hand the claims back and leave the messages for the dispatcher.
    const ids = messageIdsOf(batch.messages.map((message) => message.body));
    if (ids.length > 0) await master.update(messages).set({ claimedAt: null }).where(inArray(messages.id, ids));
    batch.ackAll();
    return;
  }

  const ctx: SendContext = { env, master, now, rng: deps.random ?? randomFloat, connect: deps.connect, corpus: lazyCorpus(env) };
  for (const message of batch.messages) {
    const id = parseMessageId(message.body);
    if (id === null) {
      console.warn('[reach-warmup] send: dropped a queue message without a messageId');
      message.ack();
      continue;
    }
    try {
      const outcome = await processSend(env, id, ctx);
      if (outcome.status === 'failed' || outcome.status === 'paused') {
        console.warn(`[reach-warmup] send ${id}: ${outcome.error}`);
      }
      message.ack();
    } catch (err) {
      console.error(`[reach-warmup] send ${id} failed, will retry:`, err);
      message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
    }
  }
}
