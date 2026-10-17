#!/usr/bin/env node

/*
 * Deletes uploaded media by public_id, with dry-run as the default.
 *
 * Usage:
 *   node scripts/cleanup-media-by-public-ids.js --file cleanup-public-ids.txt
 *   node scripts/cleanup-media-by-public-ids.js --file cleanup-public-ids.txt --apply
 *
 * Input file:
 *   # one public_id or local filename per line
 *   influencer_profile_images/abc123
 *   /assets/local-images/profile_images_123.jpg
 *   profile_images_123.jpg
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { v2: cloudinary } = require("cloudinary");

dotenv.config();

const backendRoot = path.resolve(__dirname, "..");
const localImagesDir = path.join(backendRoot, "assets", "local-images");

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function readIds(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isCloudinaryEnabled() {
  if (typeof process.env.CLOUDINARY_ENABLED === "string") {
    return process.env.CLOUDINARY_ENABLED.toLowerCase() === "true";
  }
  return process.env.NODE_ENV === "production";
}

function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error(
      "Missing CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET",
    );
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
}

function getLocalFilename(publicId) {
  if (publicId.startsWith("/assets/local-images/")) {
    return path.basename(publicId);
  }

  if (!publicId.includes("/") && fs.existsSync(path.join(localImagesDir, publicId))) {
    return publicId;
  }

  return "";
}

function getCloudinaryVariants(publicId) {
  const strippedId = publicId.replace(/\.[^/.]+$/, "");
  const variants = [strippedId];

  if (!strippedId.includes("/")) {
    variants.push(`client-side/uploads/${strippedId}`);
    variants.push(`uploads/${strippedId}`);
  } else if (
    !strippedId.startsWith("client-side/") &&
    !strippedId.startsWith("uploads/")
  ) {
    variants.push(`client-side/uploads/${strippedId}`);
  }

  return [...new Set(variants)];
}

async function deleteLocal(filename, apply) {
  const localPath = path.join(localImagesDir, filename);
  const exists = fs.existsSync(localPath);
  if (!apply) {
    return { target: localPath, result: exists ? "would_delete" : "not_found" };
  }
  if (!exists) return { target: localPath, result: "not_found" };
  fs.unlinkSync(localPath);
  return { target: localPath, result: "ok" };
}

async function deleteCloudinary(publicId, apply) {
  const variants = getCloudinaryVariants(publicId);
  if (!apply) return { target: variants, result: "would_delete" };

  let lastResult = null;
  for (const variant of variants) {
    const result = await cloudinary.uploader.destroy(variant);
    lastResult = { target: variant, ...result };
    if (result.result === "ok") return lastResult;
  }

  return lastResult || { target: variants, result: "not_found" };
}

async function main() {
  const fileArg = getArg("--file");
  const apply = hasFlag("--apply");

  if (!fileArg) {
    throw new Error("Missing --file path/to/public-ids.txt");
  }

  const filePath = path.resolve(process.cwd(), fileArg);
  const ids = readIds(filePath);
  const cloudinaryEnabled = isCloudinaryEnabled();

  if (apply && cloudinaryEnabled) {
    configureCloudinary();
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? "apply" : "dry-run",
        cloudinaryEnabled,
        count: ids.length,
        file: filePath,
      },
      null,
      2,
    ),
  );

  let deleted = 0;
  let notFound = 0;
  let planned = 0;

  for (const publicId of ids) {
    const localFilename = getLocalFilename(publicId);
    const result = localFilename
      ? await deleteLocal(localFilename, apply)
      : await deleteCloudinary(publicId, apply);

    if (result.result === "ok") deleted += 1;
    if (result.result === "not_found") notFound += 1;
    if (result.result === "would_delete") planned += 1;

    console.log(JSON.stringify({ publicId, ...result }));
  }

  console.log(
    JSON.stringify(
      {
        done: true,
        mode: apply ? "apply" : "dry-run",
        deleted,
        planned,
        notFound,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error("cleanup-media-by-public-ids failed:", err.message || err);
  process.exit(1);
});
