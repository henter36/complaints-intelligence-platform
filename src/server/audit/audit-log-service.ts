import type { Prisma } from "@prisma/client";

export const AUDIT_ACTOR_SYSTEM = "system";
export const AUDIT_ACTOR_SINGLE_ADMIN = "single-admin";

export type AuditClient = Pick<Prisma.TransactionClient, "auditLog">;

export async function writeAuditLog(
  db: AuditClient,
  input: {
    action: string;
    entityType: string;
    entityId?: string | null;
    actor?: string;
    metadata?: Prisma.InputJsonValue;
  }
) {
  return db.auditLog.create({
    data: {
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      actor: input.actor ?? AUDIT_ACTOR_SYSTEM,
      metadata: input.metadata ?? undefined,
    },
  });
}
