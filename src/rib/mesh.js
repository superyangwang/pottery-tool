// Pottery rib: a flat tool traced from a silhouette image.
//
//   side view (looking along X)            z+ ^
//                                             |   top face = outline inset by T*tan(angle)
//        .-------------------------.  z = T   |  .------------.
//       /  bevelled working edge    \         | /              \   bevel wall
//      /                             \ z = 0  |/                \
//     '-------------------------------'       '------------------' bottom face = full outline
//     |=========== foot rail ==========|
//        (optional thicker band along the bottom edge, footHeight tall,
//         footBottomWidth thick, centred on the rib thickness)
//
// Coordinates: X = image x, Y = image up (bottom edge of the outline at
// y = 0 while building, re-centred at the end), Z = thickness. The outline is
// scaled so its widest span across the bottom band equals `footWidthMm`.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { traceShapes } from '../plate/tracer.js';
import { erodeMask } from '../plate/silhouette.js';

const MAX_ANGLE_DEG = 80;
// Bottom span is measured across the lowest 6 % of the outline's height, so a
// rounded bottom corner still counts as part of the "bottom".
const BOTTOM_BAND_FRACTION = 0.06;

/**
 * @param {{ W: number, H: number, mask: Uint8Array }} sil  from buildSilhouette
 * @param {object} opts
 * @param {number} opts.footWidthMm        widest span across the bottom edge
 * @param {number} opts.thicknessMm        rib thickness (Z)
 * @param {number} [opts.edgeAngleDeg=45]  bevel angle from vertical; 0 = square cut
 * @param {'none'|'foot'} [opts.bottomShape='none']
 * @param {number} [opts.footHeightMm]     how far the foot rail reaches up the rib
 * @param {number} [opts.footBottomWidthMm] foot rail thickness (Z): the surface it stands on
 * @param {number} [opts.smoothIterations=1]
 */
export function buildRibGeometry(sil, opts) {
  const {
    footWidthMm,
    thicknessMm,
    edgeAngleDeg = 45,
    bottomShape = 'none',
    footHeightMm = 0,
    footBottomWidthMm = 0,
    smoothIterations = 1,
  } = opts;
  const { mask, W, H } = sil;

  if (!(footWidthMm > 0)) throw new Error('Bottom foot width must be greater than zero.');
  if (!(thicknessMm > 0)) throw new Error('Rib thickness must be greater than zero.');

  const outerPx = largestOuter(traceShapes(mask, W, H, { simplifyTol: 1, smoothIterations }));
  if (!outerPx) throw new Error('No silhouette found - try adjusting line sensitivity.');

  // Bounding box in pixel coords (image is y-down, so the bottom is maxY).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outerPx) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightPx = maxY - minY;
  // Measure the bottom span on the raw mask rows (not the traced loop), so
  // simplification/smoothing of the outline can't round the corners away.
  const band = Math.max(1, heightPx * BOTTOM_BAND_FRACTION);
  const rowLo = Math.max(0, Math.floor(maxY - band));
  const rowHi = Math.min(H - 1, Math.ceil(maxY));
  let bMin = Infinity, bMax = -Infinity;
  for (let y = rowLo; y <= rowHi; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        if (x < bMin) bMin = x;
        if (x > bMax) bMax = x;
      }
    }
  }
  const bottomSpanPx = bMax > bMin ? bMax - bMin + 1 : maxX - minX;

  // Pixel -> mm: bottom span = footWidthMm, bottom edge at y = 0, centred in X.
  const scale = footWidthMm / bottomSpanPx;
  const cxPx = (minX + maxX) / 2;
  const toMm = ([x, y]) => [(x - cxPx) * scale, (maxY - y) * scale];

  let outer = outerPx.map(toMm);
  if (polygonArea(outer) < 0) outer = outer.slice().reverse(); // CCW

  const widthMm = (maxX - minX) * scale;
  const heightMm = heightPx * scale;
  const T = thicknessMm;

  // ---- Working-edge bevel: top contour = outline eroded by T*tan(angle) ----
  const angle = Math.max(0, Math.min(MAX_ANGLE_DEG, edgeAngleDeg));
  const insetMm = T * Math.tan((angle * Math.PI) / 180);
  let inner = outer;
  if (insetMm > 1e-6) {
    const insetPx = insetMm / scale;
    const eroded = erodeMask(mask, W, H, insetPx);
    const innerPx = largestOuter(traceShapes(eroded, W, H, { simplifyTol: 1, smoothIterations }));
    if (!innerPx) {
      throw new Error(
        `A ${angle} degree edge on a ${T.toFixed(1)} mm thick rib bevels away the whole top face ` +
        `(inset ${insetMm.toFixed(1)} mm) - lower the angle or the thickness.`
      );
    }
    inner = innerPx.map(toMm);
    if (polygonArea(inner) < 0) inner = inner.slice().reverse();
  }

  const geoms = [];
  const p = [];
  const tri = (...v) => p.push(...v);

  // Bottom face at z = 0, facing down.
  const bottomGeo = new THREE.ShapeGeometry(pointsToShape(outer)).toNonIndexed();
  flipWinding(bottomGeo);
  geoms.push(bottomGeo);

  // Top face at z = T (the inset contour), facing up.
  const topGeo = new THREE.ShapeGeometry(pointsToShape(inner));
  topGeo.translate(0, 0, T);
  geoms.push(topGeo);

  // Bevel wall: loft between the two contours.
  loftLoops(outer, 0, inner, T, tri);

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
    const railOutline = clipBelow(outer, footHeightMm);
    if (railOutline.length >= 3) {
      const z0 = (T - footBottomWidthMm) / 2;
      const z1 = (T + footBottomWidthMm) / 2;
      const railBottom = new THREE.ShapeGeometry(pointsToShape(railOutline)).toNonIndexed();
      flipWinding(railBottom);
      railBottom.translate(0, 0, z0);
      geoms.push(railBottom);
      const railTop = new THREE.ShapeGeometry(pointsToShape(railOutline));
      railTop.translate(0, 0, z1);
      geoms.push(railTop);
      for (let i = 0; i < railOutline.length; i++) {
        const [x0, y0] = railOutline[i];
        const [x1, y1] = railOutline[(i + 1) % railOutline.length];
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
      foot,
      triangles: merged.getAttribute('position').count / 3,
    },
  };
}

// Pick the biggest outer loop from traceShapes output (ignores holes/specks).
function largestOuter(shapes) {
  let best = null;
  let bestArea = 0;
  for (const s of shapes) {
    const a = Math.abs(polygonArea(s.outer));
    if (a > bestArea) {
      bestArea = a;
      best = s.outer;
    }
  }
  return best;
}

// Connect two CCW loops at different heights with a strip of triangles,
// advancing along whichever loop lags in normalised arc length ("zipper").
// Works for loops with different vertex counts. Triangles face outward.
function loftLoops(a, za, bIn, zb, tri) {
  const n = a.length;
  // Rotate b so it starts at the vertex nearest a[0].
  let start = 0;
  let bestD = Infinity;
  for (let j = 0; j < bIn.length; j++) {
    const dx = bIn[j][0] - a[0][0];
    const dy = bIn[j][1] - a[0][1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      start = j;
    }
  }
  const b = bIn.slice(start).concat(bIn.slice(0, start));
  const m = b.length;
  const ta = arcParams(a);
  const tb = arcParams(b);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    const advanceA = j >= m || (i < n && ta[i + 1] <= tb[j + 1]);
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

function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

function pointsToShape(pts) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
  shape.closePath();
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
