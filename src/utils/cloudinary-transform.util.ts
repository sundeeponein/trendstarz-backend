/**
 * Injects an f_auto,q_auto,w_<width> transformation into a Cloudinary
 * secure_url so above-the-fold surfaces (e.g. the homepage hero banner)
 * serve a right-sized, auto-format (WebP/AVIF where supported) image
 * instead of the full original upload. No-op for non-Cloudinary URLs.
 */
export function withCloudinaryHeroTransform(url: string, width = 1600): string {
  if (!url || !url.includes("/upload/")) return url;
  return url.replace("/upload/", `/upload/f_auto,q_auto,w_${width},c_fill/`);
}
