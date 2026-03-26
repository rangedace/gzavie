import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type {
  GuildMember,
  Message,
  MessageCreateOptions,
  Snowflake,
  TextBasedChannel,
  VoiceBasedChannel
} from 'discord.js';
import type { ChildProcess } from 'node:child_process';

export type BotTextChannel = TextBasedChannel & {
  send(options: string | MessageCreateOptions): Promise<Message>;
};

export interface QueuedTrack {
  author: string;
  durationMs: number;
  requestedById: Snowflake;
  thumbnail: string | null;
  title: string;
  url: string;
}

export interface GuildPlaybackSession {
  audioPlayer: AudioPlayer;
  connection: VoiceConnection;
  controlMessage: Message | null;
  currentProcesses: ChildProcess[];
  currentTrack: QueuedTrack | null;
  guildId: Snowflake;
  history: QueuedTrack[];
  isTransitioning: boolean;
  queue: QueuedTrack[];
  textChannel: BotTextChannel;
  voiceChannel: VoiceBasedChannel;
}

export interface PlayContext {
  member: GuildMember;
  query: string;
  textChannel: BotTextChannel;
}
