import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Cron, CronExpression } from "@nestjs/schedule";
import { Model } from "mongoose";
import { CloudinaryService } from "../cloudinary.service";
import { CloudinaryFolders } from "../cloudinary-folders";

// Folders scanned for orphaned pre-registration uploads, paired with the
// Cloudinary resource type they hold. Verification docs can be PDF (raw) or
// image (jpg/png), so that folder is scanned under both resource types.
const PENDING_FOLDERS: Array<{ prefix: string; resourceType: "image" | "raw" }> = [
  { prefix: CloudinaryFolders.influencer.pendingProfile, resourceType: "image" },
  { prefix: CloudinaryFolders.influencer.pendingGallery, resourceType: "image" },
  { prefix: CloudinaryFolders.influencer.pendingVerification, resourceType: "image" },
  { prefix: CloudinaryFolders.influencer.pendingVerification, resourceType: "raw" },
  { prefix: CloudinaryFolders.brand.pendingLogo, resourceType: "image" },
  { prefix: CloudinaryFolders.brand.pendingProducts, resourceType: "image" },
  { prefix: CloudinaryFolders.photographer.pendingProfile, resourceType: "image" },
  { prefix: CloudinaryFolders.photographer.pendingGallery, resourceType: "image" },
  { prefix: CloudinaryFolders.photographer.pendingVerification, resourceType: "image" },
  { prefix: CloudinaryFolders.photographer.pendingVerification, resourceType: "raw" },
];

@Injectable()
export class PendingUploadCleanupService {
  private readonly logger = new Logger(PendingUploadCleanupService.name);

  constructor(
    @InjectModel("AppSettings") private readonly appSettingsModel: Model<any>,
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  private normalizeHours(rawValue: unknown, fallback = 48): number {
    const parsed = Number(rawValue);
    if (!Number.isFinite(parsed)) return fallback;
    const rounded = Math.floor(parsed);
    if (rounded < 1) return 1;
    if (rounded > 24 * 90) return 24 * 90;
    return rounded;
  }

  // Safety net: `relocateAsset()` fails safe by leaving the original
  // `_pending/...` reference in place if the Cloudinary rename ever errors,
  // which means a live user's profile/verification asset could legitimately
  // still live under `_pending`. Age alone can't tell an orphan apart from
  // that case, so cross-check every deletion candidate against every
  // image/document reference actually stored in Mongo first.
  private async getReferencedPublicIds(): Promise<Set<string>> {
    const referenced = new Set<string>();
    const collect = (docs: any[], fields: string[]) => {
      for (const doc of docs) {
        for (const field of fields) {
          const arr = doc?.[field];
          if (!Array.isArray(arr)) continue;
          for (const item of arr) {
            if (item?.public_id) referenced.add(String(item.public_id));
          }
        }
      }
    };

    const projection = { profileImages: 1, verificationDocuments: 1 };
    const [influencers, brands, photographers] = await Promise.all([
      this.influencerModel.find({}, projection).lean(),
      this.brandModel.find({}, { brandLogo: 1, products: 1 }).lean(),
      this.photographerModel.find({}, projection).lean(),
    ]);
    collect(influencers, ["profileImages", "verificationDocuments"]);
    collect(brands, ["brandLogo", "products"]);
    collect(photographers, ["profileImages", "verificationDocuments"]);
    return referenced;
  }

  // dryRun lists what *would* be deleted without deleting anything — used by
  // the admin preview endpoint so retention can be sanity-checked before
  // enabling the cron.
  async runCleanupNow(triggeredBy: string = "system", dryRun = false) {
    const settings: any = (await this.appSettingsModel.findOne({}).lean()) || {};
    const enabled = settings.pendingUploadAutoDeleteEnabled === true;
    const retentionHours = this.normalizeHours(settings.pendingUploadAutoDeleteHours, 48);

    if (!enabled && !dryRun) {
      this.logger.log("[PendingUploadCleanup] Skipped: disabled in admin settings");
      return {
        success: true,
        skipped: true,
        reason: "disabled",
        retentionHours,
        triggeredBy,
      };
    }

    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - retentionHours);
    const referencedPublicIds = await this.getReferencedPublicIds();

    const byFolder: Array<{
      prefix: string;
      resourceType: string;
      found: number;
      stillReferenced: number;
      deleted: number;
    }> = [];
    let totalDeleted = 0;
    let totalSkippedInUse = 0;

    for (const { prefix, resourceType } of PENDING_FOLDERS) {
      const stale = await this.cloudinaryService.listResourcesOlderThan(
        prefix,
        cutoff,
        resourceType,
      );

      let deleted = 0;
      let stillReferenced = 0;
      for (const asset of stale) {
        if (referencedPublicIds.has(asset.public_id)) {
          stillReferenced += 1;
          this.logger.warn(
            `[PendingUploadCleanup] Skipping ${asset.public_id} — still referenced by a live document (relocate likely failed for this asset).`,
          );
          continue;
        }
        if (dryRun) continue;
        try {
          const result = await this.cloudinaryService.deleteImage(
            asset.public_id,
            resourceType,
          );
          if (result?.result === "ok") deleted += 1;
        } catch (err: any) {
          this.logger.error(
            `[PendingUploadCleanup] Failed to delete ${asset.public_id}`,
            err?.stack || err?.message || String(err),
          );
        }
      }

      byFolder.push({
        prefix,
        resourceType,
        found: stale.length,
        stillReferenced,
        deleted: dryRun ? 0 : deleted,
      });
      totalDeleted += deleted;
      totalSkippedInUse += stillReferenced;
    }

    if (!dryRun) {
      await this.appSettingsModel.findOneAndUpdate(
        {},
        {
          $set: {
            pendingUploadAutoDeleteLastRunAt: new Date(),
            pendingUploadAutoDeleteLastRunCount: totalDeleted,
            pendingUploadAutoDeleteLastRunBy: triggeredBy,
          },
        },
        { upsert: true },
      );

      this.logger.log(
        `[PendingUploadCleanup] Deleted ${totalDeleted} orphaned upload(s) older than ${retentionHours}h` +
          (totalSkippedInUse
            ? `; skipped ${totalSkippedInUse} still-referenced asset(s)`
            : ""),
      );
    }

    return {
      success: true,
      skipped: false,
      dryRun,
      retentionHours,
      cutoff,
      triggeredBy,
      totalDeleted,
      totalSkippedInUse,
      byFolder,
    };
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM)
  async runScheduledCleanup() {
    try {
      await this.runCleanupNow("system_cron");
    } catch (err: any) {
      this.logger.error(
        "[PendingUploadCleanup] Cron failed",
        err?.stack || err?.message || String(err),
      );
    }
  }
}
