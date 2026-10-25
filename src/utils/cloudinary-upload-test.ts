import { v2 as cloudinary } from "cloudinary";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/**
 * Uploads a 1-pixel image with the live keys, then deletes it. A ping only
 * proves the key can READ; this proves uploads work. Sent directly (not via
 * the SDK) because the SDK hides Cloudinary's reason on a 403.
 * Throws with Cloudinary's own reason (never the key or secret).
 */
export async function cloudinaryUploadTest(folder = "system/health-check"): Promise<void> {
  const cloud = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || "").trim();
  const secret = String(process.env.CLOUDINARY_API_SECRET || "").trim();
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `upload-test-${timestamp}`;
  const signed = { folder, public_id: publicId, timestamp };
  const signature = cloudinary.utils.api_sign_request(signed, secret);

  const form = new FormData();
  form.append("file", PIXEL);
  form.append("folder", folder);
  form.append("public_id", publicId);
  form.append("timestamp", String(timestamp));
  form.append("api_key", apiKey);
  form.append("signature", signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(cloud)}/image/upload`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.text();
  if (!res.ok) {
    let why = body;
    try {
      why = JSON.parse(body)?.error?.message || body;
    } catch {
      // Not JSON (e.g. a blocking page in front of Cloudinary): keep plain text.
      why = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    }
    const keyHint = apiKey ? ` [key …${apiKey.slice(-4)}, cloud "${cloud}"]` : "";
    throw new Error(`upload refused, HTTP ${res.status}: ${String(why).slice(0, 200) || "no reason given"}${keyHint}`);
  }
  cloudinary.config({ cloud_name: cloud, api_key: apiKey, api_secret: secret });
  await cloudinary.uploader.destroy(`${folder}/${publicId}`).catch(() => undefined);
}
