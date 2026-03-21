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
import { Collection } from 'discord.js';
import { spawn } from 'node:child_process';
import youtubedl from 'youtube-dl-exec';

import { config } from '../config.js';
import type { GuildPlaybackSession, PlayContext, QueuedTrack } from './types.js';

const SEARCH_FORMAT = 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best';
const VOICE_READY_TIMEOUT_MS = 30_000;
const DISCONNECT_DELAY_MS = 30_000;

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

async function resolveStreamUrl(track: QueuedTrack): Promise<string> {
  const output = await youtubedl(track.url, {
    format: SEARCH_FORMAT,
    getUrl: true,
    noCheckCertificates: true,
    noWarnings: true,
    skipDownload: true
  });

  const firstUrl = String(output)
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstUrl) {
    throw new Error(`Unable to resolve stream URL for ${track.title}.`);
  }

  return firstUrl;
}

function createFfmpegProcess(streamUrl: string) {
  return spawn(
    config.FFMPEG_PATH ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-reconnect',
      '1',
      '-reconnect_streamed',
      '1',
      '-reconnect_delay_max',
      '5',
      '-i',
      streamUrl,
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
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
}

export class MusicPlayer {
  private readonly sessions = new Collection<string, GuildPlaybackSession>();

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

    if (session.audioPlayer.state.status === AudioPlayerStatus.Idle && !session.currentTrack) {
      await this.playNext(session);
    }

    if (!session.currentTrack) {
      throw new Error('Unable to start playback.');
    }

    return {
      added: tracks,
      current: session.currentTrack
    };
  }

  skip(guildId: string): QueuedTrack | null {
    const session = this.sessions.get(guildId);

    if (!session || !session.currentTrack) {
      return null;
    }

    session.audioPlayer.stop(true);
    return session.currentTrack;
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
      currentProcess: null,
      currentTrack: null,
      guildId: guild.id,
      queue: [],
      textChannel,
      voiceChannel
    };

    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      void this.playNext(session);
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

    const nextTrack = session.queue.shift() ?? null;
    session.currentTrack = nextTrack;

    if (!nextTrack) {
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
      const streamUrl = await resolveStreamUrl(nextTrack);
      const ffmpeg = createFfmpegProcess(streamUrl);
      session.currentProcess = ffmpeg;

      ffmpeg.stderr.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          console.error(`[ffmpeg:${session.guildId}] ${message}`);
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

      await session.textChannel.send(
        `Lecture: **${nextTrack.title}**${nextTrack.author ? ` par **${nextTrack.author}**` : ''} (${formatDuration(nextTrack.durationMs)})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown playback error';
      console.error(`[playback:${session.guildId}]`, error);
      await session.textChannel.send(`Erreur de lecture: ${message}`);
      await this.playNext(session);
    }
  }

  private stopCurrentProcess(session: GuildPlaybackSession): void {
    if (session.currentProcess && !session.currentProcess.killed) {
      session.currentProcess.kill('SIGKILL');
    }
    session.currentProcess = null;
  }

  private destroySession(session: GuildPlaybackSession): void {
    this.stopCurrentProcess(session);
    session.queue.length = 0;
    session.currentTrack = null;
    session.audioPlayer.stop(true);
    session.connection.destroy();
    this.sessions.delete(session.guildId);
  }
}
