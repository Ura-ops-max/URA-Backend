import { Request, Response } from 'express';
import { asyncHandler } from '@/middleware/errorHandler';
import { generatePresignedUploadUrl } from '@/services/upload-service';
import { UPLOAD_DESTINATIONS } from '@/constants';

// Folders the frontend is allowed to request a presigned upload for.
const ALLOWED_FOLDERS = new Set<string>(Object.values(UPLOAD_DESTINATIONS));

// POST /api/upload/presign
// Body: { fileName, contentType, folder? }
// Returns a short-lived presigned PUT URL plus the eventual public file URL.
export const getPresignedUploadUrl = asyncHandler(
  async (req: Request, res: Response): Promise<void> => {
    const { fileName, contentType, folder } = req.body ?? {};

    if (!fileName || !contentType) {
      res.status(400).json({ message: 'fileName and contentType are required' });
      return;
    }

    const targetFolder =
      folder && ALLOWED_FOLDERS.has(folder) ? folder : UPLOAD_DESTINATIONS.ATTACHMENTS;

    const result = await generatePresignedUploadUrl({
      fileName,
      contentType,
      folder: targetFolder,
    });

    res.status(200).json(result);
  }
);
