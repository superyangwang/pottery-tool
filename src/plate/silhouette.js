// Image -> solid silhouette mask + cavity placement.
//
// The input is expected to be a line drawing or filled shape (e.g. a cat-head
// outline). The silhouette is everything that is NOT reachable from the image
// border through light/transparent pixels — so an outline drawing gets its
// interior filled automatically, and a pre-filled shape passes through as-is.
//
// Everything here is pure array math (no canvas), so the same code runs in
// the browser and in the Node CLI (scripts/generate.js).

/**
 * RGBA bytes -> "darkness" (0 = white/transparent, 1 = opaque black).
 */
export function grayscaleFromRGBA(data, width, height) {
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    out[i] = (1 - luma) * a;
  }
  return out;
}

/**
 * Box-filter downsample of a float grid so the longest side is <= maxSide.
 * Pure JS (no canvas) so it works in Node too.
 */
export function downsampleGray(gray, width, height, maxSide) {
  const longest = Math.max(width, height);
  if (longest <= maxSide) return { gray, width, height };
  const scale = maxSide / longest;
  const W = Math.max(2, Math.round(width * scale));
  const H = Math.max(2, Math.round(height * scale));
  const out = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const y0 = Math.floor((j / H) * height);
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) / H) * height));
    for (let i = 0; i < W; i++) {
      const x0 = Math.floor((i / W) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) / W) * width));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) sum += gray[y * width + x];
      }
      out[j * W + i] = sum / ((y1 - y0) * (x1 - x0));
    }
  }
  return { gray: out, width: W, height: H };
}

/**
 * Build the solid silhouette mask.
 *
 * 1. Threshold darkness -> ink mask.
 * 2. Flood-fill from every border pixel through non-ink pixels -> "exterior".
 * 3. Solid = everything not exterior (outline strokes AND enclosed interior).
 *
 * @param {{data: Uint8ClampedArray|Buffer, width: number, height: number}} img
 * @param {object} opts
 * @param {number} [opts.threshold=0.3]  0..1, lower = more pixels count as ink
 * @param {number} [opts.maxResolution=512]
 * @returns {{ W: number, H: number, mask: Uint8Array }}
 */
export function buildSilhouette(img, opts = {}) {
  const {
    threshold = 0.3,
    maxResolution = 512,
    // Holes: by default every enclosed light region is filled (outline
    // drawings become solid). With keepHoles, enclosed regions whose area is
    // between minHoleFraction and maxHoleFraction of the filled silhouette
    // stay open - a thumb hole in a photographed rib - while the big interior
    // of a line drawing (> maxHoleFraction) and specks (< minHoleFraction)
    // are still filled.
    keepHoles = false,
    minHoleFraction = 0.002,
    maxHoleFraction = 0.5,
  } = opts;
  const full = grayscaleFromRGBA(img.data, img.width, img.height);
  const { gray, width: W, height: H } = downsampleGray(full, img.width, img.height, maxResolution);

  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = gray[i] > threshold ? 1 : 0;

  // Flood fill the exterior from the border (4-connected through non-ink).
  const exterior = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let qHead = 0;
  let qTail = 0;
  const push = (idx) => {
    if (!exterior[idx] && !ink[idx]) {
      exterior[idx] = 1;
      queue[qTail++] = idx;
    }
  };
  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }
  while (qHead < qTail) {
    const idx = queue[qHead++];
    const x = idx % W;
    const y = (idx / W) | 0;
    if (x > 0) push(idx - 1);
    if (x < W - 1) push(idx + 1);
    if (y > 0) push(idx - W);
    if (y < H - 1) push(idx + W);
  }

  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = exterior[i] ? 0 : 1;

  if (keepHoles) {
    let filledArea = 0;
    for (let i = 0; i < W * H; i++) filledArea += mask[i];
    const minArea = filledArea * minHoleFraction;
    const maxArea = filledArea * maxHoleFraction;
    // Label enclosed non-ink components (4-connected) and open the ones in range.
    const seen = new Uint8Array(W * H);
    const comp = new Int32Array(W * H);
    for (let start = 0; start < W * H; start++) {
      if (seen[start] || ink[start] || exterior[start]) continue;
      let head = 0;
      let tail = 0;
      comp[tail++] = start;
      seen[start] = 1;
      while (head < tail) {
        const idx = comp[head++];
        const x = idx % W;
        const y = (idx / W) | 0;
        const tryPush = (n) => {
          if (!seen[n] && !ink[n] && !exterior[n]) {
            seen[n] = 1;
            comp[tail++] = n;
          }
        };
        if (x > 0) tryPush(idx - 1);
        if (x < W - 1) tryPush(idx + 1);
        if (y > 0) tryPush(idx - W);
        if (y < H - 1) tryPush(idx + W);
      }
      if (tail > minArea && tail < maxArea) {
        for (let k = 0; k < tail; k++) mask[comp[k]] = 0;
      }
    }
  }

  // Guarantee a clear 1-pixel border so contours always close.
  for (let x = 0; x < W; x++) {
    mask[x] = 0;
    mask[(H - 1) * W + x] = 0;
  }
  for (let y = 0; y < H; y++) {
    mask[y * W] = 0;
    mask[y * W + W - 1] = 0;
  }

  return { W, H, mask };
}

