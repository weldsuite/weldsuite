/**
 * Slash Command Handlers
 *
 * /setup-support — Posts the support panel embed with "Open Ticket" button
 *                  in the current channel. Requires Manage Channels permission.
 */

import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';

/**
 * Slash command definitions to register with Discord.
 */
export const commands: RESTPostAPIChatInputApplicationCommandsJSONBody[] = [
  new SlashCommandBuilder()
    .setName('setup-support')
    .setDescription('Post a support panel with an "Open Ticket" button in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .toJSON(),
];

/**
 * Handle slash command interactions.
 */
export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (interaction.commandName === 'setup-support') {
    await handleSetupSupport(interaction);
  }
}

async function handleSetupSupport(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: ['Ephemeral'] });

  try {
    const embed = new EmbedBuilder()
      .setTitle('Support')
      .setDescription(
        'Need help? Click the button below to open a private support ticket.\n\n' +
        'A team member will get back to you as soon as possible.',
      )
      .setColor(0x5865F2);

    const openButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('open_ticket')
        .setLabel('Open Ticket')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎫'),
    );

    await interaction.channel?.send({
      embeds: [embed],
      components: [openButton],
    });

    await interaction.editReply({
      content: 'Support panel posted! Users can now click "Open Ticket" to create private threads.',
    });
  } catch (err) {
    console.error('[Discord] Failed to setup support panel:', err);
    await interaction.editReply({
      content: 'Failed to post the support panel. Make sure the bot has permission to send messages in this channel.',
    }).catch(() => {});
  }
}
