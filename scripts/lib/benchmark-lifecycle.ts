import { rmSync } from "node:fs";

export function restoreDatabaseUrl(originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env.DATABASE_URL;
    return;
  }
  process.env.DATABASE_URL = originalValue;
}

/**
 * Runs benchmark work and always disconnects Prisma before deleting tempDir.
 * Cleanup order: disconnect → restore DATABASE_URL → rmSync(tempDir).
 */
export async function withPreparedBenchmark<T>(options: {
  tempDir?: string;
  originalDatabaseUrl?: string;
  disconnect?: () => Promise<void>;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await options.run();
  } finally {
    try {
      await options.disconnect?.();
    } finally {
      restoreDatabaseUrl(options.originalDatabaseUrl);
      if (options.tempDir) {
        rmSync(options.tempDir, { recursive: true, force: true });
      }
    }
  }
}
