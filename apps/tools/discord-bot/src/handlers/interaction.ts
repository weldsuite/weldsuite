/**
 * Discord INTERACTION_CREATE Handler
 *
 * Handles:
 * - Button clicks: open_ticket, close_ticket, wf_choice, wf_csat, wf_form
 * - Modal submissions: wf_form_submit (collect_input form data)
 */

import {
  Interaction,
  ButtonInteraction,
  ModalSubmitInteraction,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { eq, and, ne, isNull, sql } from 'drizzle-orm';
import { getTenantDb, schema } from '../lib/db.js';
import { resolveGuild } from '../lib/guild-cache.js';
import { generateId } from '../lib/id.js';
import { executeWorkflows, resumeWorkflow } from '../engine/executor.js';
import { publishHelpdeskEvent } from '../lib/realtime.js';

export async function handleInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isButton()) {
    const customId = interaction.customId;

    if (customId === 'open_ticket') {
      await handleOpenTicket(interaction);
    } else if (customId === 'close_ticket') {
      await handleCloseTicket(interaction);
    } else if (customId.startsWith('wf_form:')) {
      await handleFormButton(interaction);
    } else if (customId.startsWith('wf_')) {
      await handleWorkflowInteraction(interaction);
    }
  } else if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('wf_form_submit:')) {
      await handleFormSubmit(interaction);
    }
  }
}

// ============================================================================
// Form Button → Show Modal
// ============================================================================

async function handleFormButton(button: ButtonInteraction): Promise<void> {
  const guildId = button.guildId;
  if (!guildId) return;

  // Parse: wf_form:convId:stepId
  const parts = button.customId.split(':');
  if (parts.length < 3) return;

  const [, conversationId, stepId] = parts;

  try {
    const guildMapping = await resolveGuild(guildId);
    if (!guildMapping) return;

    const db = await getTenantDb(guildMapping.clerkOrgId);

    // Find the execution to get the field definitions
    const [execution] = await db
      .select({
        id: schema.helpdeskWorkflowExecutions.id,
        executionContext: schema.helpdeskWorkflowExecutions.executionContext,
      })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
          eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
        ),
      )
      .limit(1);

    // Get field definitions from the step result stored in execution context
    const execCtx = (execution?.executionContext || {}) as Record<string, unknown>;
    const stepResults = (execCtx.stepResults || {}) as Record<string, Record<string, unknown>>;
    const stepResult = stepResults[stepId] || {};
    const fields = (stepResult.fields || []) as Array<{ id: string; label: string; type?: string; required?: boolean; placeholder?: string }>;

    // If no fields found, try to get from the message metadata
    if (fields.length === 0) {
      const [msg] = await db
        .select({ metadata: schema.helpdeskConversationMessages.metadata })
        .from(schema.helpdeskConversationMessages)
        .where(
          and(
            eq(schema.helpdeskConversationMessages.conversationId, conversationId),
            sql`${schema.helpdeskConversationMessages.metadata}->>'workflowStepId' = ${stepId}`,
          ),
        )
        .limit(1);

      const msgFields = ((msg?.metadata as any)?.fields || []) as Array<{ id: string; label: string; type?: string; required?: boolean; placeholder?: string }>;
      fields.push(...msgFields);
    }

    // Build modal with text inputs (max 5 per modal)
    const modal = new ModalBuilder()
      .setCustomId(`wf_form_submit:${conversationId}:${stepId}`)
      .setTitle('Please fill in your details');

    const inputFields = fields.slice(0, 5); // Discord modals support max 5 inputs

    if (inputFields.length === 0) {
      // Fallback: single generic text input
      const input = new TextInputBuilder()
        .setCustomId('response')
        .setLabel('Your response')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    } else {
      for (const field of inputFields) {
        // Fields can be strings ("email") or objects ({ id, label, type })
        const fieldId = typeof field === 'string' ? field : (field.id || field.label || 'field');
        const fieldLabel = typeof field === 'string' ? field.charAt(0).toUpperCase() + field.slice(1) : (field.label || field.id || 'Field');
        const isLongText = typeof field !== 'string' && field.type === 'textarea';
        const isRequired = typeof field === 'string' ? true : (field.required ?? false);
        const placeholder = typeof field !== 'string' ? (field.placeholder || '') : '';

        const input = new TextInputBuilder()
          .setCustomId(fieldId)
          .setLabel(fieldLabel.slice(0, 45))
          .setStyle(isLongText ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(isRequired)
          .setPlaceholder(placeholder);

        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      }
    }

    await button.showModal(modal);
  } catch (err) {
    console.error('[Discord] Failed to show form modal:', err);
    try {
      await button.reply({ content: 'Something went wrong opening the form.', flags: ['Ephemeral'] });
    } catch {}
  }
}

// ============================================================================
// Modal Submit → Save Data
// ============================================================================

