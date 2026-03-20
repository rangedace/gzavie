import 'dotenv/config';

import ffmpegPath from 'ffmpeg-static';
import { z } from 'zod';

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  FFMPEG_PATH: z.string().min(1).optional()
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration.');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = {
  ...parsed.data,
  FFMPEG_PATH:
    parsed.data.FFMPEG_PATH ?? (typeof ffmpegPath === 'string' ? ffmpegPath : undefined)
} as const;
