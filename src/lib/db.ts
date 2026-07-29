import { PrismaClient } from '@prisma/client'
import { env } from "@/lib/env";

process.env.DATABASE_URL = env.databaseUrl;

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
