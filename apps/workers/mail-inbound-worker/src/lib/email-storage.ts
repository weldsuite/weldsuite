/**
 * Email Storage
 *
 * Functions for storing emails and finding recipients.
 * Used by the Mailgun webhook handler.
 */

import { eq, and, or, inArray, isNull, desc, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { getMasterDb, getTenantDbForWorkspaceById, masterSchema, tenantSchema } from '../db';
import {
  publishNewEmailToUser,
  publishWorkspaceMessageNew,
  publishNewConversation,
} from './realtime';
import { sendNewEmailPushNotification } from './push-notifications';
import { upsertContactsFromMailMessage } from './contact-upsert';
import type { Env } from '../index';

/**
 * Parsed attachment from MIME parsing.
 */
export interface ParsedAttachment {
  fileName: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
  disposition?: string;
}

/**
 * Compute threadId for a message based on RFC 5322 headers.
 *
 * Algorithm:
 * 1. If `references` array exists and has entries, use the first entry (root of conversation)
 * 2. Else if `inReplyTo` exists, use that as threadId
 * 3. Else use the message's own `messageId` (this is a new/standalone thread)
 */
function computeThreadId(message: {
  messageId: string;
  inReplyTo?: string | null;
  references?: string[] | null;
}): string {
  // References array contains all ancestor message IDs, first one is the root
  const firstRef = message.references?.[0];
  if (firstRef) {
    return firstRef;
  }

  // inReplyTo points to the immediate parent - use it as threadId
  if (message.inReplyTo) {
    return message.inReplyTo;
  }

  // No threading info - this message starts its own thread
  return message.messageId;
}

/**
 * Recipient account info
 */
export interface RecipientAccount {
  accountId: string;
  accountEmail: string;
  /** Internal workspace id (workspaces.id) — used for tenant DB lookups. */
  workspaceId: string;
  /** Clerk org id (workspaces.clerk_org_id) — used as the realtime topic key. */
  clerkOrgId: string;
  /** Active workspace members (userId + login email) eligible for notification. */
  members: { userId: string; email: string | null }[];
}

/**
 * Parsed email address
 */
export interface EmailAddress {
  email: string;
  name?: string;
}

/**
 * Parsed incoming email (common format for both sources)
 */
/** SPF/DKIM/DMARC result values matching the mail_security_status enum */
export type SecurityStatus = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';

export interface ParsedEmail {
  emailId: string;
  messageId: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  /**
   * SMTP envelope recipients (RCPT TO) for this delivery. This is the
   * authoritative "who was this actually delivered to" signal and is the ONLY
   * place a CC- or BCC-only recipient's address appears — BCC is stripped from
   * the visible headers, and a CC'd recipient is often not in the `To` header.
   * Empty/undefined for transports that don't supply envelope data (e.g. raw
   * RFC 5322 POSTs), in which case recipient matching falls back to To/Cc.
   */
  envelopeTo?: string[];
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  headers: Record<string, string>;
  receivedAt: Date;
  hasAttachments: boolean;
  attachmentCount: number;
  inReplyTo?: string;
  references?: string[];
  // Authentication results parsed from Authentication-Results header
  spfStatus?: SecurityStatus;
  dkimStatus?: SecurityStatus;
  dmarcStatus?: SecurityStatus;
  // Raw RFC 5322 message for audit trail
  rawMessage?: string;
}

/**
 * Collect every address this message was delivered to: the SMTP envelope
 * recipient(s) plus the visible To/Cc headers, lower-cased and de-duplicated.
 *
 * Matching on the envelope recipient is what lets CC- and BCC-only recipients
 * resolve to an account — a BCC'd address never appears in any header, and a
 * CC'd address is frequently absent from `To`. To/Cc stay in the mix as a
 * fallback for transports that don't provide an envelope (raw RFC 5322 POSTs).
 */
export function collectRecipientEmails(email: ParsedEmail): string[] {
  const all = [
    ...(email.envelopeTo ?? []),
    ...email.to.map((t) => t.email),
    ...email.cc.map((t) => t.email),
  ]
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(all)];
}

/**
 * Find mail accounts by recipient email addresses
 * @param env - Worker environment bindings
 * @param recipientEmails - List of recipient email addresses to look up
 */
