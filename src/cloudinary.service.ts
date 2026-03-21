import { Injectable } from "@nestjs/common";
// Always use require and v2 to avoid ESM/CJS issues
const cloudinary = require("cloudinary").v2;

function setCloudinaryConfig() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// Ensure all Cloudinary env vars are present
if (
  !process.env.CLOUDINARY_CLOUD_NAME ||
  !process.env.CLOUDINARY_API_KEY ||
  !process.env.CLOUDINARY_API_SECRET
) {
  console.error(
    "[Cloudinary ENV ERROR] Missing Cloudinary environment variables!",
  );
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

@Injectable()
export class CloudinaryService {
  async uploadImage(file: string, folder = "profile_images") {
    setCloudinaryConfig();
    // file: base64 string or file path
    return await cloudinary.uploader.upload(file, {
      folder,
      resource_type: "image",
      overwrite: true,
    });
  }

  async deleteImage(publicId: string) {
    setCloudinaryConfig();
    // Strip file extension if present (Cloudinary public_id never includes extension)
    const strippedId = publicId.replace(/\.[^/.]+$/, "");
    // Build list of public_id variants to try in order
    const variants: string[] = [strippedId];
    if (!strippedId.includes("/")) {
      variants.push(`client-side/uploads/${strippedId}`);
      variants.push(`uploads/${strippedId}`);
    } else if (!strippedId.startsWith("client-side/") && !strippedId.startsWith("uploads/")) {
      variants.push(`client-side/uploads/${strippedId}`);
    }
    let lastResult: any = null;
    for (const id of variants) {
      try {
        console.log("[Cloudinary] Attempting to delete public_id:", id);
        const result = await cloudinary.uploader.destroy(id);
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
    console.warn("[Cloudinary] Image not found or could not be deleted for original public_id:", publicId);
    return lastResult;
  }
}
