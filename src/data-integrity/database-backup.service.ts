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
      const uploaded: any = await this.cloud().uploader.upload(
        `data:application/octet-stream;base64,${enc.toString("base64")}`,
        { resource_type: "raw", type: "authenticated", folder: BACKUP_FOLDER, public_id: publicId, overwrite: false },
      );
      const removedOld = await this.pruneOld().catch((err) => {
        this.logger.warn(`Backup pruning failed: ${err?.message || err}`);
        return 0;
      });
      const row = { at: startedAt, trigger, status: "ok", records, collections, bytes: enc.length, publicId: uploaded.public_id, removedOld };
      await log.insertOne(row);
      this.logger.log(`Database backup ok: ${records} records, ${(enc.length / 1024).toFixed(0)} KB`);
      return { success: true, data: row };
    } catch (err: any) {
      const message = String(err?.message || err?.error?.message || err).slice(0, 300);
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

  /** Keeps the last BACKUP_KEEP_DAYS days, and never fewer than BACKUP_KEEP_MIN files. */
  async pruneOld(now = new Date()): Promise<number> {
    const files = await this.listFiles();
    const cutoff = now.getTime() - BACKUP_KEEP_DAYS * 24 * 3600 * 1000;
    const old = files.slice(BACKUP_KEEP_MIN).filter((f) => new Date(f.created_at).getTime() < cutoff);
    if (!old.length) return 0;
    await this.cloud().api.delete_resources(
      old.map((f) => f.public_id),
      { resource_type: "raw", type: "authenticated" },
    );
    return old.length;
  }

  /** Stored backup files, newest first. */
  async listFiles(): Promise<Array<{ public_id: string; created_at: string; bytes: number }>> {
    const res: any = await this.cloud().api.resources({
      resource_type: "raw",
      type: "authenticated",
      prefix: `${BACKUP_FOLDER}/`,
      max_results: 100,
    });
    return (res?.resources || [])
      .map((r: any) => ({ public_id: r.public_id, created_at: r.created_at, bytes: r.bytes }))
      .sort((a: any, b: any) => String(b.created_at).localeCompare(String(a.created_at)));
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
          type: "authenticated",
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
