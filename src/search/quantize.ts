// Adapted from GoogleChrome/modern-web-guidance-src, src/rag/quantize.ts (Apache-2.0).
// Changes: `truncateAndNormalize256` generalized to `truncateAndNormalize(v, dims)`.
//
// Pure vector quantization, dequantization and buffer alignment utilities, with no filesystem access,
// shared by the search runtime and the build.

/** Embedding size used for both guide chunks and query words. */
export const DIMS = 256;

/** Normalizes a vector to unit L2 norm in place. */
export function l2Normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

/**
 * Copies a buffer to a fresh 4-byte-aligned ArrayBuffer and returns a Float32Array view.
 * Node Buffers can start at any offset in a shared slab, which Float32Array does not allow.
 */
export function toAlignedFloat32Array(buf: Uint8Array): Float32Array {
  const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Float32Array(aligned);
}

/** Returns an Int8Array view over a byte buffer. */
export function toInt8Array(buf: Uint8Array): Int8Array {
  return new Int8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Dequantizes one row from symmetric Int8 to a unit Float32Array.
 * A row with scale zero (an empty vector) returns Float32Array(0).
 */
export function dequantizeVectorRow(qTable: Int8Array, scales: Float32Array, index: number, dims = DIMS): Float32Array {
  const scale = scales[index];
  if (!scale) {
    return new Float32Array(0);
  }
  const offset = index * dims;
  const vec = new Float32Array(dims);
  for (let k = 0; k < dims; k++) {
    vec[k] = qTable[offset + k] * scale;
  }
  return l2Normalize(vec);
}

/**
 * Symmetric per-row Int8 quantization with per-row `maxAbs / 127` scale factors.
 * Empty or all-zero rows get scale 0 and zeros in the table.
 */
export function quantizeVectors(
  vectors: Array<ArrayLike<number>>,
  dims = DIMS
): { qTable: Int8Array; scales: Float32Array } {
  const N = vectors.length;
  const qTable = new Int8Array(N * dims);
  const scales = new Float32Array(N);

  for (let i = 0; i < N; i++) {
    const v = vectors[i];
    if (!v || v.length === 0) continue;
    let maxAbs = 0;
    for (let k = 0; k < dims; k++) {
      const a = Math.abs(v[k] || 0);
      if (a > maxAbs) maxAbs = a;
    }
    if (maxAbs === 0) continue;
    const scale = maxAbs / 127;
    scales[i] = scale;
    const offset = i * dims;
    for (let k = 0; k < dims; k++) {
      const q = Math.round((v[k] || 0) / scale);
      qTable[offset + k] = Math.max(-127, Math.min(127, q));
    }
  }

  return { qTable, scales };
}

/**
 * Keeps the first `dims` values of an embedding and L2-normalizes them. This is valid for models
 * trained with Matryoshka representation learning (MRL), such as gemini-embedding-001 and
 * OpenAI text-embedding-3, whose leading dimensions carry the most information.
 */
export function truncateAndNormalize(v: ArrayLike<number>, dims = DIMS): Float32Array {
  const t = new Float32Array(dims);
  for (let i = 0; i < dims; i++) t[i] = v[i] || 0;
  return l2Normalize(t);
}
