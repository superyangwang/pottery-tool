// Pottery rib: a flat tool traced from a silhouette image.
//
//   side view (looking along X)            z+ ^
//                                             |   top face = outline inset by T*tan(angle)
//        .-------------------------.  z = T   |  .------------.
//       /  bevelled working edge    \         | /              \   bevel wall
//      /                             \ z = 0  |/                \
//     '-------------------------------'       '------------------' bottom face = full outline
//
// Foot rail (optional): a plain square-edged band along the bottom edge,
// footHeight tall and footBottomWidth thick, centred on the rib thickness
// (z0 below the bottom face, z1 above the top face). The bevel angle does
// not apply to it.
//
// Holes in the silhouette (a thumb hole) are kept: they get the same bevel,
// so the hole widens towards the top face.
//
// Coordinates: X = image x, Y = image up (bottom edge of the outline at
// y = 0 while building, re-centred at the end), Z = thickness. The outline is
// scaled so its widest span across the bottom band equals `footWidthMm`.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { traceShapes } from '../plate/tracer.js';

const MAX_ANGLE_DEG = 80;
// Bottom span is measured across the lowest 6 % of the outline's height, so a
// rounded bottom corner still counts as part of the "bottom".
const BOTTOM_BAND_FRACTION = 0.06;
const MIN_HOLE_AREA_PX = 16;

/**
 * @param {{ W: number, H: number, mask: Uint8Array }} sil  from buildSilhouette
 * @param {object} opts
 * @param {number} opts.footWidthMm        widest span across the bottom edge
 * @param {number} opts.thicknessMm        rib thickness (Z)
 * @param {number} [opts.edgeAngleDeg=45]  bevel angle from vertical; 0 = square cut
 * @param {'none'|'foot'} [opts.bottomShape='none']
 * @param {number} [opts.footHeightMm]     how far the foot rail reaches up the rib
 * @param {number} [opts.footBottomWidthMm] foot rail thickness (Z): the surface it stands on
 * @param {number} [opts.smoothIterations=3]
 */
