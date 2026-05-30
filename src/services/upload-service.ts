// services/upload-service.ts
import { randomUUID } from 'crypto';
import path from 'path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '@/config/env.config';

const s3 = new S3Client({
  region: config.aws.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

const BUCKET = config.aws.s3BucketName;

// Public URL of an object once it has been uploaded to the bucket.
export const getPublicUrl = (key: string): string =>
  `https://${BUCKET}.s3.${config.aws.region}.amazonaws.com/${key}`;

// Build a unique, collision-free object key inside a folder.
const buildObjectKey = (folder: string, fileName: string): string => {
  const ext = path.extname(fileName);
  return `${folder}/${randomUUID()}${ext}`;
};

interface PresignedUpload {
  uploadUrl: string; // PUT the file here (expires shortly)
  fileUrl: string; // Public URL to store in the DB / send around
  key: string;
}

// S3 implementation: generate a short-lived presigned URL so the browser can
// upload the file directly to S3 (no AWS credentials in the frontend).
export const generatePresignedUploadUrl = async ({
  fileName,
  contentType,
  folder = 'uploads',
  expiresIn = 60, // seconds
}: {
  fileName: string;
  contentType: string;
  folder?: string;
  expiresIn?: number;
}): Promise<PresignedUpload> => {
  const key = buildObjectKey(folder, fileName);

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn });

  return { uploadUrl, fileUrl: getPublicUrl(key), key };
};

// S3 implementation of the previous Cloudinary helper. Uploads a buffer
// (e.g. from multer memoryStorage) straight to S3 and returns the public URL.
export const uploadToCloud = async (
  fileBuffer: Buffer,
  options: { folder?: string; contentType?: string; fileName?: string } = {}
): Promise<string> => {
  const { folder = 'profiles', contentType = 'application/octet-stream', fileName = 'file' } = options;
  const key = buildObjectKey(folder, fileName);

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType,
    })
  );

  return getPublicUrl(key);
};