export async function findRecipientAccounts(
  env: Env,
  recipientEmails: string[]
): Promise<RecipientAccount[]> {
  const masterDb = getMasterDb(env);

  // Lookup in mail account registry (master DB), joined with workspaces so we
  // also get the Clerk org id — required for realtime publishing because the
  // WorkspaceHub Durable Object is keyed by clerkOrgId, not the internal id.
  const registered = await masterDb
    .select({
      email: masterSchema.mailAccountRegistry.email,
      accountId: masterSchema.mailAccountRegistry.accountId,
      workspaceId: masterSchema.mailAccountRegistry.workspaceId,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.mailAccountRegistry)
    .innerJoin(
      masterSchema.workspaces,
      eq(masterSchema.workspaces.id, masterSchema.mailAccountRegistry.workspaceId),
    )
    .where(
      and(
        inArray(masterSchema.mailAccountRegistry.email, recipientEmails),
        eq(masterSchema.mailAccountRegistry.isActive, true)
      )
    );

  if (registered.length === 0) {
    return [];
  }

  // Group by workspace and find workspace members
  // Each workspace may have its own database, so we need to query each one
  const results: RecipientAccount[] = [];

  for (const reg of registered) {
    try {
      // Get the workspace-specific database
      const tenantDb = await getTenantDbForWorkspaceById(env, reg.workspaceId);

      // Find active workspace members (tenant DB). We also pull each member's
      // login email so the notification fan-out can skip the person who sent
      // the message (internal recipient / shared mailbox / self-send loops the
      // sent copy back through this worker).
      const members = await tenantDb
        .select({
          userId: tenantSchema.workspaceMembers.userId,
          email: tenantSchema.workspaceMembers.email,
        })
        .from(tenantSchema.workspaceMembers)
        .where(
          and(
            isNull(tenantSchema.workspaceMembers.deletedAt),
            eq(tenantSchema.workspaceMembers.status, 'ACTIVE')
          )
        );

      // Scope notifications to users who can actually access this mailbox:
      // shared accounts notify everyone, non-shared accounts only their
      // assigned users. This mirrors the app-api access model (isShared /
      // assignedUserIds). If a non-shared account has no assignment data
      // recorded, we fall back to all members so mail is never silently
      // un-notified.
      const [accountAccess] = await tenantDb
        .select({
          isShared: tenantSchema.mailAccounts.isShared,
          assignedUserIds: tenantSchema.mailAccounts.assignedUserIds,
        })
        .from(tenantSchema.mailAccounts)
        .where(eq(tenantSchema.mailAccounts.id, reg.accountId))
        .limit(1);

      const assigned = accountAccess?.assignedUserIds ?? undefined;
      const scopeToAssigned =
        accountAccess && !accountAccess.isShared && assigned !== undefined && assigned.length > 0;

      const eligibleMembers = scopeToAssigned
        ? members.filter((m) => assigned!.includes(m.userId))
        : members;

      const uniqueMembers = [...new Map(eligibleMembers.map((m) => [m.userId, m])).values()];

      if (uniqueMembers.length > 0 && reg.clerkOrgId) {
        results.push({
          accountId: reg.accountId,
          accountEmail: reg.email,
          workspaceId: reg.workspaceId,
          clerkOrgId: reg.clerkOrgId,
          members: uniqueMembers,
        });
      } else if (!reg.clerkOrgId) {
        console.warn(`[Recipients] Workspace ${reg.workspaceId} has no clerkOrgId — realtime events will be skipped`);
      }
    } catch (error) {
      console.error(`[Recipients] Failed to get members for workspace ${reg.workspaceId}:`, error);
      // Continue processing other workspaces
    }
  }

  return results;
}

/**
 * Store email in tenant database
 * @param env - Worker environment bindings
 * @param account - Recipient account info
 * @param email - Parsed email to store
 */
export async function storeEmail(
  env: Env,
  account: RecipientAccount,
  email: ParsedEmail
): Promise<{ messageId: string; threadId: string } | null> {
  try {
    // Get the workspace-specific database
    const tenantDb = await getTenantDbForWorkspaceById(env, account.workspaceId);

    // Deduplication: skip if this messageId already exists for this account
    if (email.messageId) {
      const existing = await tenantDb
        .select({ id: tenantSchema.mailMessages.id })
        .from(tenantSchema.mailMessages)
        .where(
          and(
            eq(tenantSchema.mailMessages.accountId, account.accountId),
            eq(tenantSchema.mailMessages.messageId, email.messageId),
          )
        )
        .limit(1);

      if (existing.length > 0) {
        console.log(`[Store] Duplicate skipped: messageId=${email.messageId} already exists for account ${account.accountId}`);
        return null;
      }
    }

    // Generate message ID
    const dbMessageId = `msg_${nanoid()}`;

    // Check if this is a reply to an existing message in the DB
    const isReply = Boolean(email.inReplyTo || (email.references && email.references.length > 0));
    let threadId: string;

    if (isReply) {
      // Look up existing messages by inReplyTo or references to find the thread
      const lookupIds = [
        ...(email.inReplyTo ? [email.inReplyTo] : []),
        ...(email.references || []),
      ];

      let matched = false;

      if (lookupIds.length > 0) {
        // Extract local parts from Message-IDs for provider ID matching
        // e.g. "<abc-123@eu-west-1.amazonses.com>" → "abc-123"
        const providerIds = lookupIds
          .map((id) => id.replace(/^</, '').replace(/@.*>?$/, ''))
          .filter(Boolean);

        const existingMessages = await tenantDb
          .select({
            threadId: tenantSchema.mailMessages.threadId,
            messageId: tenantSchema.mailMessages.messageId,
          })
          .from(tenantSchema.mailMessages)
          .where(
            and(
              eq(tenantSchema.mailMessages.accountId, account.accountId),
              or(
                // Match by our stored messageId (custom Message-ID header)
                inArray(tenantSchema.mailMessages.messageId, lookupIds),
                // Match by provider message ID (Mailgun/SES may override Message-ID)
                inArray(tenantSchema.mailMessages.mailcowMessageId, providerIds)
              )
            )
          )
          .limit(1);

        if (existingMessages.length > 0 && existingMessages[0].threadId) {
          threadId = existingMessages[0].threadId;
          matched = true;
          console.log(`[Store] Found existing thread ${threadId} for reply (by messageId)`);
        }
      }

      // Fallback: match by subject when Message-ID lookup fails
      // (handles cases where the email provider overrides the Message-ID header)
      if (!matched) {
        const normalizedSubject = email.subject
          .replace(/^(Re|Fwd|Fw):\s*/gi, '')
          .trim();

        if (normalizedSubject) {
          const subjectMatch = await tenantDb
            .select({
              threadId: tenantSchema.mailMessages.threadId,
            })
            .from(tenantSchema.mailMessages)
            .where(
              and(
                eq(tenantSchema.mailMessages.accountId, account.accountId),
                eq(tenantSchema.mailMessages.subject, normalizedSubject),
                isNull(tenantSchema.mailMessages.deletedAt)
              )
            )
            .orderBy(desc(tenantSchema.mailMessages.sentDate))
            .limit(1);

          if (subjectMatch.length > 0 && subjectMatch[0].threadId) {
            threadId = subjectMatch[0].threadId;
            matched = true;
            console.log(`[Store] Found existing thread ${threadId} for reply (by subject)`);
          }
        }
      }

      if (!matched) {
        threadId = computeThreadId({
          messageId: email.messageId,
          inReplyTo: email.inReplyTo,
          references: email.references,
        });
      }
    } else {
      // New standalone message
      threadId = email.messageId;
    }

    // Insert message
    await tenantDb.insert(tenantSchema.mailMessages).values({
      id: dbMessageId,
      accountId: account.accountId,
      messageId: email.messageId,
      threadId,
      subject: email.subject,
      from: email.from,
      to: email.to,
      cc: email.cc,
      textBody: email.textBody,
      htmlBody: email.htmlBody,
      preview: email.textBody?.substring(0, 200) || email.subject,
      sentDate: email.receivedAt,
      receivedDate: new Date(),
      isRead: false,
      hasAttachments: email.hasAttachments,
      attachmentCount: email.attachmentCount,
      inReplyTo: email.inReplyTo,
      references: email.references || [],
      isReply,
      labels: ['INBOX'],
      source: 'inbound',
      spfStatus: email.spfStatus,
      dkimStatus: email.dkimStatus,
      dmarcStatus: email.dmarcStatus,
      rawMessage: email.rawMessage,
    });

    console.log(`[Store] Saved email ${dbMessageId} (thread ${threadId}) for account ${account.accountId}`);

    // Apply keyword-based AI labels (synchronous, free)
    try {
      await applyKeywordLabels(tenantDb, account.accountId, dbMessageId, email);
    } catch (labelErr) {
      console.error(`[Store] Failed to apply keyword labels for ${dbMessageId}:`, labelErr);
    }

    return { messageId: dbMessageId, threadId };
  } catch (error) {
    console.error(`[Store] Failed to store email:`, error);
    return null;
  }
}

/**
 * Process a parsed email: find recipients, store, and notify
 * @param env - Worker environment bindings
 * @param email - Parsed email to process
 */
export async function processInboundEmail(
  env: Env,
  email: ParsedEmail,
  attachments?: ParsedAttachment[],
): Promise<{ stored: number; notified: number; recipients: number }> {
  // Match on the envelope recipient + To/Cc so CC- and BCC-only recipients
  // still resolve to their account (see collectRecipientEmails).
  const recipientEmails = collectRecipientEmails(email);
  const accounts = await findRecipientAccounts(env, recipientEmails);

  if (accounts.length === 0) {
    console.log(`[Mailgun] No matching accounts for: ${recipientEmails.join(', ')}`);
    return { stored: 0, notified: 0, recipients: 0 };
  }

  let stored = 0;
  let notified = 0;

  for (const account of accounts) {
    const result = await storeEmail(env, account, email);
    if (result) {
      stored++;

      // Store attachments to R2 + DB
      if (email.hasAttachments && attachments && attachments.length > 0 && env.STORAGE) {
        try {
          const cidMap = await storeInboundAttachments(env, account.workspaceId, result.messageId, attachments);

          // Rewrite cid: references in HTML body to point to R2 URLs
          if (cidMap.size > 0 && email.htmlBody) {
            let rewrittenHtml = email.htmlBody;
            for (const [cid, url] of cidMap) {
              // Replace "cid:xxx" references (in src="cid:xxx" or url(cid:xxx) etc.)
              rewrittenHtml = rewrittenHtml.replaceAll(`cid:${cid}`, url);
            }

            if (rewrittenHtml !== email.htmlBody) {
              const tenantDb = await getTenantDbForWorkspaceById(env, account.workspaceId);
              await tenantDb
                .update(tenantSchema.mailMessages)
                .set({ htmlBody: rewrittenHtml })
                .where(eq(tenantSchema.mailMessages.id, result.messageId));
              console.log(`[Store] Rewrote ${cidMap.size} inline CID reference(s) in HTML body for ${result.messageId}`);
            }
          }
        } catch (attachErr) {
          console.error(`[Store] Failed to store attachments for ${result.messageId}:`, attachErr);
        }
      }

      // Run AI semantic classification + mail rules (non-blocking)
      try {
        await classifyAndRunRules(env, account, result.messageId, email);
      } catch (classifyErr) {
        console.error(`[Store] AI classify/rules failed for ${result.messageId}:`, classifyErr);
      }

      // Upsert mail addresses into the shared contacts table so senders +
      // recipients become first-class records (autocomplete, avatars, …).
      // Best-effort — never blocks downstream notifications.
      try {
        await upsertContactsFromMailMessage(env, account.workspaceId, account.clerkOrgId ?? null, {
          from: email.from,
          to: email.to,
          cc: email.cc,
        });
      } catch (contactErr) {
        console.error(`[Store] Contact upsert failed for ${result.messageId}:`, contactErr);
      }

      // Send real-time + push notifications to all workspace members.
      // Use clerkOrgId (NOT internal workspaceId) — WorkspaceHub DO is keyed
      // by clerkOrgId on the WS-auth side, so the publish must use the same
      // key or it lands on a different DO and never reaches the client.
      const senderEmail = email.from.email.toLowerCase();
      for (const member of account.members) {
        // Skip the sender: when a message is sent to an internal recipient, a
        // shared mailbox, or the sender's own address, the sent copy is routed
        // back into this worker. Without this guard the sender gets an in-app +
        // push "New email from <themselves>" notification for their own send.
        if (member.email && member.email.toLowerCase() === senderEmail) {
          continue;
        }
        const userId = member.userId;
        try {
          await publishNewEmailToUser(env, account.clerkOrgId, userId, {
            accountId: account.accountId,
            messageId: email.messageId,
            threadId: result.threadId,
            from: email.from,
            subject: email.subject,
            preview: email.textBody?.substring(0, 200) || email.subject,
            receivedAt: email.receivedAt.toISOString(),
            isRead: false,
            hasAttachments: email.hasAttachments,
          });
          notified++;
        } catch (notifyErr) {
          console.error(`[Mailgun] Failed to notify user ${userId}:`, notifyErr);
        }

        // Send push notification to mobile devices
        try {
          await sendNewEmailPushNotification(env, {
            userId,
            workspaceId: account.workspaceId,
            messageId: result.messageId,
            accountId: account.accountId,
            from: email.from,
            subject: email.subject,
            preview: email.textBody?.substring(0, 200) || email.subject,
          });
        } catch (pushErr) {
          console.error(`[Push] Failed to send push to user ${userId}:`, pushErr);
        }
      }
    }
  }

  return { stored, notified, recipients: accounts.length };
}

/**
 * Apply keyword-based AI labels to a newly stored inbound message.
 * Fetches all AI-enabled labels with keywords for the account and checks
 * for case-insensitive keyword matches in subject, sender, and body.
 */
async function applyKeywordLabels(
  tenantDb: Awaited<ReturnType<typeof getTenantDbForWorkspaceById>>,
  accountId: string,
  messageId: string,
  email: ParsedEmail,
): Promise<void> {
  const { mailLabels, mailMessages } = tenantSchema;

  // Get AI-enabled labels with keywords
  const aiLabels = await tenantDb
    .select()
    .from(mailLabels)
    .where(
      and(
        eq(mailLabels.accountId, accountId),
        eq(mailLabels.aiEnabled, true),
        isNull(mailLabels.deletedAt)
      )
    );

  if (aiLabels.length === 0) return;

  const senderEmail = email.from?.email || '';
  const senderName = email.from?.name || '';
  const subject = email.subject || '';
  const textBody = (email.textBody || '').substring(0, 500);
  const searchText = `${subject} ${senderEmail} ${senderName} ${textBody}`.toLowerCase();

  const matchedLabelNames: string[] = [];
  const matchedLabelIds: string[] = [];

  for (const label of aiLabels) {
    const keywords = label.aiKeywords as string[] | null;
    if (!keywords || keywords.length === 0) continue;

    const matched = keywords.some((kw: string) =>
      searchText.includes(kw.toLowerCase())
    );

    if (matched) {
      matchedLabelNames.push(label.name);
      matchedLabelIds.push(label.id);
    }
  }

  if (matchedLabelNames.length === 0) return;

  // Update message labels (add matched labels alongside INBOX)
  const [message] = await tenantDb
    .select({ labels: mailMessages.labels })
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);

  const currentLabels = (message?.labels as string[]) || ['INBOX'];
  const newLabels = [...new Set([...currentLabels, ...matchedLabelNames])];

  await tenantDb
    .update(mailMessages)
    .set({ labels: newLabels, updatedAt: new Date() })
    .where(eq(mailMessages.id, messageId));

  // Increment messageCount on matched labels
  for (const labelId of matchedLabelIds) {
    await tenantDb
      .update(mailLabels)
      .set({
        messageCount: sql`${mailLabels.messageCount} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(mailLabels.id, labelId));
  }

  console.log(`[Store] Applied keyword labels [${matchedLabelNames.join(', ')}] to message ${messageId}`);
}

// ============================================================================
// AI Semantic Classification + Rule Execution
// ============================================================================

/**
 * AI is currently unavailable. Previously ran a semantic classification
 * prompt through the shared AI provider; keyword labels already ran before
 * this is called, so skipping it is not fatal — callers already tolerate a
 * `null` return (see `classifyAndRunRules` below).
 */
async function callAiClassifier(
  _env: Env,
  _ctx: {
    workspaceId: string;
    agentId: string;
    userId: string;
    tenantDb: unknown;
  },
  _messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  _opts: { temperature?: number; maxTokens?: number } = {},
): Promise<string | null> {
  console.warn('[ai] AI is currently unavailable — skipping mail-inbound semantic classification');
  return null;
}

/**
 * Run AI semantic classification + mail rules on a newly stored inbound message.
 * Called after keyword labels have been applied.
 *
 * Phase 1: AI classification for labels that have aiDescription (but weren't keyword-matched)
 * Phase 2: Execute user-defined mail rules
 */
async function classifyAndRunRules(
  env: Env,
  account: RecipientAccount,
  messageId: string,
  email: ParsedEmail,
): Promise<void> {
  const tenantDb = await getTenantDbForWorkspaceById(env, account.workspaceId);
  const { mailMessages, mailLabels, mailRules } = tenantSchema;

  // ---- Phase 1: AI Semantic Classification ----

  // Get AI-enabled labels with descriptions
  const aiLabels = await tenantDb
    .select()
    .from(mailLabels)
    .where(
      and(
        eq(mailLabels.accountId, account.accountId),
        eq(mailLabels.aiEnabled, true),
        isNull(mailLabels.deletedAt)
      )
    );

  // Get the current message labels (may have keyword labels already)
  const [message] = await tenantDb
    .select()
    .from(mailMessages)
    .where(eq(mailMessages.id, messageId))
    .limit(1);

  if (!message) return;

  const currentLabels = (message.labels as string[]) || [];
  const candidates = aiLabels.filter(
    (l) => l.aiDescription && !currentLabels.includes(l.name)
  );

  if (candidates.length > 0) {
    try {
      const senderEmail = email.from?.email || '';
      const senderName = email.from?.name || '';
      const subject = email.subject || '';
      const emailPreview = (email.textBody || '').substring(0, 1000);

      const labelDescriptions = candidates
        .map(
          (l, i) =>
            `${i + 1}. "${l.name}" (threshold: ${l.aiConfidence ?? 70}%) — ${l.aiDescription}`
        )
        .join('\n');

      const prompt = `You are an email classifier. Determine which labels apply to this email.

Email:
- Subject: ${subject}
- From: ${senderName} <${senderEmail}>
- Preview: ${emailPreview}

Labels to evaluate:
${labelDescriptions}

Return JSON: { "labels": [{ "name": "label name", "confidence": 85 }] }
Only include labels where confidence >= the label's threshold.
If no labels match, return { "labels": [] }.`;

      const agentId = 'system';
      const aiContent = await callAiClassifier(
        env,
        {
          workspaceId: account.workspaceId,
          agentId,
          userId: account.members[0]?.userId ?? 'system',
          tenantDb,
        },
        [
          { role: 'system', content: 'You are an email classifier. Always respond with valid JSON.' },
          { role: 'user', content: prompt },
        ],
      );

      if (aiContent) {
        const response = JSON.parse(aiContent);
        const matchedLabels: string[] = [];

        for (const match of response.labels || []) {
          const candidate = candidates.find(
            (l) => l.name.toLowerCase() === match.name?.toLowerCase()
          );
          if (candidate) {
            const threshold = candidate.aiConfidence ?? 70;
            if ((match.confidence ?? 0) >= threshold) {
              matchedLabels.push(candidate.name);
            }
          }
        }

        if (matchedLabels.length > 0) {
          // Re-read to get fresh labels
          const [fresh] = await tenantDb
            .select({ labels: mailMessages.labels })
            .from(mailMessages)
            .where(eq(mailMessages.id, messageId))
            .limit(1);

          const freshLabels = (fresh?.labels as string[]) || [];
          const newLabels = [...new Set([...freshLabels, ...matchedLabels])];

          await tenantDb
            .update(mailMessages)
            .set({ labels: newLabels, updatedAt: new Date() })
            .where(eq(mailMessages.id, messageId));

          for (const label of candidates.filter((l) => matchedLabels.includes(l.name))) {
            await tenantDb
              .update(mailLabels)
              .set({
                messageCount: sql`${mailLabels.messageCount} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(mailLabels.id, label.id));
          }

          console.log(`[Store] Applied AI labels [${matchedLabels.join(', ')}] to message ${messageId}`);
        }
      }
    } catch (aiErr) {
      console.error(`[Store] AI classification failed for ${messageId}:`, aiErr);
    }
  }

  // ---- Phase 2: Mail Rules ----

  try {
    // Re-read message with latest labels
    const [updatedMessage] = await tenantDb
      .select()
      .from(mailMessages)
      .where(eq(mailMessages.id, messageId))
      .limit(1);

    if (!updatedMessage) return;

    const rules = await tenantDb
      .select()
      .from(mailRules)
      .where(
        and(
          eq(mailRules.accountId, account.accountId),
          eq(mailRules.isActive, true),
          isNull(mailRules.deletedAt)
        )
      )
      .orderBy(desc(mailRules.priority));

    if (rules.length === 0) return;

    for (const rule of rules) {
      // Check scope (inbound emails only match 'incoming' or 'all')
      if (rule.scope === 'outgoing') continue;

      // Check folder restrictions
      const folders = rule.folders as string[] | null;
      if (folders && folders.length > 0) {
        const msgLabels = (updatedMessage.labels as string[]) || [];
        if (!folders.some((f: string) => msgLabels.includes(f))) continue;
      }

      // Evaluate conditions
      const conditions = (rule.conditions || []) as Array<{ field: string; operator: string; value: string }>;
      const matchType = (rule.matchType as string) || 'all';

      if (conditions.length === 0) continue;

      const matched = matchType === 'all'
        ? conditions.every((c) => evalRuleCondition(updatedMessage, c))
        : conditions.some((c) => evalRuleCondition(updatedMessage, c));

      if (!matched) continue;

      // Execute actions
      const actions = (rule.actions || []) as Array<{ type: string; labelId?: string; value?: string }>;
      let actionsApplied = 0;

      for (const action of actions) {
        try {
          const applied = await executeRuleAction(tenantDb, messageId, action);
          if (applied) actionsApplied++;
        } catch (actionErr) {
          console.error(`[Rules] Action ${action.type} failed:`, actionErr);
        }
      }

      if (actionsApplied > 0) {
        await tenantDb
          .update(mailRules)
          .set({
            appliedCount: sql`${mailRules.appliedCount} + 1`,
            lastAppliedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(mailRules.id, rule.id));

        console.log(`[Rules] Applied rule "${rule.name}" (${actionsApplied} actions) to ${messageId}`);

        if (rule.stopProcessing) break;
      }
    }
  } catch (ruleErr) {
    console.error(`[Rules] Rule execution failed for ${messageId}:`, ruleErr);
  }
}

