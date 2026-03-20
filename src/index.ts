import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel
} from 'discord.js';
import type { Player } from 'discord-player';

import { config } from './config.js';
import { registerSlashCommands } from './discord/registerCommands.js';
import { createMusicPlayer, getQueueSummary, type MusicMetadata } from './music/player.js';

function getMemberVoiceChannel(interaction: ChatInputCommandInteraction): VoiceBasedChannel | null {
  if (!(interaction.member instanceof GuildMember)) {
    return null;
  }

  return interaction.member.voice.channel;
}

function isSupportedVoiceChannel(channel: VoiceBasedChannel | null): channel is VoiceBasedChannel {
  return channel !== null && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type);
}

async function ensureQueueAccess(
  interaction: ChatInputCommandInteraction,
  player: Player
): Promise<{ queue: ReturnType<Player['nodes']['get']>; channel: VoiceBasedChannel } | null> {
  const channel = getMemberVoiceChannel(interaction);

  if (!isSupportedVoiceChannel(channel)) {
    await interaction.reply({
      content: 'Rejoins un salon vocal pour utiliser cette commande.',
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  const queue = player.nodes.get(interaction.guildId!);

  if (queue?.channel && queue.channel.id !== channel.id) {
    await interaction.reply({
      content: `Le bot est déjà actif dans **${queue.channel.name}**.`,
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  return { queue, channel };
}

async function handlePlay(interaction: ChatInputCommandInteraction, player: Player): Promise<void> {
  const access = await ensureQueueAccess(interaction, player);

  if (!access) {
    return;
  }

  const { channel } = access;
  const query = interaction.options.getString('query', true);
  const replyChannel = interaction.channel;

  if (!replyChannel) {
    await interaction.reply({
      content: 'Impossible de récupérer le salon texte pour répondre.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply();

  try {
    const { track, queue } = await player.play(channel, query, {
      requestedBy: interaction.user,
      connectionOptions: {
        daveEncryption: false,
        timeout: 120_000
      },
      nodeOptions: {
        metadata: {
          channel: replyChannel
        } satisfies MusicMetadata,
        selfDeaf: true,
        connectionTimeout: 120_000,
        leaveOnEmpty: true,
        leaveOnEmptyCooldown: 60_000,
        leaveOnEnd: true,
        leaveOnEndCooldown: 30_000,
        leaveOnStop: true,
        bufferingTimeout: 30_000
      }
    });

    queue.setMetadata({
      channel: replyChannel
    } satisfies MusicMetadata);

    await interaction.followUp(
      `Ajouté: **${track.cleanTitle}** (${getQueueSummary(queue)})`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'erreur inconnue';
    await interaction.followUp(`Impossible de jouer cette requête: ${message}`);
  }
}

async function handleSkip(interaction: ChatInputCommandInteraction, player: Player): Promise<void> {
  const access = await ensureQueueAccess(interaction, player);

  if (!access) {
    return;
  }

  const { queue } = access;

  if (!queue || !queue.currentTrack) {
    await interaction.reply({
      content: 'Aucune musique en cours.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  queue.node.skip();
  await interaction.reply(`Titre passé. ${getQueueSummary(queue)}`);
}

async function handleStop(interaction: ChatInputCommandInteraction, player: Player): Promise<void> {
  const access = await ensureQueueAccess(interaction, player);

  if (!access) {
    return;
  }

  const { queue } = access;

  if (!queue) {
    await interaction.reply({
      content: 'Aucune file active.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  queue.delete();
  await interaction.reply('Lecture arrêtée, file vidée et vocal quitté.');
}

async function bootstrap(): Promise<void> {
  await registerSlashCommands();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  const player = await createMusicPlayer(client);

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Bot connected as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) {
      return;
    }

    try {
      switch (interaction.commandName) {
        case 'play':
          await player.context.provide({ guild: interaction.guild }, () =>
            handlePlay(interaction, player)
          );
          break;
        case 'skip':
          await handleSkip(interaction, player);
          break;
        case 'stop':
          await handleStop(interaction, player);
          break;
        default:
          await interaction.reply({
            content: 'Commande non prise en charge.',
            flags: MessageFlags.Ephemeral
          });
      }
    } catch (error) {
      console.error('Interaction error', error);

      if (interaction.deferred || interaction.replied) {
        await interaction.followUp('Une erreur est survenue.');
        return;
      }

      await interaction.reply({
        content: 'Une erreur est survenue.',
        flags: MessageFlags.Ephemeral
      });
    }
  });

  await client.login(config.DISCORD_TOKEN);
}

bootstrap().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
