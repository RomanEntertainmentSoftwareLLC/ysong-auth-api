import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';

export const UPLOAD_PART_BYTES = 10 * 1024 * 1024;
// Bound each request and bind every session to its uploader; no whole-file buffering.
export function registerMultipartUploads(app, { requireAuth, enabled, secret, storage, recordUpload }) {
  const wrap = fn => async (req, res) => {
    try { await fn(req, res); }
    catch (error) {
      const status = error.status || (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' ? 401 : 503);
      res.status(status).json({ error: status === 503 ? 'upload_storage_unavailable' : 'invalid_upload',
        message: status === 503 ? 'Storage could not finish the upload. Please retry.' : 'Invalid or expired upload session.' });
    }
  };
  const invalid = () => { const error = new Error('invalid_upload'); error.status = 400; throw error; };
  const session = req => {
    const value = jwt.verify(req.get('X-YSong-Upload-Session') || '', secret(), { algorithms: ['HS256'], audience: 'ysong-multipart-upload' });
    if (value.userId !== String(req.user.id) || !value.key.startsWith(`user-uploads/${req.user.id}/`)) invalid();
    return value;
  };
  app.post('/api/uploads/multipart', requireAuth, wrap(async (req, res) => {
    if (!enabled()) return res.status(501).json({ error: 'multipart_unavailable' });
    const { filename, size, contentType } = req.body || {};
    if (typeof filename !== 'string' || !filename || filename.length > 512 || !Number.isSafeInteger(size) || size <= 0 ||
      Math.ceil(size / UPLOAD_PART_BYTES) > 10000 || typeof contentType !== 'string' || contentType.length > 128 || /[\r\n]/.test(contentType)) invalid();
    const key = `user-uploads/${req.user.id}/${crypto.randomUUID()}-${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const uploadId = await storage.start(key, contentType || 'application/octet-stream', { userId: String(req.user.id), originalName: filename, size, createdAt: new Date().toISOString() });
    const token = jwt.sign({ userId: String(req.user.id), key, uploadId, filename, size, contentType }, secret(), { algorithm: 'HS256', audience: 'ysong-multipart-upload', expiresIn: '24h' });
    res.status(201).json({ session: token, partBytes: UPLOAD_PART_BYTES });
  }));
  app.put('/api/uploads/multipart/parts/:number', requireAuth, express.raw({ type: 'application/octet-stream', limit: UPLOAD_PART_BYTES }), wrap(async (req, res) => {
    const value = session(req), number = Number(req.params.number), count = Math.ceil(value.size / UPLOAD_PART_BYTES);
    const expected = number === count ? value.size - (count - 1) * UPLOAD_PART_BYTES : UPLOAD_PART_BYTES;
    if (!Number.isInteger(number) || number < 1 || number > count || !Buffer.isBuffer(req.body) || req.body.length !== expected) invalid();
    await storage.part(value.key, value.uploadId, number, req.body);
    res.json({ ok: true });
  }));
  app.post('/api/uploads/multipart/complete', requireAuth, wrap(async (req, res) => {
    const value = session(req);
    // Completion is retryable after a lost response; immutable random keys belong to this session.
    let existing;
    try { existing = await storage.head(value.key); } catch (error) { if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NotFound' && error.name !== 'NoSuchKey') throw error; }
    if (!existing) {
      const parts = await storage.list(value.key, value.uploadId);
      const count = Math.ceil(value.size / UPLOAD_PART_BYTES);
      if (parts.length !== count || parts.some((p, i) => p.PartNumber !== i + 1 || !p.ETag || p.Size !== (i === count - 1 ? value.size - i * UPLOAD_PART_BYTES : UPLOAD_PART_BYTES))) invalid();
      await storage.finish(value.key, value.uploadId, parts);
      existing = await storage.head(value.key);
    }
    if (Number(existing.ContentLength) !== value.size) invalid();
    await recordUpload(req.user.id, value.key, value.contentType);
    res.status(201).json({ filename: value.filename, size: value.size, contentType: value.contentType, objectKey: value.key, publicUrl: null });
  }));
  app.use('/api/uploads', (error, _req, res, next) => {
    if (error.code === 'LIMIT_FILE_SIZE' || error.type === 'entity.too.large') return res.status(413).json({ error: 'upload_too_large', message: 'This upload request is too large. Use the updated multipart uploader for large files.' });
    next(error);
  });
}
