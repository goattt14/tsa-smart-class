import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from './logger';
import { badRequest } from './http-error';

export interface StoredObject {
  bucket: string;
  objectKey: string;
  sizeBytes: number;
  checksum: string;
}

export interface StorageDriver {
  readonly name: string;
  put(key: string, body: Buffer, mimeType: string): Promise<StoredObject>;
  signedUrl(key: string, downloadName?: string): Promise<string>;
  remove(key: string): Promise<void>;
}

function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Local disk. Fine for development and for a self-hosted box with a real
 * volume, but Render's free filesystem is ephemeral: every deploy wipes it.
 * The health endpoint reports which driver is live so this is visible rather
 * than discovered when a parent asks where the marksheet went.
 */
class LocalDriver implements StorageDriver {
  public readonly name = 'local';

  private root = path.resolve(env.STORAGE_LOCAL_DIR);

  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    // Refuse anything that escapes the storage root.
    if (!target.startsWith(this.root + path.sep)) {
      throw badRequest('Invalid storage key.');
    }
    return target;
  }

  async put(key: string, body: Buffer): Promise<StoredObject> {
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);

    return {
      bucket: 'local',
      objectKey: key,
      sizeBytes: body.byteLength,
      checksum: sha256(body),
    };
  }

  async signedUrl(key: string): Promise<string> {
    // Served by the API's own download route; there is no CDN in this mode.
    return `/api/v1/materials/download/${encodeURIComponent(key)}`;
  }

  async remove(key: string): Promise<void> {
    await fs.rm(this.resolve(key), { force: true });
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }
}

/** S3-compatible: AWS, Cloudflare R2, Backblaze B2, MinIO. */
class S3Driver implements StorageDriver {
  public readonly name = 's3';

  private client: S3Client;

  constructor() {
    this.client = new S3Client({
      region: env.S3_REGION,
      ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
      },
    });
  }

  async put(key: string, body: Buffer, mimeType: string): Promise<StoredObject> {
    const checksum = sha256(body);

    await this.client.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: mimeType,
        // Objects stay private; access is always through a short-lived signed URL.
        Metadata: { checksum },
      }),
    );

    return { bucket: env.S3_BUCKET ?? '', objectKey: key, sizeBytes: body.byteLength, checksum };
  }

  async signedUrl(key: string, downloadName?: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      ...(downloadName
        ? { ResponseContentDisposition: `attachment; filename="${downloadName.replace(/"/g, '')}"` }
        : {}),
    });

    return getSignedUrl(this.client, command, { expiresIn: env.SIGNED_URL_TTL_SEC });
  }

  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  }
}

let driver: StorageDriver | null = null;

export function getStorage(): StorageDriver {
  if (driver) return driver;

  if (env.STORAGE_DRIVER === 's3') {
    if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      logger.error('STORAGE_DRIVER=s3 but the bucket or credentials are missing');
      throw new Error('S3 storage is selected but not configured.');
    }
    driver = new S3Driver();
  } else {
    logger.warn(
      { dir: env.STORAGE_LOCAL_DIR },
      'using local disk for uploads — on Render this is wiped on every deploy',
    );
    driver = new LocalDriver();
  }

  return driver;
}

export function localDriver(): LocalDriver | null {
  const active = getStorage();
  return active instanceof LocalDriver ? active : null;
}

/**
 * Builds a collision-proof object key that still reads sensibly in a bucket
 * listing: material/2026-03-11/<uuid>-<safe-original-name>
 */
export function buildObjectKey(prefix: string, originalName: string, date: string): string {
  const safe = originalName
    .toLowerCase()
    .replace(/[^a-z0-9.\-_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(-80);

  return `${prefix}/${date}/${crypto.randomUUID()}-${safe}`;
}