/** Evaluate a single rule condition against a message */
function evalRuleCondition(
  message: any,
  condition: { field: string; operator: string; value: string },
): boolean {
  let fieldValue: any;
  switch (condition.field) {
    case 'from': {
      const from = message.from as { email?: string } | null;
      fieldValue = from?.email || '';
      break;
    }
    case 'to': {
      const to = message.to as Array<{ email?: string }> | null;
      fieldValue = to?.map((t: any) => t.email).join(', ') || '';
      break;
    }
    case 'cc': {
      const cc = message.cc as Array<{ email?: string }> | null;
      fieldValue = cc?.map((c: any) => c.email).join(', ') || '';
      break;
    }
    case 'subject':
      fieldValue = message.subject || '';
      break;
    case 'body':
      fieldValue = message.textBody || message.htmlBody || '';
      break;
    case 'has_attachment':
      fieldValue = message.hasAttachments;
      break;
    case 'size':
      fieldValue = message.sizeBytes || 0;
      break;
    case 'is_spam':
      fieldValue = message.isSpam;
      break;
    case 'priority':
      fieldValue = message.priority || 'normal';
      break;
    default:
      return false;
  }

  const v = condition.value;
  switch (condition.operator) {
    case 'contains':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().includes(v.toLowerCase());
    case 'not_contains':
      return typeof fieldValue === 'string' && !fieldValue.toLowerCase().includes(v.toLowerCase());
    case 'equals':
      return typeof fieldValue === 'string' ? fieldValue.toLowerCase() === v.toLowerCase() : String(fieldValue) === v;
    case 'not_equals':
      return typeof fieldValue === 'string' ? fieldValue.toLowerCase() !== v.toLowerCase() : String(fieldValue) !== v;
    case 'starts_with':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().startsWith(v.toLowerCase());
    case 'ends_with':
      return typeof fieldValue === 'string' && fieldValue.toLowerCase().endsWith(v.toLowerCase());
    case 'greater_than':
      return !isNaN(Number(fieldValue)) && !isNaN(Number(v)) && Number(fieldValue) > Number(v);
    case 'less_than':
      return !isNaN(Number(fieldValue)) && !isNaN(Number(v)) && Number(fieldValue) < Number(v);
    case 'is_true':
      return fieldValue === true || fieldValue === 'true';
    case 'is_false':
      return fieldValue === false || fieldValue === 'false';
    default:
      return false;
  }
}

