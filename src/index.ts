import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type VoiceBasedChannel
} from 'discord.js';

import { config } from './config.js';
import { registerSlashCommands } from './discord/registerCommands.js';
import { MusicPlayer } from './music/player.js';

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
  _musicPlayer: MusicPlayer
): Promise<{ channel: VoiceBasedChannel } | null> {
  const channel = getMemberVoiceChannel(interaction);

  if (!isSupportedVoiceChannel(channel)) {
    await interaction.reply({
      content: 'Rejoins un salon vocal pour utiliser cette commande.',
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  return { channel };
}

async function ensureButtonAccess(interaction: ButtonInteraction): Promise<VoiceBasedChannel | null> {
  if (!interaction.inCachedGuild() || !(interaction.member instanceof GuildMember)) {
    await interaction.reply({
      content: 'Interaction invalide.',
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  const channel = interaction.member.voice.channel;

  if (!isSupportedVoiceChannel(channel)) {
    await interaction.reply({
      content: 'Rejoins un salon vocal pour utiliser ces boutons.',
      flags: MessageFlags.Ephemeral
    });
    return null;
  }

  return channel;
}

async function handlePlay(interaction: ChatInputCommandInteraction, musicPlayer: MusicPlayer): Promise<void> {
  const access = await ensureQueueAccess(interaction, musicPlayer);

  if (!access) {
    return;
  }

  const query = interaction.options.getString('query', true);
  const replyChannel = interaction.channel;

  if (!replyChannel || !('send' in replyChannel)) {
    await interaction.reply({
      content: 'Impossible de récupérer le salon texte pour répondre.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.deferReply();

  try {
    if (!(interaction.member instanceof GuildMember)) {
      throw new Error('Membre introuvable dans le serveur.');
    }

    const { added } = await musicPlayer.enqueue({
      member: interaction.member,
      query,
      textChannel: replyChannel
    });

    if (added.length === 1) {
      const track = added[0];
      if (!track) {
        throw new Error('Aucun titre résolu.');
      }
      await interaction.followUp(
        `Ajouté: **${track.title}** (${musicPlayer.getQueueSummary(interaction.guildId!)})`
      );
      return;
    }

    await interaction.followUp(
      `Ajouté ${added.length} titres (${musicPlayer.getQueueSummary(interaction.guildId!)})`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'erreur inconnue';
    await interaction.followUp(`Impossible de jouer cette requête: ${message}`);
  }
}

async function handleSkip(interaction: ChatInputCommandInteraction, musicPlayer: MusicPlayer): Promise<void> {
  const access = await ensureQueueAccess(interaction, musicPlayer);

  if (!access) {
    return;
  }

  const skipped = musicPlayer.skip(interaction.guildId!);

  if (!skipped) {
    await interaction.reply({
      content: 'Aucune musique en cours.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply(`Titre passé. ${musicPlayer.getQueueSummary(interaction.guildId!)}`);
}

async function handleStop(interaction: ChatInputCommandInteraction, musicPlayer: MusicPlayer): Promise<void> {
  const access = await ensureQueueAccess(interaction, musicPlayer);

  if (!access) {
    return;
  }

  if (!musicPlayer.stop(interaction.guildId!)) {
    await interaction.reply({
      content: 'Aucune file active.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  await interaction.reply('Lecture arrêtée, file vidée et vocal quitté.');
}

async function handleControlButton(interaction: ButtonInteraction, musicPlayer: MusicPlayer): Promise<void> {
  const parsed = musicPlayer.parseControlCustomId(interaction.customId);

  if (!parsed || parsed.guildId !== interaction.guildId) {
    await interaction.reply({
      content: 'Bouton invalide.',
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const voiceChannel = await ensureButtonAccess(interaction);

  if (!voiceChannel) {
    return;
  }

  switch (parsed.action) {
    case 'previous':
      if (!musicPlayer.previous(interaction.guildId!)) {
        await interaction.reply({
          content: 'Aucun titre précédent disponible.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      await interaction.deferUpdate();
      return;
    case 'pause': {
      const state = musicPlayer.togglePause(interaction.guildId!);
      if (!state) {
        await interaction.reply({
          content: 'Aucune lecture active.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      await interaction.deferUpdate();
      return;
    }
    case 'skip':
      if (!musicPlayer.skip(interaction.guildId!)) {
        await interaction.reply({
          content: 'Aucune musique en cours.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      await interaction.deferUpdate();
      return;
    case 'stop':
      if (!musicPlayer.stop(interaction.guildId!)) {
        await interaction.reply({
          content: 'Aucune lecture active.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      await interaction.deferUpdate();
      return;
    default:
      await interaction.reply({
        content: 'Action non prise en charge.',
        flags: MessageFlags.Ephemeral
      });
  }
}

async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  musicPlayer: MusicPlayer
): Promise<void> {
  if (interaction.commandName !== 'play') {
    await interaction.respond([]);
    return;
  }

  const focused = interaction.options.getFocused(true);

  if (focused.name !== 'query' || typeof focused.value !== 'string') {
    await interaction.respond([]);
    return;
  }

  try {
    const choices = await musicPlayer.getPlaySuggestions(focused.value);
    await interaction.respond(choices);
  } catch (error) {
    console.error('Autocomplete error', error);
    await interaction.respond([]);
  }
}

async function bootstrap(): Promise<void> {
  await registerSlashCommands();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates
    ]
  });

  const musicPlayer = new MusicPlayer();

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`Bot connected as ${readyClient.user.tag}`);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction, musicPlayer);
      return;
    }

    if (interaction.isButton()) {
      await handleControlButton(interaction, musicPlayer);
      return;
    }

    if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) {
      return;
    }

    try {
      switch (interaction.commandName) {
        case 'play':
          await handlePlay(interaction, musicPlayer);
          break;
        case 'skip':
          await handleSkip(interaction, musicPlayer);
          break;
        case 'stop':
          await handleStop(interaction, musicPlayer);
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
