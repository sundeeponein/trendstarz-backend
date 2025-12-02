import { Injectable } from '@nestjs/common';
import { v2 as cloudinary } from 'cloudinary';

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
}
