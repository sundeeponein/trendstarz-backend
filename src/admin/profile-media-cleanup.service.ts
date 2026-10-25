import { Injectable, Logger } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { Cron } from "@nestjs/schedule";
import { Connection, Model } from "mongoose";
import { CloudinaryService } from "../cloudinary.service";
import { SingleInstance } from "../utils/single-instance";

/** Only these folders are swept: per-account profile media. */
export const PROFILE_MEDIA_PREFIXES = ["influencers/", "photographers/", "brands/"];
export const PROFILE_MEDIA_PATTERN =
  /^(influencers|photographers)\/[a-f0-9]{24}\/(profile|gallery)\/|^brands\/[a-f0-9]{24}\/(logo|products)\//;
/** A file must be this old before it can go (an edit may still be in progress). */
export const PROFILE_MEDIA_MIN_AGE_DAYS = 7;
/** More than this many in one night means something looks wrong: stop and report. */
export const PROFILE_MEDIA_MAX_DELETES_PER_RUN = 300;

const stripExt = (s: string) => s.replace(/\.[a-z0-9]{2,5}$/i, "");

/** public_id from a Cloudinary delivery URL (skips transformations and the version). */
export function publicIdFromCloudinaryUrl(url: string): string | null {
  const i = url.indexOf("/upload/");
  if (i < 0) return null;
  const segs = url.slice(i + 8).split(/[?#]/)[0].split("/");
  while (
    segs.length > 1 &&
    (segs[0].includes(",") || /^[a-z]{1,2}_/.test(segs[0]) || /^v\d+$/.test(segs[0]))
  ) {
    segs.shift();
  }
  try {
    return stripExt(decodeURIComponent(segs.join("/")));
  } catch {
    return stripExt(segs.join("/"));
  }
}

/**
 * Every way the database could mention a media file: exact ids, ids parsed
 * from URLs, and bare file names. Scans every string in every collection, so a
 * file copied anywhere (campaign, submission, log) counts as in use.
 * Same rules as cron/cloudinaryOrphans.js.
 */
export class MediaReferences {
  readonly exact = new Set<string>();
  readonly names = new Set<string>();
  documents = 0;

  add(value: string) {
    const v = value.trim();
    if (!v || v.length > 2048) return;
    this.exact.add(v);
    this.exact.add(stripExt(v));
    if (v.includes("/upload/")) {
      const id = publicIdFromCloudinaryUrl(v);
      if (id) {
        this.exact.add(id);
        this.names.add(id.split("/").pop() as string);
      }
    }
    if (/^[\w\-/.]+$/.test(v) && v.length < 300) {
      this.names.add(stripExt(v.split("/").pop() as string));
    }
  }

  walk(value: any, depth = 0) {
    if (depth > 20 || value == null) return;
    if (typeof value === "string") return this.add(value);
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, depth + 1);
      return;
    }
    if (typeof value === "object" && !(value instanceof Date) && !value._bsontype) {
      for (const key of Object.keys(value)) this.walk(value[key], depth + 1);
    }
  }

  isUsed(publicId: string): boolean {
    return this.exact.has(publicId) || this.names.has(publicId.split("/").pop() as string);
  }
}

@Injectable()
export class ProfileMediaCleanupService {
  private readonly logger = new Logger(ProfileMediaCleanupService.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  async collectReferences(): Promise<MediaReferences> {
    const refs = new MediaReferences();
    const db = this.connection.db as any;
    const collections = await db.listCollections({}, { nameOnly: true }).toArray();
    for (const { name, type } of collections) {
      if (type === "view" || String(name).startsWith("system.")) continue;
      for await (const doc of db.collection(name).find({})) {
        refs.walk(doc);
        refs.documents += 1;
      }
    }
    return refs;
  }

  async runCleanupNow(triggeredBy = "system", dryRun = false) {
    const settings: any = (await this.appSettingsModel.findOne({}).lean()) || {};
    if (settings.profileMediaCleanupEnabled === false && !dryRun) {
      return { success: true, skipped: true, reason: "disabled" };
    }
    if (!this.cloudinaryService.isEnabled()) {
      return { success: true, skipped: true, reason: "cloudinary_disabled" };
    }

    const cutoff = new Date(Date.now() - PROFILE_MEDIA_MIN_AGE_DAYS * 24 * 3600 * 1000);
    // Read the database BEFORE listing files: anything uploaded and saved in
    // between is newer than the cutoff anyway.
    const refs = await this.collectReferences();
    if (refs.documents === 0) {
      return this.finish(triggeredBy, dryRun, 0, "skipped: database scan found nothing");
    }

    let seen = 0;
    const unused: string[] = [];
    for (const prefix of PROFILE_MEDIA_PREFIXES) {
      const old = await this.cloudinaryService.listResourcesOlderThan(prefix, cutoff, "image");
      for (const asset of old) {
        if (!PROFILE_MEDIA_PATTERN.test(asset.public_id)) continue;
        seen += 1;
        if (!refs.isUsed(asset.public_id)) unused.push(asset.public_id);
      }
    }

    if (unused.length > PROFILE_MEDIA_MAX_DELETES_PER_RUN || (seen > 20 && unused.length > seen / 2)) {
      const note = `stopped: ${unused.length} of ${seen} files looked unused — check with cron/cloudinaryOrphans.js`;
      this.logger.warn(`[ProfileMediaCleanup] ${note}`);
      return this.finish(triggeredBy, dryRun, 0, note, unused.slice(0, 20));
    }
    if (dryRun) {
      return this.finish(triggeredBy, true, 0, `would delete ${unused.length} of ${seen}`, unused);
    }

    let deleted = 0;
    for (const publicId of unused) {
      try {
        const result = await this.cloudinaryService.deleteImage(publicId);
        if (result?.result === "ok") deleted += 1;
      } catch (err: any) {
        this.logger.error(`[ProfileMediaCleanup] Failed to delete ${publicId}`, err?.message || String(err));
      }
    }
    return this.finish(triggeredBy, false, deleted, `deleted ${deleted} of ${unused.length} unused (${seen} checked)`);
  }

  private async finish(triggeredBy: string, dryRun: boolean, deleted: number, note: string, sample: string[] = []) {
    if (!dryRun) {
      await this.appSettingsModel.findOneAndUpdate(
        {},
        {
          $set: {
            profileMediaCleanupLastRunAt: new Date(),
            profileMediaCleanupLastRunCount: deleted,
            profileMediaCleanupLastRunNote: `${note} (${triggeredBy})`,
          },
        },
        { upsert: true },
      );
      this.logger.log(`[ProfileMediaCleanup] ${note}`);
    }
    return { success: true, dryRun, deleted, note, sample };
  }

  // 03:30 server time, away from the 06:00 pending-upload cleanup.
  @Cron("30 3 * * *", { timeZone: "Asia/Kolkata" })
  @SingleInstance()
  async runScheduledCleanup() {
    try {
      await this.runCleanupNow("system_cron");
    } catch (err: any) {
      this.logger.error("[ProfileMediaCleanup] Cron failed", err?.stack || err?.message || String(err));
    }
  }
}
