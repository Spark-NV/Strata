/**
 * Uploads sent again (phase 3): a client names the bytes with `x-strata-upload-key: <sha256 of the bytes, hex>`. Strata remembers what it
 * stored for that key for 24 hours, so a retry after a dropped answer gets the same id or name and no second copy is kept. A key that does
 * not match the bytes is refused (400 bad-upload-key), so a key can never stand for other bytes.
 */
import { createHash } from 'node:crypto';

const KEEP_MS = 24 * 3600_000;
export const UPLOAD_KEY = /^[0-9a-f]{64}$/;

export function createUploadKeys({ now = () => Date.now() } = {}) {
  const seen = new Map();   // `${scope}:${key}` -> { value, at }
  const tidy = () => { for (const [k, v] of seen) if (now() - v.at > KEEP_MS) seen.delete(k); };
  return {
    /** The key a request names, checked against its bytes: null for none, or throws 400 when it does not match. */
    keyOf(req, bytes) {
      const raw = req.headers['x-strata-upload-key'];
      if (raw === undefined) return null;
      const key = String(raw).toLowerCase();
      if (!UPLOAD_KEY.test(key) || (bytes && createHash('sha256').update(bytes).digest('hex') !== key)) throw Object.assign(new Error('x-strata-upload-key must be the SHA-256 of the bytes sent, in hex.'), { status: 400, code: 'bad-upload-key' });
      return key;
    },
    /** What was stored for this key, if it still `exists(value)`. */
    get(scope, key, exists = () => true) {
      const hit = seen.get(`${scope}:${key}`);
      if (!hit || now() - hit.at > KEEP_MS || !exists(hit.value)) return null;
      return hit.value;
    },
    set(scope, key, value) { tidy(); seen.set(`${scope}:${key}`, { value, at: now() }); },
  };
}
