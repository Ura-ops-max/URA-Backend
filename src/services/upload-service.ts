// services/upload-service.ts
import { v2 as cloudinary } from 'cloudinary';

// Current: Cloudinary Implementation
export const uploadToCloud = async (fileBuffer: Buffer) => {
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream({ folder: 'profiles' }, (error, result) => {
      if (error) reject(error);
      resolve(result?.secure_url);
    }).end(fileBuffer);
  });
};

// When you switch to S3, you just change this function's logic
// and the rest of your backend stays the same.