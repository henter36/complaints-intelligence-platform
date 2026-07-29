import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  NEXTAUTH_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

const databaseUrl = parsed.data.DATABASE_URL ?? "file:./dev.db";

if (parsed.data.NODE_ENV === "production" && !parsed.data.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in production.");
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  databaseUrl,
  authSecret: parsed.data.AUTH_SECRET,
  nextAuthUrl: parsed.data.NEXTAUTH_URL,
  openAiApiKey: parsed.data.OPENAI_API_KEY,
};
