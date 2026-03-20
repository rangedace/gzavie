import { Player } from 'discord-player';
import { YoutubeiExtractor } from 'discord-player-youtubei';
import type { Client } from 'discord.js';

import { config } from '../config.js';
import type { MusicMetadata } from './types.js';

export async function createMusicPlayer(client: Client): Promise<Player> {
  const player = new Player(client, {
    ffmpegPath: config.FFMPEG_PATH,
    connectionTimeout: 30_000
  });

  await player.extractors.register(YoutubeiExtractor, {
    useYoutubeDL: true,
    logLevel: 'LOW'
  });

  player.events.on('playerStart', async (queue, track) => {
    await queue.metadata?.channel.send(
      `Lecture: **${track.cleanTitle}**${track.author ? ` par **${track.author}**` : ''}`
    );
  });

  player.events.on('debug', (queue, message) => {
    console.log(`[queue:${queue.guild.id}] ${message}`);
  });

  player.events.on('connection', (queue) => {
    const dispatcher = queue.dispatcher;
    if (!dispatcher) {
      return;
    }

    dispatcher.on('debug', (message) => {
      console.log(`[dispatcher:${queue.guild.id}] ${message}`);
    });

    dispatcher.voiceConnection.on('debug', (message) => {
      console.log(`[voice:${queue.guild.id}] ${message}`);
    });

    dispatcher.voiceConnection.on('stateChange', (oldState, newState) => {
      console.log(
        `[voice:${queue.guild.id}] state ${oldState.status} -> ${newState.status}`
      );
    });

    dispatcher.voiceConnection.on('error', (error) => {
      console.error(`[voice:${queue.guild.id}] error`, error);
    });
  });

  player.events.on('audioTrackAdd', async (queue, track) => {
    if (queue.isPlaying()) {
      await queue.metadata?.channel.send(`Ajouté à la file: **${track.cleanTitle}**`);
    }
  });

  player.events.on('disconnect', async (queue) => {
    await queue.metadata?.channel.send('Déconnecté du salon vocal.');
  });

  player.events.on('emptyChannel', async (queue) => {
    await queue.metadata?.channel.send('Plus personne dans le vocal, je quitte.');
  });

  player.events.on('error', async (queue, error) => {
    console.error(`Queue error in guild ${queue.guild.id}`, error);
    await queue.metadata?.channel.send(`Erreur de file: ${error.message}`);
  });

  player.events.on('playerError', async (queue, error, track) => {
    console.error(`Player error in guild ${queue.guild.id}`, error);
    await queue.metadata?.channel.send(
      `Erreur pendant la lecture de **${track.cleanTitle}**: ${error.message}`
    );
  });

  return player;
}

export function getQueueSummary(queue: {
  currentTrack: { cleanTitle: string } | null;
  tracks: { size: number };
}): string {
  const current = queue.currentTrack ? `en cours: **${queue.currentTrack.cleanTitle}**` : 'rien en cours';
  return `${current}, ${queue.tracks.size} morceau(x) en attente`;
}

export type { MusicMetadata };
