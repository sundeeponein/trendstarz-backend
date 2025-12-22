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
    setCloudinaryConfig();
    // Log the type of cloudinary and check for config/uploader.destroy
    console.log('[DEBUG] typeof cloudinary:', typeof cloudinary);
    console.log('[DEBUG] typeof cloudinary.config:', typeof cloudinary.config);
    console.log('[DEBUG] typeof cloudinary.uploader:', typeof cloudinary.uploader);
    console.log('[DEBUG] typeof cloudinary.uploader.destroy:', typeof cloudinary.uploader.destroy);
    return await cloudinary.uploader.destroy(publicId);
  }
}
