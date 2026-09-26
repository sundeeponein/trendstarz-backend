import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { CloudinaryService } from "../cloudinary.service";
import { CloudinaryFolders } from "../cloudinary-folders";

// One-time (re-runnable) repair for a historical bug: `relocateAsset()` only
// renamed the Cloudinary public_id and never synced the separate
// `asset_folder` attribute that the Console's folder browser reads, so every
// asset relocated out of `_pending/...` before the fix still displays under
// its old pending folder even though its real public_id/URL is correct.
// This walks every existing influencer/brand/photographer and re-applies the
// correct asset_folder for each of their media entries. Idempotent — safe to
// run repeatedly, and skips anything whose public_id is still genuinely
// under `_pending/...` (nothing to fix, relocation hasn't happened yet).
@Injectable()
export class AssetFolderBackfillService {
  private readonly logger = new Logger(AssetFolderBackfillService.name);

  constructor(
    @InjectModel("Influencer") private readonly influencerModel: Model<any>,
    @InjectModel("Brand") private readonly brandModel: Model<any>,
    @InjectModel("Photographer") private readonly photographerModel: Model<any>,
    private readonly cloudinaryService: CloudinaryService,
  ) {}

  private getPublicId(item: any): string {
    if (!item) return "";
    if (typeof item === "string") return item.trim();
    return String(item?.public_id || item?.publicId || "").trim();
  }

  private isPending(publicId: string): boolean {
    return publicId.includes("/_pending/");
  }

  private resourceTypeFor(item: any): "image" | "raw" {
    return item?.mimeType === "application/pdf" ? "raw" : "image";
  }

  async runBackfillNow(dryRun = true) {
    if (!this.cloudinaryService.isEnabled()) {
      return {
        success: true,
        skipped: true,
        reason: "Cloudinary is not enabled in this environment",
        dryRun,
      };
    }

    const stats = {
      influencers: { checked: 0, candidates: 0, synced: 0, errors: 0 },
      brands: { checked: 0, candidates: 0, synced: 0, errors: 0 },
      photographers: { checked: 0, candidates: 0, synced: 0, errors: 0 },
    };

    const syncItem = async (
      item: any,
      folder: string,
      bucket: { checked: number; candidates: number; synced: number; errors: number },
    ) => {
      bucket.checked += 1;
      const publicId = this.getPublicId(item);
      if (!publicId || this.isPending(publicId)) return;
      bucket.candidates += 1;
      if (dryRun) return;
      const ok = await this.cloudinaryService.syncAssetFolder(
        publicId,
        folder,
        this.resourceTypeFor(item),
      );
      if (ok) bucket.synced += 1;
      else bucket.errors += 1;
    };

    // Influencers + Photographers share the same profile/gallery/verification shape.
    const galleryRoleModels: Array<{
      model: Model<any>;
      folders: (typeof CloudinaryFolders)["influencer"] | (typeof CloudinaryFolders)["photographer"];
      bucket: typeof stats.influencers;
    }> = [
      { model: this.influencerModel, folders: CloudinaryFolders.influencer, bucket: stats.influencers },
      { model: this.photographerModel, folders: CloudinaryFolders.photographer, bucket: stats.photographers },
    ];

    for (const { model, folders, bucket } of galleryRoleModels) {
      const users = await model
        .find({}, { profileImages: 1, galleryImages: 1, verificationDocuments: 1 })
        .lean();

      for (const user of users as any[]) {
        const id = String(user._id);
        const profileImages: any[] = Array.isArray(user.profileImages) ? user.profileImages : [];
        const [primary, ...gallery] = profileImages;
        if (primary) await syncItem(primary, folders.profile(id), bucket);
        for (const img of gallery) await syncItem(img, folders.gallery(id), bucket);
        for (const img of (user.galleryImages || [])) await syncItem(img, folders.gallery(id), bucket);
        for (const doc of (user.verificationDocuments || [])) {
          await syncItem(doc, folders.verification(id), bucket);
        }
      }
    }

    const brands = await this.brandModel
      .find({}, { brandLogo: 1, products: 1 })
      .lean();
    for (const brand of brands as any[]) {
      const id = String(brand._id);
      for (const img of (brand.brandLogo || [])) {
        await syncItem(img, CloudinaryFolders.brand.logo(id), stats.brands);
      }
      for (const img of (brand.products || [])) {
        await syncItem(img, CloudinaryFolders.brand.products(id), stats.brands);
      }
    }

    const totalCandidates =
      stats.influencers.candidates + stats.brands.candidates + stats.photographers.candidates;
    const totalSynced = stats.influencers.synced + stats.brands.synced + stats.photographers.synced;

    this.logger.log(
      `[AssetFolderBackfill] dryRun=${dryRun} candidates=${totalCandidates} synced=${totalSynced} ` +
        `(influencers=${JSON.stringify(stats.influencers)}, brands=${JSON.stringify(stats.brands)}, photographers=${JSON.stringify(stats.photographers)})`,
    );

    return {
      success: true,
      skipped: false,
      dryRun,
      totalCandidates,
      totalSynced,
      stats,
    };
  }
}