export function buildRibGeometry(sil, opts) {
  const {
    footWidthMm,
    thicknessMm,
    edgeAngleDeg = 45,
    bottomShape = 'none',
    footHeightMm = 0,
    footBottomWidthMm = 0,
    smoothIterations = 3,
  } = opts;
  const { mask, W, H } = sil;

  if (!(footWidthMm > 0)) throw new Error('Bottom foot width must be greater than zero.');
  if (!(thicknessMm > 0)) throw new Error('Rib thickness must be greater than zero.');

  // Trace at full half-pixel resolution, then smooth with a Gaussian along
  // the contour: pixel staircase on long curves disappears while sharp
  // corners are only rounded by ~sigma pixels (Chaikin would round a corner
  // by a quarter of its neighbouring edges, visibly distorting a square
  // corner next to a long straight side).
  const sigmaPx = 1.5 * Math.max(0, Math.min(3, smoothIterations));
  const traceOpts = { simplifyTol: 0, smoothIterations: 0 };
  const traceSmooth = (m) =>
    traceShapes(m, W, H, traceOpts).map((s) => ({
      outer: smoothLoop(s.outer, sigmaPx),
      holes: s.holes.map((h) => smoothLoop(h, sigmaPx)),
    }));
  const base = largestShape(traceSmooth(mask));
  if (!base) throw new Error('No silhouette found - try adjusting line sensitivity.');
  const outerPx = base.outer;

  // Bounding box in pixel coords (image is y-down, so the bottom is maxY).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outerPx) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightPx = maxY - minY;
  // Bottom span = widest horizontal cut through the outline polygon within
  // the bottom band. Scanning the polygon (not vertices, not raw mask rows)
  // is robust to corner smoothing and to specks/shadow outside the outline.
  const band = Math.max(1, heightPx * BOTTOM_BAND_FRACTION);
  let bottomSpanPx = 0;
  for (let k = 0; k <= 8; k++) {
    const span = polygonWidthAtY(outerPx, maxY - (band * k) / 8);
    if (span > bottomSpanPx) bottomSpanPx = span;
  }
  if (!(bottomSpanPx > 0)) bottomSpanPx = maxX - minX;

  // Pixel -> mm: bottom span = footWidthMm, bottom edge at y = 0, centred in X.
  const scale = footWidthMm / bottomSpanPx;
  const cxPx = (minX + maxX) / 2;
  const toMm = ([x, y]) => [(x - cxPx) * scale, (maxY - y) * scale];
  const toMmLoop = (loop, ccw) => {
    const out = loop.map(toMm);
    return (polygonArea(out) > 0) === ccw ? out : out.slice().reverse();
  };

  const outer = toMmLoop(outerPx, true); // CCW
  const holes = base.holes
    .filter((h) => Math.abs(polygonArea(h)) >= MIN_HOLE_AREA_PX)
    .map((h) => toMmLoop(h, false)); // CW

  const widthMm = (maxX - minX) * scale;
  const heightMm = heightPx * scale;
  const T = thicknessMm;

  // Exact Euclidean distance (px) from every solid pixel to the background:
  // one transform, thresholded at whatever inset each contour needs.
  const distSq = euclideanDistanceSq(mask, W, H);
  const erodedShape = (insetMm) => {
    const r = insetMm / scale;
    const r2 = r * r;
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) m[i] = distSq[i] > r2 ? 1 : 0;
    return largestShape(traceSmooth(m));
  };

  // ---- Working-edge bevel: top contour = outline eroded by T*tan(angle) ----
  const angle = Math.max(0, Math.min(MAX_ANGLE_DEG, edgeAngleDeg));
  const tanA = Math.tan((angle * Math.PI) / 180);
  const insetMm = T * tanA;
  let innerOuter = outer;
  let innerHoles = holes;
  if (insetMm > 1e-6) {
    const e = erodedShape(insetMm);
    if (!e) {
      throw new Error(
        `A ${angle} degree edge on a ${T.toFixed(1)} mm thick rib bevels away the whole top face ` +
        `(inset ${insetMm.toFixed(1)} mm) - lower the angle or the thickness.`
      );
    }
    innerOuter = toMmLoop(e.outer, true);
    const eHoles = e.holes
      .filter((h) => Math.abs(polygonArea(h)) >= MIN_HOLE_AREA_PX)
      .map((h) => toMmLoop(h, false));
    // Each original hole sits inside exactly one (larger) eroded hole.
    innerHoles = holes.map((h) => {
      const match = eHoles.find((eh) => pointInPolygon(h[0], eh));
      if (!match) {
        throw new Error(
          `The ${angle} degree bevel (${insetMm.toFixed(1)} mm) breaks the hole out through ` +
          `the edge - lower the angle or thickness, or move the hole inward.`
        );
      }
      return match;
    });
  }

  const geoms = [];
  const p = [];
  const tri = (...v) => p.push(...v);

  // Bottom face at z = 0 (full outline with holes), facing down.
  const bottomGeo = new THREE.ShapeGeometry(pointsToShape(outer, holes)).toNonIndexed();
  flipWinding(bottomGeo);
  geoms.push(bottomGeo);

  // Top face at z = T (inset outline with widened holes), facing up.
  const topGeo = new THREE.ShapeGeometry(pointsToShape(innerOuter, innerHoles));
  topGeo.translate(0, 0, T);
  geoms.push(topGeo);

  // Bevel walls: outer edge and every hole edge.
  loftLoops(outer, 0, innerOuter, T, tri);
  for (let k = 0; k < holes.length; k++) loftLoops(holes[k], 0, innerHoles[k], T, tri);

  // ---- Optional foot rail along the bottom edge ----
  let foot = null;
  if (bottomShape === 'foot') {
    if (!(footHeightMm > 0)) throw new Error('Foot height must be greater than zero.');
    if (footHeightMm >= heightMm) {
      throw new Error(
        `Foot height must be less than the rib height (${heightMm.toFixed(1)} mm).`
      );
    }
    if (!(footBottomWidthMm > T)) {
      throw new Error(
        `Foot bottom width must be larger than the rib thickness (${T.toFixed(1)} mm) ` +
        `for the foot to stand proud of the faces.`
      );
    }
    // The rail is a plain square-edged band: the bevel angle does not apply
    // to it, so there is no angle-based constraint on the foot height.
    const z0 = (T - footBottomWidthMm) / 2; // below the bottom face
    const z1 = (T + footBottomWidthMm) / 2; // above the top face
    const rail = clipBelow(outer, footHeightMm);
    if (rail.length >= 3) {
      const railBottom = new THREE.ShapeGeometry(pointsToShape(rail)).toNonIndexed();
      flipWinding(railBottom);
      railBottom.translate(0, 0, z0);
      geoms.push(railBottom);
      const railTop = new THREE.ShapeGeometry(pointsToShape(rail));
      railTop.translate(0, 0, z1);
      geoms.push(railTop);
      for (let i = 0; i < rail.length; i++) {
        const [x0, y0] = rail[i];
        const [x1, y1] = rail[(i + 1) % rail.length];
        tri(x0, y0, z0, x1, y1, z0, x1, y1, z1);
        tri(x0, y0, z0, x1, y1, z1, x0, y0, z1);
      }
      foot = { heightMm: footHeightMm, bottomWidthMm: footBottomWidthMm, z0, z1 };
    }
  }

  const soup = new THREE.BufferGeometry();
  soup.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
  geoms.push(soup);

  const normalized = geoms.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(ng.attributes)) {
      if (name !== 'position') ng.deleteAttribute(name);
    }
    return ng;
  });
  const merged = mergeGeometries(normalized, false);
  // Centre the rib in the viewer (the bottom edge was at y = 0 while building)
  // and, with a foot, lift it so the lowest surface sits on z = 0.
  merged.translate(0, -heightMm / 2, foot ? -foot.z0 : 0);
  merged.computeVertexNormals();

  return {
    geometry: merged,
    info: {
      widthMm,
      heightMm,
      thicknessMm: T,
      footWidthMm,
      edgeAngleDeg: angle,
      bevelInsetMm: insetMm,
      holes: holes.length,
      foot,
      triangles: merged.getAttribute('position').count / 3,
      // Outer loop in mm with the bottom edge at y = 0 (before the viewer
      // re-centring) - the pot preview reads its wall profile from this.
      outlineMm: outer,
    },
  };
}