/** Execute a single rule action using Drizzle */
async function executeRuleAction(
  tenantDb: Awaited<ReturnType<typeof getTenantDbForWorkspaceById>>,
  messageId: string,
  action: { type: string; labelId?: string; value?: string },
): Promise<boolean> {
  const { mailMessages } = tenantSchema;

  switch (action.type) {
    case 'move_to_folder': {
      if (!action.labelId) return false;
      const [msg] = await tenantDb.select({ labels: mailMessages.labels }).from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
      if (!msg) return false;
      const cur = (msg.labels as string[]) || [];
      const nl = [...new Set([...cur.filter((l: string) => l !== 'INBOX'), action.labelId])];
      await tenantDb.update(mailMessages).set({ labels: nl, updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      return true;
    }
    case 'delete':
      await tenantDb.update(mailMessages).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      return true;
    case 'mark_as_read':
      await tenantDb.update(mailMessages).set({ isRead: true, updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      return true;
    case 'mark_as_unread':
      await tenantDb.update(mailMessages).set({ isRead: false, updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      return true;
    case 'star': {
      const [msg] = await tenantDb.select({ labels: mailMessages.labels }).from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
      if (!msg) return false;
      const cur = (msg.labels as string[]) || [];
      if (!cur.includes('STARRED')) {
        await tenantDb.update(mailMessages).set({ labels: [...cur, 'STARRED'], updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      }
      return true;
    }
    case 'add_label': {
      if (!action.labelId) return false;
      const [msg] = await tenantDb.select({ labels: mailMessages.labels }).from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
      if (!msg) return false;
      const cur = (msg.labels as string[]) || [];
      if (!cur.includes(action.labelId)) {
        await tenantDb.update(mailMessages).set({ labels: [...cur, action.labelId], updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      }
      return true;
    }
    case 'remove_label': {
      if (!action.labelId) return false;
      const [msg] = await tenantDb.select({ labels: mailMessages.labels }).from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
      if (!msg) return false;
      const cur = (msg.labels as string[]) || [];
      await tenantDb.update(mailMessages).set({ labels: cur.filter((l: string) => l !== action.labelId), updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      return true;
    }
    case 'flag':
      await tenantDb.update(mailMessages).set({ isFlagged: true, updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      return true;
    case 'archive': {
      const [msg] = await tenantDb.select({ labels: mailMessages.labels }).from(mailMessages).where(eq(mailMessages.id, messageId)).limit(1);
      if (!msg) return false;
      const cur = (msg.labels as string[]) || [];
      const nl = [...new Set([...cur.filter((l: string) => l !== 'INBOX'), 'ARCHIVE'])];
      await tenantDb.update(mailMessages).set({ labels: nl, updatedAt: new Date() }).where(eq(mailMessages.id, messageId));
      return true;
    }
    default:
      return false;
  }
}

/**
 * Store parsed attachments: upload to R2 and create DB records.
 * Accepts ParsedAttachment[] from the MIME parser (postal-mime).
 * Returns a map of contentId → downloadUrl for inline CID rewriting.
 */
async function storeInboundAttachments(
  env: Env,
  workspaceId: string,
  dbMessageId: string,
  attachments: ParsedAttachment[],
): Promise<Map<string, string>> {
  const cidMap = new Map<string, string>();
  const tenantDb = await getTenantDbForWorkspaceById(env, workspaceId);
  const r2PublicUrl = env.R2_PUBLIC_URL || '';

  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i]!;

    try {
      const contentType = att.contentType || 'application/octet-stream';

      // Build R2 key: workspaces/{workspaceId}/mail/attachments/{messageId}/{filename}
      const sanitizedName = att.fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const r2Key = `workspaces/${workspaceId}/mail/attachments/${dbMessageId}/${i + 1}_${sanitizedName}`;

      // Upload to R2
      await env.STORAGE.put(r2Key, att.content, {
        httpMetadata: { contentType },
      });

      const downloadUrl = r2PublicUrl ? `${r2PublicUrl}/${r2Key}` : '';
      const attachId = generateId('attach');

      // Create DB record
      await tenantDb.insert(tenantSchema.mailAttachments).values({
        id: attachId,
        messageId: dbMessageId,
        fileName: att.fileName,
        contentType,
        size: att.content.length,
        storagePath: r2Key,
        downloadUrl,
        isInline: att.disposition === 'inline',
      });

      // Track CID → URL mapping for inline image rewriting
      if (att.contentId && downloadUrl) {
        // Strip angle brackets from contentId if present (e.g. "<image001>" → "image001")
        const cid = att.contentId.replace(/^</, '').replace(/>$/, '');
        cidMap.set(cid, downloadUrl);
      }

      console.log(`[Store] Saved attachment ${attachId} (${att.fileName}, ${att.content.length} bytes) → ${r2Key}`);
    } catch (attErr) {
      console.error(`[Store] Failed to store attachment ${i + 1} (${att.fileName}):`, attErr);
    }
  }

  return cidMap;
}

/**
 * Guess MIME type from file extension
 */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    csv: 'text/csv',
    txt: 'text/plain',
    html: 'text/html',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    zip: 'application/zip',
    gz: 'application/gzip',
    json: 'application/json',
    xml: 'application/xml',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    eml: 'message/rfc822',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Generate a simple ID with prefix (mirrors api-worker pattern)
 */
function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${prefix}_${timestamp}${random}`;
}

/**
 * Normalize email subject by stripping Re:/Fwd:/Fw: prefixes
 */
function normalizeSubject(subject: string): string {
  return subject.replace(/^(Re|Fwd|Fw):\s*/gi, '').trim();
}

/**
 * Generate a conversation number (simple counter-based)
 */
function generateConversationNumber(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `E-${ts}${rand}`;
}

/**
 * Process inbound email for helpdesk conversations.
 * Helpdesk inbox emails are registered in mailAccountRegistry with accountId starting with 'helpdesk_'.
 * Creates or updates helpdesk conversations based on email threading.
 */
export async function processHelpdeskInboxEmail(
  env: Env,
  email: ParsedEmail,
): Promise<{ processed: boolean; conversationIds: string[] }> {
  const recipientEmails = collectRecipientEmails(email);

  const masterDb = getMasterDb(env);

  // Find helpdesk inbox registrations (dedicated helpdesk_ entries).
  // Joined with workspaces so we can carry the Clerk org id through to the
  // realtime publish (WorkspaceHub DO is keyed by clerkOrgId).
  const inboxAccounts = await masterDb
    .select({
      email: masterSchema.mailAccountRegistry.email,
      accountId: masterSchema.mailAccountRegistry.accountId,
      workspaceId: masterSchema.mailAccountRegistry.workspaceId,
      clerkOrgId: masterSchema.workspaces.clerkOrgId,
    })
    .from(masterSchema.mailAccountRegistry)
    .innerJoin(
      masterSchema.workspaces,
      eq(masterSchema.workspaces.id, masterSchema.mailAccountRegistry.workspaceId),
    )
    .where(
      and(
        inArray(masterSchema.mailAccountRegistry.email, recipientEmails),
        eq(masterSchema.mailAccountRegistry.isActive, true),
      )
    );

  // Collect helpdesk-specific registry entries
  const helpdeskInboxes: Array<{ email: string; accountId: string; workspaceId: string; clerkOrgId: string | null }> =
    inboxAccounts.filter(a => a.accountId.startsWith('helpdesk_'));

  // Also check for mail accounts with helpdeskEnabled metadata
  // For each registered email (non-helpdesk), check tenant DB
  const nonHelpdeskAccounts = inboxAccounts.filter(a => !a.accountId.startsWith('helpdesk_') && !a.accountId.startsWith('acct_inbox_'));
  const seenEmails = new Set(helpdeskInboxes.map(h => h.email));

  for (const reg of nonHelpdeskAccounts) {
    if (seenEmails.has(reg.email)) continue;
    try {
      const tenantDb = await getTenantDbForWorkspaceById(env, reg.workspaceId);
      const flagged = await tenantDb
        .select({ id: tenantSchema.mailAccounts.id })
        .from(tenantSchema.mailAccounts)
        .where(
          and(
            eq(tenantSchema.mailAccounts.email, reg.email),
            eq(tenantSchema.mailAccounts.status, 'active'),
            isNull(tenantSchema.mailAccounts.deletedAt),
            sql`${tenantSchema.mailAccounts.metadata}->>'helpdeskEnabled' = 'true'`
          )
        )
        .limit(1);

      if (flagged.length > 0) {
        helpdeskInboxes.push({
          email: reg.email,
          accountId: `helpdesk_mail_${flagged[0].id}`,
          workspaceId: reg.workspaceId,
          clerkOrgId: reg.clerkOrgId,
        });
        seenEmails.add(reg.email);
      }
    } catch (err) {
      console.error(`[HelpdeskInbox] Failed to check helpdeskEnabled for ${reg.email}:`, err);
    }
  }

  if (helpdeskInboxes.length === 0) {
    return { processed: false, conversationIds: [] };
  }

  const conversationIds: string[] = [];

  for (const inbox of helpdeskInboxes) {
    try {
      const tenantDb = await getTenantDbForWorkspaceById(env, inbox.workspaceId);
      const { helpdeskConversations, helpdeskConversationMessages } = tenantSchema;

      // Try to find existing conversation by email threading
      let existingConversation: typeof helpdeskConversations.$inferSelect | null = null;

      // 1. Match by email threading headers (In-Reply-To / References)
      const lookupIds = [
        ...(email.inReplyTo ? [email.inReplyTo] : []),
        ...(email.references || []),
      ];

      if (lookupIds.length > 0) {
        // Search conversations where lastEmailMessageId matches one of the references
        for (const refId of lookupIds) {
          const matches = await tenantDb
            .select()
            .from(helpdeskConversations)
            .where(
              and(
                isNull(helpdeskConversations.deletedAt),
                eq(helpdeskConversations.channel, 'email'),
                sql`${helpdeskConversations.metadata}->>'lastEmailMessageId' = ${refId}`
              )
            )
            .limit(1);

          if (matches.length > 0) {
            existingConversation = matches[0];
            console.log(`[HelpdeskInbox] Found conversation ${existingConversation.id} by Message-ID reference`);
            break;
          }
        }

        // Also check emailThreadMessageId (root of thread)
        if (!existingConversation) {
          for (const refId of lookupIds) {
            const matches = await tenantDb
              .select()
              .from(helpdeskConversations)
              .where(
                and(
                  isNull(helpdeskConversations.deletedAt),
                  eq(helpdeskConversations.channel, 'email'),
                  sql`${helpdeskConversations.metadata}->>'emailThreadMessageId' = ${refId}`
                )
              )
              .limit(1);

            if (matches.length > 0) {
              existingConversation = matches[0];
              console.log(`[HelpdeskInbox] Found conversation ${existingConversation.id} by thread root Message-ID`);
              break;
            }
          }
        }
      }

      // 2. Fallback: match by customerEmail + normalized subject
      if (!existingConversation) {
        const normalized = normalizeSubject(email.subject);
        if (normalized) {
          const subjectMatches = await tenantDb
            .select()
            .from(helpdeskConversations)
            .where(
              and(
                isNull(helpdeskConversations.deletedAt),
                eq(helpdeskConversations.channel, 'email'),
                eq(helpdeskConversations.customerEmail, email.from.email.toLowerCase()),
                eq(helpdeskConversations.subject, normalized),
                // Only match recent conversations (not ancient ones with same subject)
                sql`${helpdeskConversations.lastMessageAt} > NOW() - INTERVAL '30 days'`
              )
            )
            .orderBy(desc(helpdeskConversations.lastMessageAt))
            .limit(1);

          if (subjectMatches.length > 0) {
            existingConversation = subjectMatches[0];
            console.log(`[HelpdeskInbox] Found conversation ${existingConversation.id} by subject+email fallback`);
          }
        }
      }

      const now = new Date();
      const messageId = generateId('msg');

      if (existingConversation) {
        // Add message to existing conversation
        await tenantDb.insert(helpdeskConversationMessages).values({
          id: messageId,
          conversationId: existingConversation.id,
          authorId: null,
          authorName: email.from.name || email.from.email,
          authorEmail: email.from.email,
          authorType: 'customer',
          content: email.textBody || email.htmlBody || '',
          htmlContent: email.htmlBody,
          plainContent: email.textBody,
          type: 'message',
          isPublic: true,
          isInternal: false,
          status: 'sent',
          isRead: false,
          hasAttachments: email.hasAttachments,
          metadata: {
            emailMessageId: email.messageId,
            emailFrom: email.from.email,
            emailTo: email.to.map(t => t.email),
            emailCc: email.cc.map(t => t.email),
            emailSubject: email.subject,
          },
          createdAt: now,
          updatedAt: now,
        });

        // Update conversation
        const existingMetadata = (existingConversation.metadata as Record<string, unknown>) || {};
        const existingRefs = (existingMetadata.emailReferences as string[]) || [];
        const updatedReferences = [...existingRefs, email.messageId].slice(-50);

        await tenantDb
          .update(helpdeskConversations)
          .set({
            lastMessage: (email.textBody || email.subject).substring(0, 500),
            lastMessageAt: now,
            lastCustomerMessageAt: now,
            messageCount: sql`${helpdeskConversations.messageCount} + 1`,
            unreadCount: sql`COALESCE(${helpdeskConversations.unreadCount}, 0) + 1`,
            isRead: false,
            status: existingConversation.status === 'resolved' || existingConversation.status === 'closed'
              ? 'active'
              : existingConversation.status,
            metadata: {
              ...existingMetadata,
              lastEmailMessageId: email.messageId,
              emailReferences: updatedReferences,
            },
            updatedAt: now,
          })
          .where(eq(helpdeskConversations.id, existingConversation.id));

        conversationIds.push(existingConversation.id);
        console.log(`[HelpdeskInbox] Added message to conversation ${existingConversation.id}`);

        // Publish workspace-wide message notification so inbox lists update
        try {
          if (!inbox.clerkOrgId) {
            console.warn(`[HelpdeskInbox] Workspace ${inbox.workspaceId} has no clerkOrgId — skipping realtime publish`);
          } else {
            await publishWorkspaceMessageNew(env, inbox.clerkOrgId, {
              conversationId: existingConversation.id,
              preview: (email.textBody || email.htmlBody || '').substring(0, 200),
              senderName: email.from.name || email.from.email,
              timestamp: now.toISOString(),
            });
          }
        } catch (notifyErr) {
          console.error(`[HelpdeskInbox] Failed to publish message notification:`, notifyErr);
        }
      } else {
        // Create new conversation
        const conversationId = generateId('conv');
        const conversationNumber = generateConversationNumber();
        const normalizedSubject = normalizeSubject(email.subject) || email.subject;

        await tenantDb.insert(helpdeskConversations).values({
          id: conversationId,
          conversationNumber,
          customerName: email.from.name || email.from.email,
          customerEmail: email.from.email.toLowerCase(),
          subject: normalizedSubject,
          preview: (email.textBody || email.subject).substring(0, 200),
          lastMessage: (email.textBody || email.subject).substring(0, 500),
          status: 'active',
          priority: 'medium',
          channel: 'email',
          source: 'email',
          messageCount: 1,
          unreadCount: 1,
          lastMessageAt: now,
          lastCustomerMessageAt: now,
          isRead: false,
          isStarred: false,
          isArchived: false,
          hasAttachments: email.hasAttachments,
          metadata: {
            emailThreadMessageId: email.messageId,
            emailReferences: [email.messageId],
            helpdeskEmailAddress: inbox.email,
            lastEmailMessageId: email.messageId,
          },
          createdAt: now,
          updatedAt: now,
        });

        // Create first message
        await tenantDb.insert(helpdeskConversationMessages).values({
          id: messageId,
          conversationId,
          authorId: null,
          authorName: email.from.name || email.from.email,
          authorEmail: email.from.email,
          authorType: 'customer',
          content: email.textBody || email.htmlBody || '',
          htmlContent: email.htmlBody,
          plainContent: email.textBody,
          type: 'message',
          isPublic: true,
          isInternal: false,
          status: 'sent',
          isRead: false,
          hasAttachments: email.hasAttachments,
          metadata: {
            emailMessageId: email.messageId,
            emailFrom: email.from.email,
            emailTo: email.to.map(t => t.email),
            emailCc: email.cc.map(t => t.email),
            emailSubject: email.subject,
          },
          createdAt: now,
          updatedAt: now,
        });

        conversationIds.push(conversationId);
        console.log(`[HelpdeskInbox] Created new conversation ${conversationId} from email`);

        // Publish new conversation event to workspace (all agents)
        try {
          if (!inbox.clerkOrgId) {
            console.warn(`[HelpdeskInbox] Workspace ${inbox.workspaceId} has no clerkOrgId — skipping realtime publish`);
          } else {
            await publishNewConversation(env, inbox.clerkOrgId, {
              id: conversationId,
              conversationId,
              conversationNumber,
              subject: normalizedSubject,
              customerName: email.from.name || email.from.email,
              customerEmail: email.from.email,
              preview: (email.textBody || email.subject).substring(0, 200),
              channel: 'email',
              status: 'active',
              createdAt: now.toISOString(),
              lastMessageAt: now.toISOString(),
            });
          }
        } catch (notifyErr) {
          console.error(`[HelpdeskInbox] Failed to publish new conversation event:`, notifyErr);
        }
      }
      // Upsert sender + cc addresses as shared contacts so helpdesk customers
      // get the same default-avatar treatment that mail and CRM contacts do.
      try {
        await upsertContactsFromMailMessage(env, inbox.workspaceId, inbox.clerkOrgId ?? null, {
          from: email.from,
          to: email.to,
          cc: email.cc,
        });
      } catch (contactErr) {
        console.error(
          `[HelpdeskInbox] Contact upsert failed for workspace ${inbox.workspaceId}:`,
          contactErr,
        );
      }
    } catch (err) {
      console.error(`[HelpdeskInbox] Failed to process for workspace ${inbox.workspaceId}:`, err);
    }
  }

  return { processed: conversationIds.length > 0, conversationIds };
}

/**
 * Check if any recipient email is an accounting inbox.
 * Accounting inbox emails are registered in mailAccountRegistry with accountId starting with 'acct_inbox_'.
 */
export async function processAccountingInboxEmail(
  env: Env,
  email: ParsedEmail,
  attachments: ParsedAttachment[],
): Promise<{ processed: boolean; documentIds: string[] }> {
  const recipientEmails = collectRecipientEmails(email);

  const masterDb = getMasterDb(env);

  // Find accounting inbox registrations
  const inboxAccounts = await masterDb
    .select({
      email: masterSchema.mailAccountRegistry.email,
      accountId: masterSchema.mailAccountRegistry.accountId,
      workspaceId: masterSchema.mailAccountRegistry.workspaceId,
    })
    .from(masterSchema.mailAccountRegistry)
    .where(
      and(
        inArray(masterSchema.mailAccountRegistry.email, recipientEmails),
        eq(masterSchema.mailAccountRegistry.isActive, true),
      )
    );

  // Filter to only accounting inbox accounts (accountId starts with 'acct_inbox_')
  const accountingInboxes = inboxAccounts.filter(a => a.accountId.startsWith('acct_inbox_'));

  if (accountingInboxes.length === 0) {
    return { processed: false, documentIds: [] };
  }

  const documentIds: string[] = [];

  for (const inbox of accountingInboxes) {
    try {
      const tenantDb = await getTenantDbForWorkspaceById(env, inbox.workspaceId);

      // Process parsed attachments
      for (const att of attachments) {
        const mimeType = att.contentType || 'application/octet-stream';

        // Only process PDFs and images
        const isProcessable = mimeType.startsWith('image/') || mimeType === 'application/pdf';
        if (!isProcessable) continue;

        // Store in R2 (if STORAGE binding available)
        const fileKey = `workspaces/${inbox.workspaceId}/accounting/inbox/${email.emailId}/${att.fileName}`;

        try {
          if ((env as any).STORAGE) {
            await (env as any).STORAGE.put(fileKey, att.content, {
              httpMetadata: { contentType: mimeType },
            });
          }
        } catch (uploadErr) {
          console.error(`[AccountingInbox] Failed to upload attachment ${att.fileName}:`, uploadErr);
          continue;
        }

        // Create accounting document record
        const docId = `doc_${nanoid()}`;
        await tenantDb.insert(tenantSchema.documents).values({
          id: docId,
          type: mimeType === 'application/pdf' ? 'purchase_invoice' : 'receipt',
          fileName: att.fileName,
          originalFileName: att.fileName,
          fileKey,
          fileSize: att.content.length,
          mimeType,
          source: 'email',
          status: 'pending',
          emailFrom: email.from.email,
          emailSubject: email.subject,
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        documentIds.push(docId);
        console.log(`[AccountingInbox] Created document ${docId} from email attachment ${att.fileName}`);
      }

      // If no attachments but email has HTML/text body, still create a document record
      // for the email itself (some invoices come as inline HTML)
      if (attachments.length === 0 && email.htmlBody) {
        const docId = `doc_${nanoid()}`;
        await tenantDb.insert(tenantSchema.documents).values({
          id: docId,
          type: 'purchase_invoice',
          fileName: `email-${email.emailId}.html`,
          originalFileName: `${email.subject || 'email'}.html`,
          fileKey: `workspaces/${inbox.workspaceId}/accounting/inbox/${email.emailId}/email.html`,
          mimeType: 'text/html',
          source: 'email',
          status: 'pending',
          emailFrom: email.from.email,
          emailSubject: email.subject,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        documentIds.push(docId);
      }
    } catch (err) {
      console.error(`[AccountingInbox] Failed to process for workspace ${inbox.workspaceId}:`, err);
    }
  }

  return { processed: documentIds.length > 0, documentIds };
}
