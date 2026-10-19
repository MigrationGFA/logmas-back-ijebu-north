// env.ts
import { z } from 'zod';
import dotenv from 'dotenv';
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3006'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string(),
  JWT_REFRESH_SECRET: z.string(),
  JWT_EXPIRES_IN: z.string().default('1d'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // ─── LGA identity (see src/config/lga.config.ts) ──────────────────────────
  // Optional: defaults to the built-in preset in src/config/lga.config.ts.
  // Set these when onboarding a new LGA deployment.
  LGA_ID: z.string().optional(),
  LGA_NAME: z.string().optional(),
  LGA_FULL_NAME: z.string().optional(),
  LGA_SHORT_CODE: z.string().optional(),
  LGA_ACCOUNT_PREFIX: z.string().optional(),
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment configuration variables:', parsedEnv.error.format());
  process.exit(1);
}

export default parsedEnv.data;