// Pick the biggest shape (outer loop + its holes) from traceShapes output.
function largestShape(shapes) {
  let best = null;
  let bestArea = 0;
  for (const s of shapes) {
    const a = Math.abs(polygonArea(s.outer));
    if (a > bestArea) {
      bestArea = a;
      best = s;
    }
  }
  return best;
}

// Exact squared Euclidean distance from each solid pixel to the nearest
// background pixel (Felzenszwalb & Huttenlocher lower-envelope transform).
// Unlike the chamfer transform this erodes circles into circles, so the
// bevel contour stays round.
function euclideanDistanceSq(mask, W, H) {
  const INF = 1e12;
  const g = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = mask[i] ? INF : 0;
  const n = Math.max(W, H);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = g[y * W + x];
    edt1d(f, H, d, v, z);
    for (let y = 0; y < H; y++) g[y * W + x] = d[y];
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    edt1d(f, W, d, v, z);
    for (let x = 0; x < W; x++) g[y * W + x] = d[x];
  }
  return g;
}

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// Connect two loops (same winding) at different heights with a strip of
// triangles. Each vertex of `b` is matched to its nearest point on `a`, so
// an offset contour maps onto the original without drifting, and the two
// vertex streams are merged in parameter order ("zipper"). Triangles face
// away from the solid for a CCW outer loop and a CW hole loop.
function loftLoops(aIn, za, bIn, zb, tri) {
  const n = aIn.length;
  const m = bIn.length;
  if (n < 3 || m < 3) return;
  const taRaw = arcParams(aIn);
  const sRaw = bIn.map((pt) => projectParam(aIn, taRaw, pt));

  // Rotate b so its parameters start at the smallest value and are monotonic.
  let j0 = 0;
  for (let j = 1; j < m; j++) if (sRaw[j] < sRaw[j0]) j0 = j;
  const b = bIn.slice(j0).concat(bIn.slice(0, j0));
  const s = new Float64Array(m + 1);
  for (let j = 0; j < m; j++) s[j] = sRaw[(j + j0) % m];
  for (let j = 1; j < m; j++) if (s[j] < s[j - 1]) s[j] = s[j - 1];
  const s0 = s[0];
  for (let j = 0; j < m; j++) s[j] -= s0;
  s[m] = 1;

  // Rotate a so it starts at the last vertex at or before s0, re-based to 0.
  let i0 = 0;
  for (let i = 0; i < n; i++) if (taRaw[i] <= s0) i0 = i;
  const a = aIn.slice(i0).concat(aIn.slice(0, i0));
  const ta = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let t = taRaw[(i + i0) % n] - s0;
    if (i > 0 && t < 0) t += 1;
    ta[i] = Math.max(0, t);
  }
  ta[n] = 1;

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const advanceA = j >= m || (i < n && ta[i + 1] <= s[j + 1]);
    if (advanceA) {
      const [x0, y0] = a[i];
      const [x1, y1] = a[(i + 1) % n];
      const [qx, qy] = b[j % m];
      tri(x0, y0, za, x1, y1, za, qx, qy, zb);
      i++;
    } else {
      const [px, py] = a[i % n];
      const [x0, y0] = b[j];
      const [x1, y1] = b[(j + 1) % m];
      tri(px, py, za, x1, y1, zb, x0, y0, zb);
      j++;
    }
  }
}

