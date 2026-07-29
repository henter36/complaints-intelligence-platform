import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).optional(),
  AUTH_SECRET: z.string().min(1).optional(),
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD_HASH: z.string().min(1).optional(),
  SESSION_TTL_HOURS: z.coerce.number().positive().optional(),
  IMPORT_MAX_FILE_SIZE_MB: z.coerce.number().positive().optional(),
  IMPORT_MAX_ROWS: z.coerce.number().int().positive().optional(),
  IMPORT_MAX_COLUMNS: z.coerce.number().int().positive().optional(),
  IMPORT_MAX_SHEETS: z.coerce.number().int().positive().optional(),
  IMPORT_STORAGE_PATH: z.string().min(1).optional(),
  IMPORT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  NEXTAUTH_URL: z.string().url().optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

const databaseUrl = parsed.data.DATABASE_URL ?? "file:./dev.db";

const isProductionRuntime =
  parsed.data.NODE_ENV === "production" && process.env.NEXT_PHASE !== "phase-production-build";

if (isProductionRuntime && !parsed.data.DATABASE_URL) {
  throw new Error("DATABASE_URL is required in production.");
}

if (isProductionRuntime) {
  if (!parsed.data.AUTH_SECRET || parsed.data.AUTH_SECRET.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters in production.");
  }
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  databaseUrl,
  authSecret: parsed.data.AUTH_SECRET,
  adminUsername: parsed.data.ADMIN_USERNAME ?? "admin",
  adminPasswordHash: parsed.data.ADMIN_PASSWORD_HASH,
  sessionTtlHours: parsed.data.SESSION_TTL_HOURS ?? 8,
  importMaxFileSizeMb: parsed.data.IMPORT_MAX_FILE_SIZE_MB ?? 10,
  importMaxRows: parsed.data.IMPORT_MAX_ROWS ?? 10_000,
  importMaxColumns: parsed.data.IMPORT_MAX_COLUMNS ?? 100,
  importMaxSheets: parsed.data.IMPORT_MAX_SHEETS ?? 5,
  importStoragePath: parsed.data.IMPORT_STORAGE_PATH ?? "./storage/imports",
  importRetentionDays: parsed.data.IMPORT_RETENTION_DAYS ?? 30,
  nextAuthUrl: parsed.data.NEXTAUTH_URL,
  openAiApiKey: parsed.data.OPENAI_API_KEY,
};
