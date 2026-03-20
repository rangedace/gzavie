import { REST, Routes } from 'discord.js';

import { config } from '../config.js';
import { slashCommands } from './commands.js';

export async function registerSlashCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

  await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), {
    body: slashCommands
  });
  console.log('Registered global slash commands.');
}
