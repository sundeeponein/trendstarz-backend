import { Injectable } from '@nestjs/common';
// Always use require and v2 to avoid ESM/CJS issues
const cloudinary = require('cloudinary').v2;

function setCloudinaryConfig() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('[DEBUG] Cloudinary config set:', {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}


// Ensure all Cloudinary env vars are present
if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  // eslint-disable-next-line no-console
  console.error('[Cloudinary ENV ERROR] Missing Cloudinary environment variables!');
} else {
  // eslint-disable-next-line no-console
  console.log('[Cloudinary ENV]', {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET ? '***' : undefined,
  });
  console.log('[DEBUG][Cloudinary ENV] At file load:', {
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET ? '***' : undefined,
  });
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

@Injectable()
export class CloudinaryService {
  async uploadImage(file: string, folder = 'profile_images') {
    setCloudinaryConfig();
    // file: base64 string or file path
    return await cloudinary.uploader.upload(file, {
      folder,
      resource_type: 'image',
      overwrite: true,
    });
  }

  async deleteImage(publicId: string) {
    console.log('[DEBUG] Attempting to delete image with public_id:', publicId);
    setCloudinaryConfig();
    try {
      // Log the type of cloudinary and check for config/uploader.destroy
      console.log('[DEBUG] typeof cloudinary:', typeof cloudinary);
      console.log('[DEBUG] typeof cloudinary.config:', typeof cloudinary.config);
      console.log('[DEBUG] typeof cloudinary.uploader:', typeof cloudinary.uploader);
      console.log('[DEBUG] typeof cloudinary.uploader.destroy:', typeof cloudinary.uploader.destroy);
      const result = await cloudinary.uploader.destroy(publicId);
      console.log('[DEBUG] Cloudinary destroy result:', result);
      if (result.result === 'ok' || result.result === 'not found') {
        console.log('[DEBUG] Image deleted or not found:', publicId);
      } else {
        console.warn('[DEBUG] Unexpected Cloudinary destroy result for', publicId, ':', result);
      }
      return result;
    } catch (err) {
      console.error('[ERROR] Cloudinary deleteImage failed for public_id:', publicId, err);
      throw err;
    }
  }
}
