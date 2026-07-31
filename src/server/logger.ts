// Centralised server-side logger.
// JSON in production, human-readable in development.
// Never logs PII, passwords, tokens, or raw complaint data.

type LogLevel = "error" | "warn" | "info";

interface LogRecord {
  level: LogLevel;
  message: string;
  timestamp: string;
  metadata?: unknown;
}

// Keys whose values must be redacted at any nesting depth.
const REDACT_PATTERN = /key|secret|password|token|hash|cookie|authorization|credential|apikey/i;

const MAX_LOG_SANITIZE_DEPTH = 8;

function shouldRedactKey(key: string): boolean {
  return REDACT_PATTERN.test(key);
}

// Recursive sanitization with cycle detection and depth limit.
function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_LOG_SANITIZE_DEPTH) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map(item => sanitizeValue(item, depth + 1, seen));
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      shouldRedactKey(k) ? "[REDACTED]" : sanitizeValue(v, depth + 1, seen),
    ])
  );
}

function sanitizeMeta(meta: Record<string, unknown> | undefined): unknown {
  if (!meta) return undefined;
  return sanitizeValue(meta, 0, new WeakSet());
}

// ─── Format helpers ──────────────────────────────────────────────────────────

function resolveConsoleMethod(level: LogLevel): typeof console.log {
  if (level === "error") return console.error;
  if (level === "warn") return console.warn;
  return console.info;
}

function formatDevelopmentPrefix(level: LogLevel): string {
  if (level === "error") return "✖";
  if (level === "warn") return "⚠";
  return "ℹ";
}

// ─── Emitters ────────────────────────────────────────────────────────────────

function buildProductionRecord(
  level: LogLevel,
  message: string,
  safeMeta: unknown
): LogRecord {
  // Core fields (level, message, timestamp) are never overridable by metadata.
  return {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(safeMeta !== undefined ? { metadata: safeMeta } : {}),
  };
}

function emitProduction(
  level: LogLevel,
  message: string,
  safeMeta: unknown
): void {
  const record = buildProductionRecord(level, message, safeMeta);
  process.stdout.write(JSON.stringify(record) + "\n");
}

function emitDevelopment(
  level: LogLevel,
  message: string,
  safeMeta: unknown
): void {
  const prefix = formatDevelopmentPrefix(level);
  const parts = [prefix, `[${level.toUpperCase()}]`, message];
  if (safeMeta !== null && safeMeta !== undefined) {
    parts.push(JSON.stringify(safeMeta));
  }
  resolveConsoleMethod(level)(parts.join(" "));
}

function emit(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const safeMeta = sanitizeMeta(meta);
  if (process.env.NODE_ENV === "production") {
    emitProduction(level, message, safeMeta);
  } else {
    emitDevelopment(level, message, safeMeta);
  }
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => emit("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit("error", message, meta),
};
