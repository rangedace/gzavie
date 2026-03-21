import type { AudioPlayer, VoiceConnection } from '@discordjs/voice';
import type { GuildMember, Snowflake, TextBasedChannel, VoiceBasedChannel } from 'discord.js';
import type { ChildProcess } from 'node:child_process';

export type BotTextChannel = TextBasedChannel & {
  send(content: string): Promise<unknown>;
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
  currentProcesses: ChildProcess[];
  currentTrack: QueuedTrack | null;
  guildId: Snowflake;
  queue: QueuedTrack[];
  textChannel: BotTextChannel;
  voiceChannel: VoiceBasedChannel;
}

export interface PlayContext {
  member: GuildMember;
  query: string;
  textChannel: BotTextChannel;
}
