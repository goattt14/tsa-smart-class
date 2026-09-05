import multer from 'multer';
import { env } from '../config/env';
import { badRequest } from '../lib/http-error';

/**
 * Files are held in memory, not written to a temp directory.
 *
 * Uploads here are lecture notes and board photos in the tens of megabytes, and
 * a memory buffer avoids leaving orphaned temp files behind on a container that
 * can be recycled mid-request. MAX_UPLOAD_MB is the guard against that choice
 * becoming a memory problem.
 */
const ALLOWED_MIME = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'text/plain',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'video/mp4',
  'video/webm',
]);

export const uploadMaterial = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_MB * 1024 * 1024,
    files: 10,
  },
  fileFilter: (_req, file, callback) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      callback(badRequest(`Files of type ${file.mimetype} are not accepted.`));
      return;
    }
    callback(null, true);
  },
});

/** Turns multer's own errors into the API's standard shape. */
export function isMulterError(error: unknown): error is multer.MulterError {
  return error instanceof multer.MulterError;
}

export function describeMulterError(error: multer.MulterError): string {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE':
      return `That file is larger than the ${env.MAX_UPLOAD_MB} MB limit.`;
    case 'LIMIT_FILE_COUNT':
      return 'Too many files in one upload.';
    case 'LIMIT_UNEXPECTED_FILE':
      return 'Unexpected file field in the upload.';
    default:
      return 'That upload could not be accepted.';
  }
}
