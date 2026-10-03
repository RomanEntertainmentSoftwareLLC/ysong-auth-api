import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export const R2_BUCKET = process.env.R2_BUCKET || "ysong-assets";
const bucket = R2_BUCKET;
const endpoint = process.env.R2_ENDPOINT;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

export const R2_ENABLED = Boolean(
  endpoint && accessKeyId && secretAccessKey && bucket
);

const client = R2_ENABLED
  ? new S3Client({
      region: "auto",
      endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    })
  : null;

function requireR2() {
  if (!client) throw new Error("r2_not_configured");
  return client;
}

export async function putR2Object(objectKey, body, {
  contentType = "application/octet-stream",
  metadata = {},
  contentLength,
  ifNoneMatch,
} = {}) {
  await requireR2().send(new PutObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    Body: body,
    ContentType: contentType,
    ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
    ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
    // HTTP metadata headers must be ASCII; filenames and other fields may be Unicode.
    Metadata: { ysong: Buffer.from(JSON.stringify(metadata)).toString("base64") },
  }));
}

export async function headR2Object(objectKey) {
  return requireR2().send(new HeadObjectCommand({
    Bucket: bucket,
    Key: objectKey,
  }));
}

export async function getR2Object(objectKey, { range } = {}) {
  return requireR2().send(new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ...(range ? { Range: range } : {}),
  }));
}

export async function copyR2Object(sourceKey, destinationKey) {
  await requireR2().send(new CopyObjectCommand({
    Bucket: bucket,
    Key: destinationKey,
    CopySource: `${bucket}/${sourceKey.split("/").map(encodeURIComponent).join("/")}`,
    MetadataDirective: "COPY",
  }));
}

export async function deleteR2Object(objectKey) {
  await requireR2().send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: objectKey,
  }));
}

export async function getR2SignedUrl(objectKey, {
  download = false,
  filename,
  expiresIn = 7200,
} = {}) {
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: objectKey,
    ...(download
      ? {
          ResponseContentDisposition:
            `attachment; filename*=UTF-8''${encodeURIComponent(filename || "download")}`,
        }
      : {}),
  });

  return getSignedUrl(requireR2(), command, { expiresIn });
}