// Chamfer 3-4 distance transform: distance (in chamfer units, 3 = one pixel)
// from each solid pixel to the nearest background pixel.
function distanceToBackground(mask, W, H) {
  const INF = 1e9;
  const dist = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) dist[i] = mask[i] ? INF : 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      let d = dist[idx];
      if (x > 0) d = Math.min(d, dist[idx - 1] + 3);
      if (y > 0) d = Math.min(d, dist[idx - W] + 3);
      if (x > 0 && y > 0) d = Math.min(d, dist[idx - W - 1] + 4);
      if (x < W - 1 && y > 0) d = Math.min(d, dist[idx - W + 1] + 4);
      dist[idx] = d;
    }
  }
  for (let y = H - 1; y >= 0; y--) {
    for (let x = W - 1; x >= 0; x--) {
      const idx = y * W + x;
      let d = dist[idx];
      if (x < W - 1) d = Math.min(d, dist[idx + 1] + 3);
      if (y < H - 1) d = Math.min(d, dist[idx + W] + 3);
      if (x < W - 1 && y < H - 1) d = Math.min(d, dist[idx + W + 1] + 4);
      if (x > 0 && y < H - 1) d = Math.min(d, dist[idx + W - 1] + 4);
      dist[idx] = d;
    }
  }
  return dist;
}

/**
 * The incenter — the solid pixel farthest from any edge. The largest circle
 * that fits inside the silhouette is centered there with radius = maxDist.
 *
 * @returns {{ cx: number, cy: number, radiusPx: number }} in mask pixel coords
 */
export function largestInscribedCircle(mask, W, H) {
  const dist = distanceToBackground(mask, W, H);
  let best = -1;
  let bestIdx = 0;
  for (let i = 0; i < W * H; i++) {
    if (dist[i] < 1e9 && dist[i] > best) {
      best = dist[i];
      bestIdx = i;
    }
  }
  return {
    cx: bestIdx % W,
    cy: (bestIdx / W) | 0,
    radiusPx: best / 3, // chamfer units -> pixels
  };
}

/**
 * Morphological erosion: shrink the silhouette inward by `radiusPx` pixels.
 * The result is the same shape offset inward — it may split into several
 * islands (e.g. ears pinching off) which the contour tracer handles.
 */
export function erodeMask(mask, W, H, radiusPx) {
  const dist = distanceToBackground(mask, W, H);
  const threshold = radiusPx * 3; // pixels -> chamfer units
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = dist[i] > threshold ? 1 : 0;
  return out;
}

/** Morphological dilation: grow the silhouette outward by `radiusPx`. */
export function dilateMask(mask, W, H, radiusPx) {
  const inv = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) inv[i] = mask[i] ? 0 : 1;
  const dist = distanceToBackground(inv, W, H); // bg pixel -> nearest solid
  const threshold = radiusPx * 3;
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] || dist[i] <= threshold ? 1 : 0;
  // Keep the border clear so contours always close.
  for (let x = 0; x < W; x++) {
    out[x] = 0;
    out[(H - 1) * W + x] = 0;
  }
  for (let y = 0; y < H; y++) {
    out[y * W] = 0;
    out[y * W + W - 1] = 0;
  }
  return out;
}

/**
 * Round off every corner of a shape: morphological closing (fills concave
 * notches tighter than `radiusPx`) followed by opening (shaves convex bumps
 * tighter than `radiusPx`). The result has no feature sharper than the
 * radius — a cat head becomes a smooth oval-ish blob.
 */
export function roundMask(mask, W, H, radiusPx) {
  if (radiusPx <= 0) return mask;
  let m = erodeMask(dilateMask(mask, W, H, radiusPx), W, H, radiusPx); // closing
  m = dilateMask(erodeMask(m, W, H, radiusPx), W, H, radiusPx);        // opening
  return m;
}

/** Tight bounding box of the solid mask, in pixel coords. */
export function maskBounds(mask, W, H) {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('No silhouette found — try lowering the line sensitivity.');
  return { minX, minY, maxX, maxY };
}