async function handleFormSubmit(modal: ModalSubmitInteraction): Promise<void> {
  await modal.deferUpdate();

  const guildId = modal.guildId;
  if (!guildId) return;

  // Parse: wf_form_submit:convId:stepId
  const parts = modal.customId.split(':');
  if (parts.length < 3) return;

  const [, conversationId, stepId] = parts;

  try {
    const guildMapping = await resolveGuild(guildId);
    if (!guildMapping) return;

    const db = await getTenantDb(guildMapping.clerkOrgId);

    // Collect all field values from the modal
    const submittedData: Record<string, string> = {};
    for (const row of modal.components) {
      for (const component of row.components) {
        if (component.customId && component.value) {
          submittedData[component.customId] = component.value;
        }
      }
    }

    // Find the waiting execution
    const [execution] = await db
      .select({ id: schema.helpdeskWorkflowExecutions.id })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
          eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
        ),
      )
      .limit(1);

    // Persist the submitted data as a customer message in the conversation
    const summary = Object.entries(submittedData)
      .map(([key, value]) => `**${key}**: ${value}`)
      .join('\n');

    const msgId = generateId('msg');
    await db.insert(schema.helpdeskConversationMessages).values({
      id: msgId,
      conversationId,
      content: summary,
      authorType: 'customer',
      authorId: `discord_${modal.user.id}`,
      authorName: modal.user.displayName || modal.user.username,
      type: 'message',
      isPublic: true,
      isInternal: false,
      status: 'sent',
      isRead: false,
      metadata: {
        formSubmission: true,
        submittedData,
        workflowStepId: stepId,
        channel: 'discord',
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Post confirmation in thread
    const channel = modal.channel;
    if (channel && 'send' in channel) {
      const confirmEmbed = new EmbedBuilder()
        .setDescription(summary)
        .setFooter({ text: 'Details submitted' })
        .setColor(0x22C55E);

      await channel.send({ embeds: [confirmEmbed] });
    }

    console.log(`[Discord] Form submitted: ${conversationId}/${stepId} → ${JSON.stringify(submittedData)}`);

    // Resume workflow execution with remaining steps
    if (execution && channel) {
      await resumeWorkflow({
        db,
        conversationId,
        workspaceId: guildMapping.clerkOrgId,
        executionId: execution.id,
        stepId,
        channelObj: channel as any,
        responseData: { submittedData },
      });
    }
  } catch (err) {
    console.error('[Discord] Failed to process form submission:', err);
  }
}

// ============================================================================
// Open Ticket
// ============================================================================

async function handleOpenTicket(button: ButtonInteraction): Promise<void> {
  await button.deferReply({ flags: ['Ephemeral'] });

  const user = button.user;
  const guildId = button.guildId;
  const channelId = button.channelId;

  if (!guildId || !channelId) {
    await button.editReply({ content: 'This command can only be used in a server.' });
    return;
  }

  try {
    // 1. Create private thread
    const channel = button.channel;
    if (!channel || !('threads' in channel)) {
      await button.editReply({ content: 'Cannot create threads in this channel.' });
      return;
    }

    const thread = await channel.threads.create({
      name: `Ticket - ${user.displayName || user.username}`.slice(0, 100),
      type: ChannelType.PrivateThread,
      invitable: false,
    });

    // 2. Add user to thread
    await thread.members.add(user.id);

    // 3. Post welcome embed with Close button
    const embed = new EmbedBuilder()
      .setTitle('Support Ticket')
      .setDescription(
        `Welcome <@${user.id}>! A support agent will be with you shortly.\n\nPlease describe your issue below.`,
      )
      .setColor(0x5865F2)
      .setTimestamp();

    const closeButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger),
    );

    await thread.send({ embeds: [embed], components: [closeButton] });

    // 4. Create conversation in DB
    const guildMapping = await resolveGuild(guildId);
    if (guildMapping) {
      const db = await getTenantDb(guildMapping.clerkOrgId);
      const now = new Date();
      const conversationId = generateId('conv');
      const conversationNumber = `CONV-${Date.now().toString(36).toUpperCase()}`;
      const customerEmail = `discord:${user.id}@discord`;
      const customerName = user.displayName || user.username;

      await db.insert(schema.helpdeskConversations).values({
        id: conversationId,
        conversationNumber,
        subject: 'Discord Ticket',
        status: 'active',
        channel: 'discord',
        customerEmail,
        customerName,
        contactId: null,
        messageCount: 0,
        unreadCount: 0,
        isRead: false,
        isStarred: false,
        isArchived: false,
        hasAttachments: false,
        hasActiveWorkflow: false,
        tags: [],
        metadata: {
          discordGuildId: guildId,
          discordChannelId: thread.id,
          discordUserId: user.id,
          discordAvatar: user.avatarURL(),
          isTicket: true,
        },
        createdAt: now,
        updatedAt: now,
      });

      console.log(`[Discord] Ticket ${conversationId} created for thread ${thread.id}`);

      // Notify platform UI
      publishHelpdeskEvent(guildMapping.clerkOrgId, 'conversation_new', {
        conversationId,
        subject: 'Discord Ticket',
        customerName,
        customerEmail,
        preview: `Ticket opened by ${customerName}`,
        channel: 'discord',
        createdAt: now.toISOString(),
      });

      // Execute conversation_created workflows
      try {
        await executeWorkflows({
          db,
          conversationId,
          workspaceId: guildMapping.clerkOrgId,
          eventType: 'conversation_created',
          channelObj: thread as any,
          triggerData: {
            conversationId,
            workspaceId: guildMapping.clerkOrgId,
            channel: 'discord',
            customerName,
            customerEmail,
            subject: 'Discord Ticket',
            timestamp: now.toISOString(),
          },
        });
      } catch (wfErr) {
        console.error('[Discord] Ticket workflow failed:', wfErr);
      }
    }

    // 5. Reply
    await button.editReply({
      content: `Your ticket has been created! Head to <#${thread.id}>`,
    });
  } catch (err) {
    console.error('[Discord] Failed to create ticket:', err);
    await button.editReply({
      content: 'Something went wrong creating your ticket. Please try again.',
    }).catch(() => {});
  }
}

