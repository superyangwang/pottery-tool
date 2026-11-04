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
 * Per-pixel colour distance from the background, 0..1, at the working
 * resolution. The background colour is the median of a ring of pixels around
 * the image border, so a photo of a rib lying on a table (any colour, lighter
 * or darker than the rib, with soft shadows) and a plain black-on-white
 * drawing both come out with the subject bright and the surroundings dark.
 * Transparent pixels are composited over white first.
 */
export function backgroundDistanceFromRGBA(data, width, height, maxSide) {
  const n = width * height;
  const chan = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3] / 255;
    const white = 255 * (1 - a);
    chan[0][i] = data[i * 4] * a + white;
    chan[1][i] = data[i * 4 + 1] * a + white;
    chan[2][i] = data[i * 4 + 2] * a + white;
  }
  const small = chan.map((c) => downsampleGray(c, width, height, maxSide));
  const W = small[0].width;
  const H = small[0].height;
  const [r, g, b] = small.map((c) => c.gray);

  // Median colour of the border ring.
  const ring = Math.max(2, Math.round(Math.min(W, H) * 0.03));
  const idx = [];
  for (let y = 0; y < H; y++) {
    const edgeRow = y < ring || y >= H - ring;
    for (let x = 0; x < W; x++) {
      if (edgeRow || x < ring || x >= W - ring) idx.push(y * W + x);
    }
  }
  const median = (c) => {
    const v = Float32Array.from(idx, (i) => c[i]).sort();
    return v[v.length >> 1];
  };
  const bg = [median(r), median(g), median(b)];

  const dist = new Float32Array(W * H);
  const norm = 1 / (255 * Math.sqrt(3));
  for (let i = 0; i < W * H; i++) {
    dist[i] = Math.hypot(r[i] - bg[0], g[i] - bg[1], b[i] - bg[2]) * norm;
  }
  return { dist, width: W, height: H, background: bg };
}

/**
 * Otsu's threshold on values in 0..1: the cut that best separates the two
 * main populations (background vs subject). Returns a value in 0..1.
 */
export function otsuThreshold(values) {
  const bins = 256;
  const hist = new Float64Array(bins);
  for (let i = 0; i < values.length; i++) {
    const k = Math.min(bins - 1, Math.max(0, (values[i] * bins) | 0));
    hist[k]++;
  }
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let thr = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = i;
    }
  }
  return (thr + 1) / bins;
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
 * @param {'ink'|'auto'} [opts.detect='ink']  'auto' separates the subject from the background colour (photos)
 * @param {number} [opts.autoBias=1]  scales the automatic cut-off; > 1 is stricter
 * @param {boolean} [opts.selectShape]  keep one shape when several are found (always on in auto mode)
 * @param {[number, number]|null} [opts.pick]  normalised (0..1) image point: use the shape under it
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
    // detect: 'ink' thresholds darkness (drawings); 'auto' picks the subject
    // out from whatever the background colour is (photos) with an Otsu cut
    // scaled by autoBias (> 1 = stricter, picks up less).
    detect = 'ink',
    autoBias = 1,
    selectShape = false,
    pick = null,
  } = opts;
  let gray, W, H, cut;
  if (detect === 'auto') {
    const d = backgroundDistanceFromRGBA(img.data, img.width, img.height, maxResolution);
    gray = d.dist;
    W = d.width;
    H = d.height;
    cut = Math.min(0.98, Math.max(0.02, otsuThreshold(gray) * autoBias));
  } else {
    const full = grayscaleFromRGBA(img.data, img.width, img.height);
    ({ gray, width: W, height: H } = downsampleGray(full, img.width, img.height, maxResolution));
    cut = threshold;
  }

  const ink = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) ink[i] = gray[i] > cut ? 1 : 0;

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

  // Photos: a morphological opening on the solid mask drops specks and thin
  // shadow slivers clinging to the edge.
  let out = mask;
  if (detect === 'auto') {
    const r = Math.max(1, Math.round(Math.min(W, H) * 0.004));
    out = dilateMask(erodeMask(mask, W, H, r), W, H, r);
  }

  // Several objects in frame (a rib photographed next to the bowl it
  // throws): keep one. The picked point wins; otherwise the shape with the
  // flattest shading - a rib is a flat plate of one colour, while a bowl or
  // a hand is shaded across its curves.
  const allMask = out;
  let shapes = 1;
  if (detect === 'auto' || selectShape) {
    const sel = selectComponent(out, gray, W, H, pick);
    out = sel.mask;
    shapes = sel.count;
  }

  // Guarantee a clear 1-pixel border so contours always close.
  for (let x = 0; x < W; x++) {
    out[x] = 0;
    out[(H - 1) * W + x] = 0;
  }
  for (let y = 0; y < H; y++) {
    out[y * W] = 0;
    out[y * W + W - 1] = 0;
  }

  // allMask: every shape found (for the picker thumbnail); mask: the one used.
  return { W, H, mask: out, allMask, shapes, cut };
}

// Keep one 4-connected solid blob of a mask. Candidates are blobs at least
// 15 % the size of the biggest one (specks never win). If `pick` lands on a
// blob that blob is used; otherwise the candidate whose `gray` values vary
// the least (flattest shading), ties going to the bigger one.
function selectComponent(mask, gray, W, H, pick) {
  const label = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const size = [0];
  const sum = [0];
  const sumSq = [0];
  let next = 0;
  for (let start = 0; start < W * H; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let n = 0;
    let s = 0;
    let s2 = 0;
    let top = 0;
    stack[top++] = start;
    label[start] = next;
    while (top) {
      const idx = stack[--top];
      n++;
      s += gray[idx];
      s2 += gray[idx] * gray[idx];
      const x = idx % W;
      const y = (idx / W) | 0;
      const visit = (k) => {
        if (mask[k] && !label[k]) {
          label[k] = next;
          stack[top++] = k;
        }
      };
      if (x > 0) visit(idx - 1);
      if (x < W - 1) visit(idx + 1);
      if (y > 0) visit(idx - W);
      if (y < H - 1) visit(idx + W);
    }
    size.push(n);
    sum.push(s);
    sumSq.push(s2);
  }
  if (next === 0) return { mask, count: 0 };

  let largest = 0;
  for (let k = 1; k <= next; k++) if (size[k] > largest) largest = size[k];
  const candidates = [];
  for (let k = 1; k <= next; k++) if (size[k] >= largest * 0.15) candidates.push(k);

  let chosen = 0;
  if (pick) {
    const px = Math.round(Math.min(1, Math.max(0, pick[0])) * (W - 1));
    const py = Math.round(Math.min(1, Math.max(0, pick[1])) * (H - 1));
    chosen = label[py * W + px];
  }
  if (!chosen) {
    let bestVar = Infinity;
    for (const k of candidates) {
      const mean = sum[k] / size[k];
      const v = sumSq[k] / size[k] - mean * mean;
      if (v < bestVar - 1e-6 || (Math.abs(v - bestVar) <= 1e-6 && size[k] > size[chosen])) {
        bestVar = v;
        chosen = k;
      }
    }
  }
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = label[i] === chosen ? 1 : 0;
  return { mask: out, count: candidates.length };
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
