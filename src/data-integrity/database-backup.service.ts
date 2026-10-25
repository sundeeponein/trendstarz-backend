import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import type { Connection } from "mongoose";
import { createCipheriv, randomBytes } from "crypto";
import { gzipSync } from "zlib";
import { EJSON } from "bson";
import { v2 as cloudinary } from "cloudinary";
import { SingleInstance } from "../utils/single-instance";
import { sendAppEmail } from "../utils/app-email.service";

/** Log of backup runs (status, size, file) — Data health reads the latest. */
export const BACKUP_LOG = "database_backups";
/** Private Cloudinary folder (type "authenticated": no public URL). */
export const BACKUP_FOLDER = "system/db-backups";
export const BACKUP_KEEP_DAYS = 14;
/** Always keep at least this many, even if older (e.g. after a long outage). */
export const BACKUP_KEEP_MIN = 3;

const MAGIC = Buffer.from("TSBK1");

/** Same format as cron/lib/backup-crypto.js (cron/restoreDatabase.js reads it). */
export function encryptBackup(plain: Buffer, hexKey: string): Buffer {
  const key = Buffer.from(String(hexKey || "").trim(), "hex");
  if (key.length !== 32) {
    throw new Error("BACKUP_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32).");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

/** Cloudinary's own reason (the SDK's "unexpected status code" hides it). */
export function describeCloudinaryError(err: any): string {
  const inner = err?.error || err;
  const code = inner?.http_code || err?.http_code;
  const msg = inner?.message || err?.message || String(err);
  return code ? `${msg} (HTTP ${code})` : msg;
}

/**
 * Nightly, automatic copy of the whole database — the free Atlas plan has no
 * backups. Same content as cron/exportDatabase.js, encrypted, stored as a
 * private Cloudinary file; the last 14 days are kept. To restore: download it
 * from Admin → Data health, then run cron/restoreDatabase.js with
 * BACKUP_ENCRYPTION_KEY set.
 */
@Injectable()
export class DatabaseBackupService {
  private readonly logger = new Logger(DatabaseBackupService.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  static configured(): boolean {
    return (
      /^[0-9a-f]{64}$/i.test(String(process.env.BACKUP_ENCRYPTION_KEY || "").trim()) &&
      !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
    );
  }

  private cloud() {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    return cloudinary;
  }

  /** Every collection + its indexes as canonical EJSON, gzipped (exportDatabase.js format). */
  async buildExport(): Promise<{ gz: Buffer; records: number; collections: number; exportedAt: string }> {
    const db: any = this.connection.db;
    const names = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map((c: any) => c.name)
      .filter((n: string) => !n.startsWith("system."))
      .sort();
    const out: any = { database: db.databaseName, exportedAt: new Date().toISOString(), collections: {}, indexes: {} };
    let records = 0;
    for (const name of names) {
      const docs = await db.collection(name).find({}).toArray();
      out.collections[name] = docs;
      out.indexes[name] = await db.collection(name).indexes();
      records += docs.length;
    }
    const gz = gzipSync(Buffer.from(EJSON.stringify(out, { relaxed: false }), "utf8"));
    return { gz, records, collections: names.length, exportedAt: out.exportedAt };
  }

  async runBackup(trigger: "nightly" | "admin") {
    const log: any = (this.connection.db as any).collection(BACKUP_LOG);
    const startedAt = new Date();
    if (!DatabaseBackupService.configured()) {
      await log.insertOne({ at: startedAt, trigger, status: "not_configured" });
      throw new BadRequestException("Backups are off: set BACKUP_ENCRYPTION_KEY (and Cloudinary) in Railway.");
    }
    try {
      const { gz, records, collections, exportedAt } = await this.buildExport();
      const enc = encryptBackup(gz, String(process.env.BACKUP_ENCRYPTION_KEY));
      const publicId = `trendstarz-${exportedAt.replace(/[:.]/g, "-")}.json.gz.enc`;
      const uploaded: any = await this.uploadPrivate(enc, publicId);
      const removedOld = await this.pruneOld().catch((err) => {
        this.logger.warn(`Backup pruning failed: ${err?.message || err}`);
        return 0;
      });
      const row = { at: startedAt, trigger, status: "ok", records, collections, bytes: enc.length, publicId: uploaded.public_id, deliveryType: uploaded.deliveryType, removedOld };
      await log.insertOne(row);
      this.logger.log(`Database backup ok: ${records} records, ${(enc.length / 1024).toFixed(0)} KB`);
      return { success: true, data: row };
    } catch (err: any) {
      const probe = await this.probeCloudinary().catch(() => "");
      const message = `${describeCloudinaryError(err)}${probe ? ` — Cloudinary allows: ${probe}` : ""}`.slice(0, 500);
      await log.insertOne({ at: startedAt, trigger, status: "failed", error: message });
      this.logger.error(`Database backup failed: ${message}`);
      const to = process.env.ADMIN_EMAIL;
      if (to && trigger === "nightly") {
        sendAppEmail({
          to,
          subject: "TrendStarZ: nightly database backup FAILED",
          text: `Tonight's database backup failed: ${message}\n\nOpen Admin → Data health and press "Back up now" once it's fixed.`,
        }).catch(() => undefined);
      }
      throw new BadRequestException(`Backup failed: ${message}`);
    }
  }

  /**
   * On failure: which kinds of upload this Cloudinary account accepts (tiny test
   * files, deleted straight away) — tells which account setting blocks backups.
   */
  async probeCloudinary(): Promise<string> {
    const c = this.cloud();
    const pixel = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    const bytes = "data:text/plain;base64," + Buffer.from("probe").toString("base64");
    const combos: Array<[string, string, string, string]> = [
      ["raw/upload", bytes, "raw", "upload"],
      ["raw/authenticated", bytes, "raw", "authenticated"],
      ["raw/private", bytes, "raw", "private"],
      ["image/authenticated", pixel, "image", "authenticated"],
      ["image/upload", pixel, "image", "upload"],
    ];
    const out: string[] = [];
    for (const [label, file, resource_type, type] of combos) {
      try {
        const r: any = await c.uploader.upload(file, {
          resource_type,
          type,
          folder: `${BACKUP_FOLDER}/probe`,
          public_id: `probe-${Date.now()}-${label.replace("/", "-")}`,
        } as any);
        out.push(`${label} ok`);
        await c.uploader.destroy(r.public_id, { resource_type, type } as any).catch(() => undefined);
      } catch (e: any) {
        out.push(`${label} ${e?.error?.http_code || e?.http_code || "no"}`);
      }
    }
    return out.join(", ");
  }

  /** Binary upload as a private raw file; "authenticated" first, then "private". */
  private async uploadPrivate(file: Buffer, publicId: string): Promise<any> {
    const attempt = (type: "authenticated" | "private") =>
      new Promise<any>((resolve, reject) => {
        const stream = this.cloud().uploader.upload_stream(
          { resource_type: "raw", type, folder: BACKUP_FOLDER, public_id: publicId, overwrite: false },
          (err: any, result: any) => (err ? reject(err) : resolve({ ...result, deliveryType: type })),
        );
        stream.end(file);
      });
    try {
      return await attempt("authenticated");
    } catch (err: any) {
      const code = Number(err?.http_code || err?.error?.http_code || 0);
      if (code !== 401 && code !== 403) throw err;
      this.logger.warn(`Backup upload as "authenticated" refused (${code}: ${describeCloudinaryError(err)}); trying "private"`);
      return attempt("private");
    }
  }

  /** Keeps the last BACKUP_KEEP_DAYS days, and never fewer than BACKUP_KEEP_MIN files. */
  async pruneOld(now = new Date()): Promise<number> {
    const files = await this.listFiles();
    const cutoff = now.getTime() - BACKUP_KEEP_DAYS * 24 * 3600 * 1000;
    const old = files.slice(BACKUP_KEEP_MIN).filter((f) => new Date(f.created_at).getTime() < cutoff);
    if (!old.length) return 0;
    for (const type of ["authenticated", "private"]) {
      const ids = old.filter((f: any) => (f.type || "authenticated") === type).map((f) => f.public_id);
      if (ids.length) await this.cloud().api.delete_resources(ids, { resource_type: "raw", type });
    }
    return old.length;
  }

  /** Stored backup files, newest first. */
  async listFiles(): Promise<Array<{ public_id: string; created_at: string; bytes: number; type: string }>> {
    const all: any[] = [];
    for (const type of ["authenticated", "private"]) {
      const res: any = await this.cloud()
        .api.resources({ resource_type: "raw", type, prefix: `${BACKUP_FOLDER}/`, max_results: 100 })
        .catch(() => ({ resources: [] }));
      for (const r of res?.resources || []) all.push({ public_id: r.public_id, created_at: r.created_at, bytes: r.bytes, type });
    }
    return all.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  /** Admin page: the latest runs and stored files, with 10-minute download links. */
  async overview() {
    const log: any = (this.connection.db as any).collection(BACKUP_LOG);
    const runs = await log.find({}).sort({ at: -1 }).limit(10).toArray();
    let files: any[] = [];
    if (DatabaseBackupService.configured()) {
      const c = this.cloud();
      files = (await this.listFiles().catch(() => [])).map((f) => ({
        ...f,
        name: f.public_id.split("/").pop(),
        downloadUrl: c.utils.private_download_url(f.public_id, "", {
          resource_type: "raw",
          type: (f as any).type || "authenticated",
          expires_at: Math.floor(Date.now() / 1000) + 600,
        } as any),
      }));
    }
    return { success: true, data: { configured: DatabaseBackupService.configured(), runs, files } };
  }

  // 04:15 IST: after the nightly checks (02:45) and the media cleanup (03:30).
  @Cron("15 4 * * *", { timeZone: "Asia/Kolkata", name: "databaseBackupNightly" })
  @SingleInstance()
  async nightly() {
    if (!DatabaseBackupService.configured()) return;
    await this.runBackup("nightly").catch(() => undefined);
  }
}