// ============================================================================
// Close Ticket
// ============================================================================

async function handleCloseTicket(button: ButtonInteraction): Promise<void> {
  await button.deferReply({ flags: ['Ephemeral'] });

  const guildId = button.guildId;
  const threadId = button.channelId;

  if (!guildId || !threadId) {
    await button.editReply({ content: 'Could not identify the ticket.' });
    return;
  }

  try {
    // 1. Close conversation in DB
    const guildMapping = await resolveGuild(guildId);
    if (guildMapping) {
      const db = await getTenantDb(guildMapping.clerkOrgId);

      const [conv] = await db
        .select()
        .from(schema.helpdeskConversations)
        .where(
          and(
            eq(schema.helpdeskConversations.channel, 'discord'),
            sql`${schema.helpdeskConversations.metadata}->>'discordChannelId' = ${threadId}`,
            ne(schema.helpdeskConversations.status, 'closed'),
            isNull(schema.helpdeskConversations.deletedAt),
          ),
        )
        .limit(1);

      if (conv) {
        await db
          .update(schema.helpdeskConversations)
          .set({ status: 'closed', closedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.helpdeskConversations.id, conv.id));

        console.log(`[Discord] Ticket ${conv.id} closed for thread ${threadId}`);
      }
    }

    // 2. Send closed message in thread
    const channel = button.channel;
    if (channel && 'send' in channel) {
      await channel.send(
        'This ticket has been closed. If you need further help, please open a new ticket.',
      );
    }

    // 3. Lock and archive thread
    if (channel && 'edit' in channel) {
      await (channel as any).edit({ archived: true, locked: true });
    }

    // 4. Reply
    await button.editReply({ content: 'This ticket has been closed.' });
  } catch (err) {
    console.error('[Discord] Failed to close ticket:', err);
    await button.editReply({
      content: 'Something went wrong closing the ticket. Please try again.',
    }).catch(() => {});
  }
}

// ============================================================================
// Workflow Interactions (wf_choice, wf_csat)
// ============================================================================

async function handleWorkflowInteraction(button: ButtonInteraction): Promise<void> {
  await button.deferUpdate();

  const customId = button.customId;
  const guildId = button.guildId;

  if (!guildId) return;

  try {
    const guildMapping = await resolveGuild(guildId);
    if (!guildMapping) return;

    // Parse custom_id: wf_choice:convId:stepId:value or wf_csat:convId:stepId:rating
    const parts = customId.split(':');
    if (parts.length < 4) return;

    const [action, conversationId, stepId, value] = parts;

    const db = await getTenantDb(guildMapping.clerkOrgId);

    // Find active execution
    const [execution] = await db
      .select({ id: schema.helpdeskWorkflowExecutions.id })
      .from(schema.helpdeskWorkflowExecutions)
      .where(
        and(
          eq(schema.helpdeskWorkflowExecutions.conversationId, conversationId),
          eq(schema.helpdeskWorkflowExecutions.status, 'waiting_for_input'),
        ),
      )
      .limit(1);

    if (!execution) {
      console.warn(`[Discord] No waiting execution for conversation ${conversationId}`);
      return;
    }

    // Build response data
    const responseData: Record<string, unknown> = {};

    if (action === 'wf_choice') {
      responseData.selectedValue = value;
      responseData.selectedLabel = button.component.label || value;
    } else if (action === 'wf_csat') {
      responseData.rating = parseInt(value, 10);
    }

    console.log(`[Discord] Workflow interaction: ${action} → ${conversationId}/${stepId}/${value}`);

    // Resume workflow with remaining steps
    const channel = button.channel;
    if (channel) {
      await resumeWorkflow({
        db,
        conversationId,
        workspaceId: guildMapping.clerkOrgId,
        executionId: execution.id,
        stepId,
        channelObj: channel as any,
        responseData,
      });
    }
  } catch (err) {
    console.error('[Discord] Failed to handle workflow interaction:', err);
  }
}