// Smooth a closed pixel-space loop: resample at 1 px spacing, circular
// Gaussian blur (sigma in px), then drop near-collinear vertices.
function smoothLoop(loop, sigma) {
  if (loop.length < 4) return loop;
  const pts = resampleLoop(loop, 1);
  const n = pts.length;
  let out = pts;
  if (sigma > 0 && n > 8) {
    const r = Math.min(Math.ceil(sigma * 3), Math.floor((n - 1) / 2));
    const w = new Float64Array(r + 1);
    let wsum = 0;
    for (let k = 0; k <= r; k++) {
      w[k] = Math.exp(-(k * k) / (2 * sigma * sigma));
      wsum += k === 0 ? w[k] : 2 * w[k];
    }
    out = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = pts[i][0] * w[0];
      let y = pts[i][1] * w[0];
      for (let k = 1; k <= r; k++) {
        const a = pts[(i + k) % n];
        const b = pts[(i - k + n) % n];
        x += (a[0] + b[0]) * w[k];
        y += (a[1] + b[1]) * w[k];
      }
      out[i] = [x / wsum, y / wsum];
    }
  }
  return simplifyLoop(out, 0.05);
}

// Resample a closed polyline at (approximately) `step` spacing by arc length.
function resampleLoop(loop, step) {
  const n = loop.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % n];
    total += Math.hypot(x1 - x0, y1 - y0);
  }
  const count = Math.max(8, Math.round(total / step));
  const ds = total / count;
  const out = [];
  let i = 0;
  let segStart = 0;
  let [x0, y0] = loop[0];
  let [x1, y1] = loop[1 % n];
  let segLen = Math.hypot(x1 - x0, y1 - y0);
  for (let k = 0; k < count; k++) {
    const target = k * ds;
    while (segStart + segLen < target && i < n - 1) {
      i++;
      segStart += segLen;
      [x0, y0] = loop[i];
      [x1, y1] = loop[(i + 1) % n];
      segLen = Math.hypot(x1 - x0, y1 - y0);
    }
    const u = segLen > 0 ? Math.min(1, (target - segStart) / segLen) : 0;
    out.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * u]);
  }
  return out;
}

