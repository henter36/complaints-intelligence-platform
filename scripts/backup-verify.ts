#!/usr/bin/env tsx
// Verifies a backup by checking manifest and SHA-256 checksums.
// The backup path must remain inside the configured backups root.
// Never logs absolute paths, DATABASE_URL, checksums, or secret-like values.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const backupArg = process.argv[2];
if (!backupArg) {
  console.error("Usage: tsx scripts/backup-verify.ts <backup-path>");
  process.exit(1);
}

const ROOT = path.resolve(__dirname, "..");
const BACKUPS_ROOT = path.resolve(ROOT, process.env.BACKUP_PATH ?? "./backups");
const MAX_MANIFEST_SIZE = 10 * 1024 * 1024; // 10 MB

interface BackupManifest {
  readonly version: string;
  readonly checksums: Record<string, string>;
  readonly createdAt: string;
  readonly backupName: string;
}

interface VerificationResult {
  readonly ok: number;
  readonly errors: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Safe display — never leak absolute paths or secret-looking values
// ──────────────────────────────────────────────────────────────────────────────

function safeDisplayName(filePath: string): string {
  return path.basename(filePath);
}

function backupDisplayName(p: string): string {
  return path.basename(p);
}

function sanitizeVerificationError(err: unknown): string {
  if (!(err instanceof Error)) return "Unknown verification error";
  const dbUrl = process.env.DATABASE_URL ?? "";
  const dbPath = dbUrl.startsWith("file:") ? dbUrl.slice("file:".length) : "";
  let msg = err.message;
  if (dbUrl) msg = msg.replaceAll(dbUrl, "<database-url>");
  if (dbPath && dbPath !== dbUrl) msg = msg.replaceAll(dbPath, "<database>");
  msg = msg
    .replaceAll(BACKUPS_ROOT, "<backups>")
    .replaceAll(ROOT, "<project>");
  msg = msg.replace(/\b[a-f0-9]{64}\b/gi, "<checksum>");
  return msg;
}

// ──────────────────────────────────────────────────────────────────────────────
// Path resolution
// ──────────────────────────────────────────────────────────────────────────────

function resolveVerifiedBackupPath(input: string): string {
  const canonicalRoot = fs.existsSync(BACKUPS_ROOT)
    ? fs.realpathSync(BACKUPS_ROOT)
    : BACKUPS_ROOT;
  const rawCandidate = path.resolve(canonicalRoot, input);
  let candidate: string;
  try {
    candidate = fs.realpathSync(rawCandidate);
  } catch {
    throw new Error("Backup directory not found");
  }
  const rel = path.relative(canonicalRoot, candidate);
  if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return candidate;
  }
  throw new Error("Backup path must remain inside the configured backup directory");
}

// ──────────────────────────────────────────────────────────────────────────────
// Manifest loading
// ──────────────────────────────────────────────────────────────────────────────

function loadBackupManifest(manifestPath: string): BackupManifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error("manifest.json not found — backup may be corrupt");
  }
  const stat = fs.statSync(manifestPath);
  if (stat.size > MAX_MANIFEST_SIZE) {
    throw new Error("manifest.json exceeds maximum allowed size");
  }
  return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
}

// ──────────────────────────────────────────────────────────────────────────────
// Checksum verification
// ──────────────────────────────────────────────────────────────────────────────

function computeSha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyManifestEntry(
  verifiedPath: string,
  relPath: string,
  expectedHash: string
): string | null {
  const normalized = path.normalize(relPath);

  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return `SECURITY: path traversal in manifest entry`;
  }

  const fullPath = path.join(verifiedPath, normalized);
  const fileRel = path.relative(verifiedPath, fullPath);
  if (fileRel.startsWith("..") || path.isAbsolute(fileRel)) {
    return `SECURITY: manifest entry escapes backup directory`;
  }

  if (!fs.existsSync(fullPath)) {
    return `MISSING: ${safeDisplayName(normalized)}`;
  }

  const stat = fs.lstatSync(fullPath);
  if (stat.isSymbolicLink()) {
    return `SECURITY: symlink detected: ${safeDisplayName(normalized)}`;
  }

  if (computeSha256(fullPath) !== expectedHash) {
    return `MISMATCH: ${safeDisplayName(normalized)}`;
  }

  return null;
}

function verifyBackupContents(verifiedPath: string, manifest: BackupManifest): VerificationResult {
  let ok = 0;
  let errors = 0;

  for (const [relPath, expectedHash] of Object.entries(manifest.checksums)) {
    const errMsg = verifyManifestEntry(verifiedPath, relPath, expectedHash);
    if (errMsg) {
      console.error(errMsg);
      errors++;
    } else {
      ok++;
    }
  }

  return { ok, errors };
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

function formatVerificationSummary(result: VerificationResult): string[] {
  if (result.errors === 0) {
    return [`✓ Backup verified: ${result.ok} files OK`];
  }
  return [`✗ Backup has ${result.errors} error(s), ${result.ok} files OK`];
}

// ──────────────────────────────────────────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────────────────────────────────────────

function main() {
  let verifiedPath: string;
  try {
    verifiedPath = resolveVerifiedBackupPath(backupArg);
  } catch (err) {
    console.error(`Security: ${sanitizeVerificationError(err)}`);
    process.exit(1);
  }

  console.log("Backup verification started");
  console.log(`Backup name: ${backupDisplayName(verifiedPath)}`);

  let manifest: BackupManifest;
  try {
    manifest = loadBackupManifest(path.join(verifiedPath, "manifest.json"));
  } catch (err) {
    console.error(sanitizeVerificationError(err));
    process.exit(1);
  }

  // Log only safe metadata — never log absolute paths or checksums
  console.log(`Created: ${manifest.createdAt}`);

  const result = verifyBackupContents(verifiedPath, manifest);

  for (const line of formatVerificationSummary(result)) {
    if (result.errors === 0) {
      console.log(line);
    } else {
      console.error(line);
    }
  }

  if (result.errors > 0) {
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  console.error("Backup verification failed:", sanitizeVerificationError(err));
  process.exit(1);
}
