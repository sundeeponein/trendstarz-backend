import { Injectable } from "@nestjs/common";
import * as fs from "fs";
import * as path from "path";
import { v2 as cloudinary } from "cloudinary";

function getLocalImagesDir(): string {
  return path.join(__dirname, "../assets/local-images");
}

function isCloudinaryEnabled(): boolean {
  if (typeof process.env.CLOUDINARY_ENABLED === "string") {
    return process.env.CLOUDINARY_ENABLED.toLowerCase() === "true";
  }
  return process.env.NODE_ENV === "production";
}

function hasCloudinaryCredentials(): boolean {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET,
  );
}

function setCloudinaryConfig() {
  if (!hasCloudinaryCredentials()) {
    throw new Error(
      "Cloudinary is enabled but credentials are missing (CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET).",
    );
  }

  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

@Injectable()
export class CloudinaryService {
  async uploadFile(
    file: string,
    folder = "profile_images",
    resourceType: "image" | "raw" | "video" | "auto" = "image",
  ) {
    // Use Cloudinary only when explicitly enabled (or production default).
    if (isCloudinaryEnabled()) {
      setCloudinaryConfig();
      return await cloudinary.uploader.upload(file, {
        folder,
        resource_type: resourceType,
        overwrite: true,
      });
    }

    // Otherwise, save to local assets/local-images
    // file can be a base64 string or a file path
    let buffer: Buffer;
    let ext = ".jpg";
    if (file.startsWith("data:image/")) {
      // base64 data URL
      const matches = file.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!matches) throw new Error("Invalid base64 image string");
      ext = "." + matches[1];
      buffer = Buffer.from(matches[2], "base64");
    } else if (fs.existsSync(file)) {
      buffer = fs.readFileSync(file);
      ext = path.extname(file) || ".jpg";
    } else {
      throw new Error("Unsupported file format for local upload");
    }

    // Generate unique filename. Sanitize the folder for use as a filename
    // prefix — local storage is flat, but `folder` may contain slashes for
    // nested Cloudinary paths (e.g. "influencers/_pending/profile"), which
    // would otherwise make fs.writeFileSync target a non-existent subdirectory.
    const safeFolder = folder.replace(/\//g, "_");
    const filename = `${safeFolder}_${Date.now()}_${Math.random().toString(36).substring(2, 8)}${ext}`;
    const localDir = getLocalImagesDir();
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const localPath = path.join(localDir, filename);
    fs.writeFileSync(localPath, buffer);

    // Return a local URL and pseudo public_id
    return {
      secure_url: `/assets/local-images/${filename}`,
      url: `/assets/local-images/${filename}`,
      public_id: filename,
      local: true,
    };
  }

  async uploadImage(file: string, folder = "profile_images") {
    return this.uploadFile(file, folder, "image");
  }

  // Moves an already-uploaded asset into its final entity-scoped folder once
  // the owning document's _id becomes known (registration / campaign creation
  // upload before the entity exists in Mongo). No-ops for local-dev assets,
  // since local storage has no real folder concept. Fails safe: if the
  // Cloudinary rename errors out, the original asset reference is returned
  // unchanged rather than losing the reference to the uploaded file.
  async relocateAsset(
    asset: { url: string; public_id: string },
    newFolder: string,
    resourceType: "image" | "raw" | "video" = "image",
  ): Promise<{ url: string; public_id: string }> {
    if (
      !asset?.public_id ||
      !isCloudinaryEnabled() ||
      asset.public_id.startsWith("/assets/local-images/")
    ) {
      return asset;
    }

    const basename = asset.public_id.split("/").pop();
    const newPublicId = `${newFolder}/${basename}`;
    if (newPublicId === asset.public_id) {
      return asset;
    }

    setCloudinaryConfig();
    try {
      const result = await cloudinary.uploader.rename(
        asset.public_id,
        newPublicId,
        { overwrite: true, resource_type: resourceType },
      );

      // On accounts using Cloudinary's Dynamic Folder Mode, `rename` only
      // changes the public_id/URL — it does NOT move the separate
      // `asset_folder` attribute the Console's folder browser actually
      // reads. Left alone, the asset is fully accessible at its new path
      // but stays visually filed under the old `_pending/...` folder
      // forever. Sync it explicitly; this is cosmetic only (nothing in the
      // app reads asset_folder), so a failure here shouldn't undo the
      // already-successful rename above.
      await this.syncAssetFolder(newPublicId, newFolder, resourceType);

      return { url: result.secure_url, public_id: result.public_id };
    } catch (err) {
      console.error(
        "[Cloudinary] relocateAsset failed:",
        asset.public_id,
        "->",
        newPublicId,
        err,
      );
      return asset;
    }
  }

  isEnabled(): boolean {
    return isCloudinaryEnabled();
  }

  // Sets the Console-visible `asset_folder` for an asset whose public_id
  // already lives at `folder/...`. Safe to call repeatedly — writing the
  // same value again is a harmless no-op — which is what makes the backfill
  // job idempotent. Failures are logged and swallowed rather than thrown:
  // this attribute is cosmetic only, nothing in the app reads it.
  async syncAssetFolder(
    publicId: string,
    folder: string,
    resourceType: "image" | "raw" | "video" = "image",
  ): Promise<boolean> {
    if (!isCloudinaryEnabled() || !hasCloudinaryCredentials()) return false;
    setCloudinaryConfig();
    try {
      await cloudinary.api.update(publicId, {
        resource_type: resourceType,
        asset_folder: folder,
      });
      return true;
    } catch (err) {
      console.warn(
        "[Cloudinary] syncAssetFolder failed:",
        publicId,
        "->",
        folder,
        err,
      );
      return false;
    }
  }

  async deleteImage(
    publicId: string,
    resourceType: "image" | "raw" | "video" = "image",
  ) {
    if (!publicId) {
      return { result: "not_found", reason: "empty_public_id" };
    }

    // Local/development mode: delete from local assets if present.
    if (
      !isCloudinaryEnabled() ||
      publicId.startsWith("/assets/local-images/")
    ) {
      const filename = path.basename(publicId);
      const localPath = path.join(getLocalImagesDir(), filename);
      if (fs.existsSync(localPath)) {
        fs.unlinkSync(localPath);
        return { result: "ok", local: true, deleted: filename };
      }
      return { result: "not_found", local: true, attempted: filename };
    }

    setCloudinaryConfig();
    // Strip file extension if present (Cloudinary public_id never includes extension)
    const strippedId = publicId.replace(/\.[^/.]+$/, "");
    // Build list of public_id variants to try in order
    const variants: string[] = [strippedId];
    if (!strippedId.includes("/")) {
      variants.push(`client-side/uploads/${strippedId}`);
      variants.push(`uploads/${strippedId}`);
    } else if (
      !strippedId.startsWith("client-side/") &&
      !strippedId.startsWith("uploads/")
    ) {
      variants.push(`client-side/uploads/${strippedId}`);
    }
    let lastResult: any = null;
    for (const id of variants) {
      try {
        console.log("[Cloudinary] Attempting to delete public_id:", id);
        const result = await cloudinary.uploader.destroy(id, {
          resource_type: resourceType,
        });
        console.log("[Cloudinary] destroy result for", id, ":", result);
        if (result.result === "ok") {
          console.log("[Cloudinary] Successfully deleted:", id);
          return result;
        }
        lastResult = result;
      } catch (err) {
        console.error("[Cloudinary] deleteImage error for public_id:", id, err);
        lastResult = err;
      }
    }
    console.warn(
      "[Cloudinary] Image not found or could not be deleted for original public_id:",
      publicId,
    );
    return lastResult;
  }

  // Lists assets under a folder prefix that were uploaded before `cutoff`.
  // Used to find `_pending/*` staging uploads that were never relocated —
  // i.e. abandoned/failed registrations — so they can be purged instead of
  // accumulating in Cloudinary storage forever.
  async listResourcesOlderThan(
    prefix: string,
    cutoff: Date,
    resourceType: "image" | "raw" = "image",
  ): Promise<Array<{ public_id: string; created_at: string }>> {
    if (!isCloudinaryEnabled() || !hasCloudinaryCredentials()) return [];
    setCloudinaryConfig();

    const stale: Array<{ public_id: string; created_at: string }> = [];
    let nextCursor: string | undefined;
    do {
      const resp: any = await cloudinary.api.resources({
        type: "upload",
        resource_type: resourceType,
        prefix,
        max_results: 500,
        next_cursor: nextCursor,
      });
      for (const resource of resp.resources || []) {
        if (new Date(resource.created_at) <= cutoff) {
          stale.push({
            public_id: resource.public_id,
            created_at: resource.created_at,
          });
        }
      }
      nextCursor = resp.next_cursor;
    } while (nextCursor);

    return stale;
  }
}
