import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel
} from '@discordjs/voice';
import type { Guild, VoiceBasedChannel } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Collection,
  EmbedBuilder
} from 'discord.js';
import { spawn } from 'node:child_process';
import youtubedl from 'youtube-dl-exec';

import { config } from '../config.js';
import type { GuildPlaybackSession, PlayContext, QueuedTrack } from './types.js';

const SEARCH_FORMAT = 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best';
const VOICE_READY_TIMEOUT_MS = 30_000;
const DISCONNECT_DELAY_MS = 30_000;
const CONTROL_PREFIX = 'player';
const AUTOCOMPLETE_LIMIT = 10;
const AUTOCOMPLETE_TIMEOUT_MS = 2_500;
const AUTOCOMPLETE_CACHE_TTL_MS = 60_000;

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, Math.max(1, max - 1))}…`;
}

function isIgnorablePipeError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED';
}

function toDisplaySuggestion(value: string): string {
  if (value.toLowerCase() !== value) {
    return value;
  }

  return value
    .split(/\s+/)
    .map((word) => (word.length > 0 ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word))
    .join(' ');
}

function mapTrack(entry: Record<string, unknown>, requestedById: string): QueuedTrack | null {
  const webpageUrl = typeof entry.webpage_url === 'string' ? entry.webpage_url : null;
  const title = typeof entry.title === 'string' ? entry.title : null;

  if (!webpageUrl || !title) {
    return null;
  }

  const duration = typeof entry.duration === 'number' ? entry.duration : 0;

  return {
    author:
      typeof entry.uploader === 'string'
        ? entry.uploader
        : typeof entry.channel === 'string'
          ? entry.channel
          : 'Unknown',
    durationMs: duration * 1000,
    requestedById,
    thumbnail: typeof entry.thumbnail === 'string' ? entry.thumbnail : null,
    title,
    url: webpageUrl
  };
}

async function resolveTracks(query: string, requestedById: string): Promise<QueuedTrack[]> {
  const payload = await youtubedl(query, {
    defaultSearch: isUrl(query) ? undefined : 'ytsearch1',
    dumpSingleJson: true,
    format: SEARCH_FORMAT,
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    skipDownload: true
  });

  if (typeof payload !== 'object' || payload === null) {
    throw new Error('YouTube response was empty.');
  }

  const data = payload as Record<string, unknown>;
  const entries = Array.isArray(data.entries) ? data.entries : [data];
  const tracks = entries
    .map((entry) => (typeof entry === 'object' && entry !== null ? mapTrack(entry, requestedById) : null))
    .filter((entry): entry is QueuedTrack => entry !== null);

  if (tracks.length === 0) {
    throw new Error('No playable YouTube track found.');
  }

  return tracks;
}

async function resolveTrackSuggestions(query: string): Promise<QueuedTrack[]> {
  const payload = await youtubedl(query, {
    defaultSearch: isUrl(query) ? undefined : `ytsearch${AUTOCOMPLETE_LIMIT}`,
    dumpSingleJson: true,
    flatPlaylist: true,
    format: SEARCH_FORMAT,
    callHome: false,
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    skipDownload: true
  });

  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const data = payload as Record<string, unknown>;
  const entries = Array.isArray(data.entries) ? data.entries : [data];

  return entries
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) {
        return null;
      }

      const record = entry as Record<string, unknown>;
      const title = typeof record.title === 'string' ? record.title : null;
      const webpageUrl =
        typeof record.webpage_url === 'string'
          ? record.webpage_url
          : typeof record.url === 'string' && /^https?:\/\//.test(record.url)
            ? record.url
            : typeof record.id === 'string'
              ? `https://www.youtube.com/watch?v=${record.id}`
              : null;

      if (!title || !webpageUrl) {
        return null;
      }

      const duration = typeof record.duration === 'number' ? record.duration : 0;

      return {
        author:
          typeof record.uploader === 'string'
            ? record.uploader
            : typeof record.channel === 'string'
              ? record.channel
              : 'Unknown',
        durationMs: duration * 1000,
        requestedById: 'autocomplete',
        thumbnail: typeof record.thumbnail === 'string' ? record.thumbnail : null,
        title,
        url: webpageUrl
      } satisfies QueuedTrack;
    })
    .filter((entry): entry is QueuedTrack => entry !== null)
    .slice(0, AUTOCOMPLETE_LIMIT);
}

