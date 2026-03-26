import 'dotenv/config';

import { REST, Routes } from 'discord.js';
import { z } from 'zod';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1)
});

async function main(): Promise<void> {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('Missing required environment variables for guild command cleanup.');
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }

  const { DISCORD_CLIENT_ID, DISCORD_GUILD_ID, DISCORD_TOKEN } = parsed.data;
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  await rest.put(
    Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
    {
      body: []
    }
  );

  console.log(`Removed all guild slash commands for guild ${DISCORD_GUILD_ID}.`);
}

main().catch((error) => {
  console.error('Guild command cleanup failed.', error);
  process.exit(1);
});
