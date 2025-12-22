import { Injectable } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';

console.log('[Cloudinary ENV]', {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET ? '***' : undefined,
});
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

@Injectable()
export class CloudinaryService {
  async uploadImage(file: string, folder = 'profile_images') {
    // file: base64 string or file path
    return await cloudinary.uploader.upload(file, {
      folder,
      resource_type: 'image',
      overwrite: true,
    });
  }

  async deleteImage(publicId: string) {
    // Deletes an image from Cloudinary by public_id
    return await cloudinary.uploader.destroy(publicId);
  }
}