// Douglas-Peucker on a closed loop (split at the two farthest-apart anchors).
function simplifyLoop(loop, tol) {
  const n = loop.length;
  if (n < 6) return loop;
  let far = 0;
  let bestD = -1;
  for (let i = 1; i < n; i++) {
    const d = (loop[i][0] - loop[0][0]) ** 2 + (loop[i][1] - loop[0][1]) ** 2;
    if (d > bestD) {
      bestD = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[far] = 1;
  const t2 = tol * tol;
  const stack = [[0, far], [far, n]]; // second range wraps to index 0 via % n
  while (stack.length) {
    const [lo, hi] = stack.pop();
    const a = loop[lo % n];
    const b = loop[hi % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const den = dx * dx + dy * dy || 1e-12;
    let maxD = -1;
    let maxI = -1;
    for (let i = lo + 1; i < hi; i++) {
      const p = loop[i % n];
      const u = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / den;
      const cx = a[0] + dx * u;
      const cy = a[1] + dy * u;
      const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
      if (d > maxD) {
        maxD = d;
        maxI = i;
      }
    }
    if (maxD > t2) {
      keep[maxI % n] = 1;
      stack.push([lo, maxI], [maxI, hi]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(loop[i]);
  return out.length >= 3 ? out : loop;
}

// Cumulative normalised arc length, length n + 1 with t[0] = 0 and t[n] = 1.
function arcParams(loop) {
  const n = loop.length;
  const t = new Float64Array(n + 1);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % n];
    acc += Math.hypot(x1 - x0, y1 - y0);
    t[i + 1] = acc;
  }
  const total = acc || 1;
  for (let i = 0; i <= n; i++) t[i] /= total;
  t[n] = 1;
  return t;
}

// Arc-length parameter (0..1) of the point on closed polyline `loop` nearest to pt.
function projectParam(loop, t, pt) {
  const n = loop.length;
  let best = Infinity;
  let bestParam = 0;
  const [px, py] = pt;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = loop[i];
    const [bx, by] = loop[(i + 1) % n];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let u = ((px - ax) * dx + (py - ay) * dy) / len2;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const cx = ax + dx * u;
    const cy = ay + dy * u;
    const d = (px - cx) * (px - cx) + (py - cy) * (py - cy);
    if (d < best) {
      best = d;
      bestParam = t[i] + (t[i + 1] - t[i]) * u;
    }
  }
  return bestParam >= 1 ? 0 : bestParam;
}

// Sutherland-Hodgman clip of a polygon against the half-plane y <= h.
function clipBelow(poly, h) {
  const n = poly.length;
  const out = [];
  const cross = (a, b) => {
    const t = (h - a[1]) / (b[1] - a[1] || 1e-9);
    return [a[0] + (b[0] - a[0]) * t, h];
  };
  for (let i = 0; i < n; i++) {
    const prev = poly[(i - 1 + n) % n];
    const cur = poly[i];
    const pIn = prev[1] <= h;
    const cIn = cur[1] <= h;
    if (cIn) {
      if (!pIn) out.push(cross(prev, cur));
      out.push(cur);
    } else if (pIn) {
      out.push(cross(prev, cur));
    }
  }
  return out;
}

// Width of a polygon's cut by the horizontal line at `y` (0 if it misses).
function polygonWidthAtY(poly, y) {
  let lo = Infinity;
  let hi = -Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % n];
    if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
      const x = x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return hi > lo ? hi - lo : 0;
}

function pointInPolygon([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

function pointsToShape(pts, holes = []) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
  for (const h of holes) {
    const path = new THREE.Path();
    path.moveTo(h[0][0], h[0][1]);
    for (let i = 1; i < h.length; i++) path.lineTo(h[i][0], h[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

function flipWinding(geometry) {
  const pos = geometry.getAttribute('position');
  for (let t = 0; t < pos.count; t += 3) {
    const bx = pos.getX(t + 1), by = pos.getY(t + 1), bz = pos.getZ(t + 1);
    pos.setXYZ(t + 1, pos.getX(t + 2), pos.getY(t + 2), pos.getZ(t + 2));
    pos.setXYZ(t + 2, bx, by, bz);
  }
  pos.needsUpdate = true;
}
