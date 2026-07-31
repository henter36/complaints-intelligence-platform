import { z } from "zod";

const PLACEHOLDER_PATTERNS = [
  "change_me",
  "your-secret",
  "replace-me",
  "placeholder",
] as const;

// Centralized: returns true when a value is absent, empty, or a placeholder.
// Matching is case-insensitive so "CHANGE_ME", "Placeholder", "YOUR-SECRET" all match.
export function isMissingOrPlaceholderSecret(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return true;
  if (normalized.startsWith("change")) return true;
  return PLACEHOLDER_PATTERNS.some(p => normalized.includes(p));
}

// Accept AI_ENABLED as true/false (any case), 1/0, or absent (defaults false)
function parseAiEnabled(raw: string | undefined): boolean {
  if (!raw || raw.trim() === "") return false;
  const lower = raw.trim().toLowerCase();
  if (lower === "true" || lower === "1") return true;
  if (lower === "false" || lower === "0") return false;
  return false;
}

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
  REPORT_STORAGE_PATH: z.string().min(1).optional(),
  REPORT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  REPORT_MAX_ROWS: z.coerce.number().int().positive().optional(),
  REPORT_MAX_FILE_SIZE_MB: z.coerce.number().positive().optional(),
  INTERNAL_SCHEDULER_SECRET: z.string().min(1).optional(),
  NEXTAUTH_URL: z.string().url().optional(),
  // AI settings — all optional; key only validated when AI_ENABLED=true
  OPENAI_API_KEY: z.string().optional(),
  AI_ENABLED: z.string().optional(),
  AI_PROVIDER: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_MAX_INPUT_COMPLAINTS: z.coerce.number().int().positive().optional(),
  AI_MAX_INPUT_CHARS: z.coerce.number().int().positive().optional(),
  AI_REQUEST_TIMEOUT_SECONDS: z.coerce.number().int().positive().optional(),
  AI_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
  AI_DAILY_RUN_LIMIT: z.coerce.number().int().positive().optional(),
  // Backup
  BACKUP_PATH: z.string().optional(),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
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

const aiEnabled = parseAiEnabled(parsed.data.AI_ENABLED);

if (isProductionRuntime) {
  if (!parsed.data.AUTH_SECRET || parsed.data.AUTH_SECRET.length < 32) {
    throw new Error("AUTH_SECRET must be at least 32 characters in production.");
  }
  if (!parsed.data.INTERNAL_SCHEDULER_SECRET || parsed.data.INTERNAL_SCHEDULER_SECRET.length < 32) {
    throw new Error("INTERNAL_SCHEDULER_SECRET must be at least 32 characters in production.");
  }
  if (aiEnabled) {
    const key = parsed.data.OPENAI_API_KEY;
    if (isMissingOrPlaceholderSecret(key)) {
      throw new Error("OPENAI_API_KEY must be a valid key when AI_ENABLED=true in production.");
    }
  }
}

// Resolved key — undefined when absent or placeholder
const resolvedAiKey = (() => {
  const k = parsed.data.OPENAI_API_KEY;
  return isMissingOrPlaceholderSecret(k) ? undefined : k;
})();

// Build the env object with openAiApiKey as a non-enumerable getter.
// This prevents JSON.stringify(env) and object spread from exposing the key.
const envBase = {
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
  reportStoragePath: parsed.data.REPORT_STORAGE_PATH ?? "./storage/reports",
  reportRetentionDays: parsed.data.REPORT_RETENTION_DAYS ?? 90,
  reportMaxRows: parsed.data.REPORT_MAX_ROWS ?? 10_000,
  reportMaxFileSizeMb: parsed.data.REPORT_MAX_FILE_SIZE_MB ?? 25,
  internalSchedulerSecret: parsed.data.INTERNAL_SCHEDULER_SECRET,
  nextAuthUrl: parsed.data.NEXTAUTH_URL,
  aiEnabled,
  aiProvider: parsed.data.AI_PROVIDER || "openai",
  aiModel: parsed.data.AI_MODEL || "gpt-4o-mini",
  aiMaxInputComplaints: parsed.data.AI_MAX_INPUT_COMPLAINTS ?? 500,
  aiMaxInputChars: parsed.data.AI_MAX_INPUT_CHARS ?? 120_000,
  aiRequestTimeoutSeconds: parsed.data.AI_REQUEST_TIMEOUT_SECONDS ?? 60,
  aiRetentionDays: parsed.data.AI_RETENTION_DAYS ?? 90,
  aiDailyRunLimit: parsed.data.AI_DAILY_RUN_LIMIT ?? 20,
  backupPath: parsed.data.BACKUP_PATH || "./backups",
  backupRetentionDays: parsed.data.BACKUP_RETENTION_DAYS ?? 30,
  // getOpenAiApiKey() — safe accessor that never appears in JSON.stringify or spread
  getOpenAiApiKey(): string | undefined { return resolvedAiKey; },
};

// Add openAiApiKey as a non-enumerable getter so it never appears in
// JSON.stringify(env) or { ...env } object spread.
export const env: typeof envBase & { readonly openAiApiKey: string | undefined } = Object.defineProperty(
  envBase,
  "openAiApiKey",
  {
    get() { return resolvedAiKey; },
    enumerable: false,
    configurable: false,
  }
) as typeof envBase & { readonly openAiApiKey: string | undefined };