async function resolveQuerySuggestions(query: string): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTOCOMPLETE_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(query)}`,
      {
        method: 'GET',
        signal: controller.signal
      }
    );

    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as unknown;

    if (!Array.isArray(payload) || payload.length < 2 || !Array.isArray(payload[1])) {
      return [];
    }

    return payload[1]
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .slice(0, AUTOCOMPLETE_LIMIT);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function createPlaybackProcesses(track: QueuedTrack) {
  const ytDlp = youtubedl.exec(
    track.url,
    {
      format: SEARCH_FORMAT,
      noCheckCertificates: true,
      noWarnings: true,
      output: '-',
      quiet: true
    },
    {
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );

  const ffmpeg = spawn(
    config.FFMPEG_PATH ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-analyzeduration',
      '0',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      'pipe:1'
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe']
    }
  );

  if (!ytDlp.stdout || !ytDlp.stderr || !ffmpeg.stdin) {
    throw new Error('Failed to initialize playback subprocess pipes.');
  }

  ytDlp.stdout.on('error', (error) => {
    if (!isIgnorablePipeError(error)) {
      console.error('[yt-dlp:pipe]', error);
    }
  });

  ffmpeg.stdin.on('error', (error) => {
    if (!isIgnorablePipeError(error)) {
      console.error('[ffmpeg:stdin]', error);
    }
  });

  ytDlp.on('error', (error) => {
    console.error('[yt-dlp:process]', error);
  });

  ffmpeg.on('error', (error) => {
    console.error('[ffmpeg:process]', error);
  });

  ytDlp.stdout.pipe(ffmpeg.stdin);

  return {
    ffmpeg,
    ytDlp
  };
}

export class MusicPlayer {
  private readonly sessions = new Collection<string, GuildPlaybackSession>();
  private readonly autocompleteCache = new Map<string, { choices: Array<{ name: string; value: string }>; ts: number }>();

  hasNextTrack(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    return Boolean(session && session.currentTrack && session.queue.length > 0);
  }

  async getPlaySuggestions(query: string): Promise<Array<{ name: string; value: string }>> {
    const trimmed = query.trim();

    if (trimmed.length < 3) {
      return [];
    }

    const normalized = trimmed.toLowerCase();
    const now = Date.now();
    const cached = this.autocompleteCache.get(normalized);

    if (cached && now - cached.ts <= AUTOCOMPLETE_CACHE_TTL_MS) {
      return cached.choices;
    }

    const prefixFallback = this.getPrefixFallback(normalized, now);

    const queries = await resolveQuerySuggestions(trimmed);

    if (queries.length === 0) {
      return prefixFallback;
    }

    const deduped = new Map<string, { name: string; value: string }>();

    for (const suggestion of queries) {
      if (deduped.size >= AUTOCOMPLETE_LIMIT) {
        break;
      }

      const label = truncate(toDisplaySuggestion(suggestion), 100);
      const value = truncate(suggestion, 100);

      if (!deduped.has(value)) {
        deduped.set(value, { name: label, value });
      }
    }

    const choices = [...deduped.values()];
    this.autocompleteCache.set(normalized, { choices, ts: now });
    return choices.length > 0 ? choices : prefixFallback;
  }

  private getPrefixFallback(
    normalizedQuery: string,
    now: number
  ): Array<{ name: string; value: string }> {
    let bestMatchLength = -1;
    let bestChoices: Array<{ name: string; value: string }> = [];

    for (const [key, value] of this.autocompleteCache.entries()) {
      if (now - value.ts > AUTOCOMPLETE_CACHE_TTL_MS) {
        this.autocompleteCache.delete(key);
        continue;
      }

      if (normalizedQuery.startsWith(key) && value.choices.length > 0 && key.length > bestMatchLength) {
        bestMatchLength = key.length;
        bestChoices = value.choices;
      }
    }

    return bestChoices;
  }

  async enqueue(context: PlayContext): Promise<{ added: QueuedTrack[]; current: QueuedTrack }> {
    const voiceChannel = context.member.voice.channel;

    if (!voiceChannel) {
      throw new Error('Rejoins un salon vocal pour utiliser `/play`.');
    }

    const tracks = await resolveTracks(context.query, context.member.id);
    const session = await this.getOrCreateSession(context.member.guild, voiceChannel, context.textChannel);

    if (session.voiceChannel.id !== voiceChannel.id) {
      throw new Error(`Le bot est déjà actif dans **${session.voiceChannel.name}**.`);
    }

    session.textChannel = context.textChannel;
    session.queue.push(...tracks);

    if (!session.currentTrack) {
      await this.playNext(session);
    } else {
      void this.refreshControlMessage(session);
    }

    return {
      added: tracks,
      current: session.currentTrack ?? tracks[0]!
    };
  }

  skip(guildId: string): QueuedTrack | null {
    const session = this.sessions.get(guildId);

    if (!session || !session.currentTrack || session.isTransitioning) {
      return null;
    }

    session.isTransitioning = true;
    void this.refreshControlMessage(session);
    session.audioPlayer.stop(true);
    return session.currentTrack;
  }

  previous(guildId: string): QueuedTrack | null {
    const session = this.sessions.get(guildId);

    if (!session || session.isTransitioning) {
      return null;
    }

    const previousTrack = session.history.pop() ?? null;

    if (!previousTrack) {
      return null;
    }

    if (session.currentTrack) {
      session.queue.unshift(session.currentTrack);
    }

    session.currentTrack = null;
    session.queue.unshift(previousTrack);
    session.isTransitioning = true;
    void this.refreshControlMessage(session);
    session.audioPlayer.stop(true);
    return previousTrack;
  }

  togglePause(guildId: string): 'paused' | 'resumed' | null {
    const session = this.sessions.get(guildId);

    if (!session || !session.currentTrack) {
      return null;
    }

    if (session.audioPlayer.state.status === AudioPlayerStatus.Paused) {
      session.audioPlayer.unpause();
      void this.refreshControlMessage(session);
      return 'resumed';
    }

    if (session.audioPlayer.state.status === AudioPlayerStatus.Playing) {
      session.audioPlayer.pause();
      void this.refreshControlMessage(session);
      return 'paused';
    }

    return null;
  }

  stop(guildId: string): boolean {
    const session = this.sessions.get(guildId);

    if (!session) {
      return false;
    }

    this.destroySession(session);
    return true;
  }

  getQueueSummary(guildId: string): string {
    const session = this.sessions.get(guildId);

    if (!session) {
      return 'rien en cours, 0 morceau(x) en attente';
    }

    const current = session.currentTrack
      ? `en cours: **${session.currentTrack.title}**`
      : 'rien en cours';

    return `${current}, ${session.queue.length} morceau(x) en attente`;
  }

  isPaused(guildId: string): boolean {
    const session = this.sessions.get(guildId);
    return session?.audioPlayer.state.status === AudioPlayerStatus.Paused;
  }

  private async getOrCreateSession(
    guild: Guild,
    voiceChannel: VoiceBasedChannel,
    textChannel: PlayContext['textChannel']
  ): Promise<GuildPlaybackSession> {
    const existing = this.sessions.get(guild.id);

    if (existing) {
      return existing;
    }

    const connection = joinVoiceChannel({
      adapterCreator: guild.voiceAdapterCreator,
      channelId: voiceChannel.id,
      guildId: guild.id,
      selfDeaf: true
    });

    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS);

    const audioPlayer = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    connection.subscribe(audioPlayer);

    const session: GuildPlaybackSession = {
      audioPlayer,
      connection,
      controlMessage: null,
      currentProcesses: [],
      currentTrack: null,
      guildId: guild.id,
      history: [],
      isTransitioning: false,
      queue: [],
      textChannel,
      voiceChannel
    };

    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      session.isTransitioning = false;
      void this.playNext(session);
    });

    audioPlayer.on(AudioPlayerStatus.Playing, () => {
      session.isTransitioning = false;
      void this.refreshControlMessage(session);
    });

    audioPlayer.on(AudioPlayerStatus.Paused, () => {
      void this.refreshControlMessage(session);
    });

    audioPlayer.on('error', (error) => {
      console.error(`[audio:${session.guildId}]`, error);
      void session.textChannel.send(`Erreur audio: ${error.message}`);
      void this.playNext(session);
    });

    connection.on('error', (error) => {
      console.error(`[voice:${session.guildId}]`, error);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
      } catch {
        this.destroySession(session);
      }
    });

    this.sessions.set(guild.id, session);
    return session;
  }

  private async playNext(session: GuildPlaybackSession): Promise<void> {
    this.stopCurrentProcess(session);

    const previousTrack = session.currentTrack;
    const nextTrack = session.queue.shift() ?? null;
    session.currentTrack = nextTrack;

    if (!nextTrack) {
      await this.refreshControlMessage(session);
      setTimeout(() => {
        const currentSession = this.sessions.get(session.guildId);
        if (!currentSession || currentSession.currentTrack || currentSession.queue.length > 0) {
          return;
        }

        this.destroySession(currentSession);
      }, DISCONNECT_DELAY_MS);
      return;
    }

    try {
      if (previousTrack) {
        session.history.push(previousTrack);
      }

      const { ffmpeg, ytDlp } = createPlaybackProcesses(nextTrack);
      session.currentProcesses = [ytDlp, ffmpeg];

      if (!ytDlp.stderr) {
        throw new Error('yt-dlp stderr pipe is unavailable.');
      }

      ytDlp.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.error(`[yt-dlp:${session.guildId}] ${message}`);
        }
      });

      ffmpeg.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.error(`[ffmpeg:${session.guildId}] ${message}`);
        }
      });

      ytDlp.once('close', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[yt-dlp:${session.guildId}] exited with code ${code}`);
        }
      });

      ffmpeg.once('close', (code) => {
        if (code !== 0 && code !== null) {
          console.error(`[ffmpeg:${session.guildId}] exited with code ${code}`);
        }
      });

      const resource = createAudioResource(ffmpeg.stdout, {
        inlineVolume: true,
        inputType: StreamType.Raw,
        metadata: nextTrack
      });

      resource.volume?.setVolume(0.7);
      session.audioPlayer.play(resource);

      await this.refreshControlMessage(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown playback error';
      console.error(`[playback:${session.guildId}]`, error);
      await session.textChannel.send(`Erreur de lecture: ${message}`);
      await this.playNext(session);
    }
  }

  private stopCurrentProcess(session: GuildPlaybackSession): void {
    for (const process of session.currentProcesses) {
      if (!process.killed) {
        process.kill('SIGKILL');
      }
    }
    session.currentProcesses = [];
  }

  private destroySession(session: GuildPlaybackSession): void {
    this.stopCurrentProcess(session);
    session.queue.length = 0;
    session.history.length = 0;
    session.currentTrack = null;
    session.isTransitioning = false;
    session.audioPlayer.stop(true);
    session.connection.destroy();
    this.sessions.delete(session.guildId);
    void this.refreshControlMessage(session);
  }

  private async refreshControlMessage(session: GuildPlaybackSession): Promise<void> {
    const payload = this.buildNowPlayingMessage(session);
    const components = [this.buildControls(session)];

    if (session.controlMessage) {
      try {
        await session.controlMessage.edit({
          components,
          content: payload.content,
          embeds: payload.embeds
        });
        return;
      } catch {
        session.controlMessage = null;
      }
    }

    if (!session.currentTrack) {
      return;
    }

    const sent = await session.textChannel.send({
      components,
      content: payload.content,
      embeds: payload.embeds
    });
    session.controlMessage = await sent.edit({
      components,
      content: payload.content,
      embeds: payload.embeds
    });
  }

  private buildNowPlayingMessage(session: GuildPlaybackSession): { content: string; embeds: EmbedBuilder[] } {
    if (!session.currentTrack) {
      return {
        content: '',
        embeds: []
      };
    }

    const state =
      session.audioPlayer.state.status === AudioPlayerStatus.Paused ? 'pause' : 'lecture';
    const embed = new EmbedBuilder()
      .setColor(0x2f3136)
      .setAuthor({
        name: state === 'pause' ? 'En pause' : 'Lecture en cours'
      })
      .setTitle(session.currentTrack.title)
      .setURL(session.currentTrack.url)
      .setDescription(
        `${session.currentTrack.author ? `Par **${session.currentTrack.author}**` : 'Auteur inconnu'}\nDuree: ${formatDuration(session.currentTrack.durationMs)}`
      );

    embed.addFields({
      inline: false,
      name: 'Statut',
      value: `${state} | ${session.queue.length} morceau(x) en attente`
    });

    if (session.currentTrack.thumbnail) {
      embed.setThumbnail(session.currentTrack.thumbnail);
    }

    return {
      content: '',
      embeds: [embed]
    };
  }

  private buildControls(session: GuildPlaybackSession) {
    const paused = session.audioPlayer.state.status === AudioPlayerStatus.Paused;
    const disabled = session.currentTrack === null;
    const skipDisabled = disabled || session.isTransitioning || session.queue.length === 0;

    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${CONTROL_PREFIX}:previous:${session.guildId}`)
        .setEmoji('⏮️')
        .setLabel('Precedent')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || session.isTransitioning || session.history.length === 0),
      new ButtonBuilder()
        .setCustomId(`${CONTROL_PREFIX}:pause:${session.guildId}`)
        .setEmoji(paused ? '▶️' : '⏸️')
        .setLabel(paused ? 'Reprendre' : 'Pause')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || session.isTransitioning),
      new ButtonBuilder()
        .setCustomId(`${CONTROL_PREFIX}:skip:${session.guildId}`)
        .setEmoji('⏭️')
        .setLabel('Suivant')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(skipDisabled),
      new ButtonBuilder()
        .setCustomId(`${CONTROL_PREFIX}:stop:${session.guildId}`)
        .setEmoji('⏹️')
        .setLabel('Stop')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled || session.isTransitioning)
    );
  }

  parseControlCustomId(customId: string): { action: string; guildId: string } | null {
    const [prefix, action, guildId] = customId.split(':');

    if (prefix !== CONTROL_PREFIX || !action || !guildId) {
      return null;
    }

    return { action, guildId };
  }
}
