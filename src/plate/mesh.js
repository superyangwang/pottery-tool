// Build the plate geometry: the silhouette extruded to a uniform thickness,
// with a circular dish cavity recessed into the top surface.
//
//            ┌──────── top face (silhouette minus cavity circle) at z = T
//   z+ ▲  ┌──┴──╮  ╭────╮  ╭──┐
//      │  │     ╰──┤    ├──╯  │   cavity: flat floor + vertical wall, or a
//      │  │  wall  ╰────╯     │   spherical-cap bowl. Rim at z = T, lowest
//   0 ─┴──┴───────────────────┴─  point at z = T - depth.
//         bottom face at z = 0
//
// The cavity is centered on the silhouette's incenter (center of the largest
// inscribed circle) and its radius = inscribedRadius - edgeMargin, so the rim
// always keeps at least `edgeMargin` of material to the silhouette edge.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { traceShapes } from './tracer.js';
import { largestInscribedCircle, erodeMask } from './silhouette.js';

const CAVITY_SEGMENTS = 128; // around the cavity circle
const CAP_RINGS = 48;        // rim-to-center rings for the curved bowl
const MIN_CAVITY_RADIUS_MM = 3;
const MIN_FLOOR_MM = 0.8;

/**
 * @param {{ W: number, H: number, mask: Uint8Array }} sil  from buildSilhouette
 * @param {object} opts
 * @param {number} opts.plateWidthMm     overall silhouette width (X extent)
 * @param {number} opts.thicknessMm     plate thickness (default 25.4 = 1 in)
 * @param {number} opts.cavityMarginMm  distance kept between cavity rim and
 *                                      the silhouette edge
 * @param {number} opts.cavityDepthMm   depth of the recess
 * @param {'flat'|'curved'|'foam'} opts.cavityProfile
 *        foam = "foam press": no recess at all — the largest smooth ellipse
 *        (circle/oval) that fits inside the silhouette at cavityMarginMm
 *        from the edge is cut clean through the plate, keeping both the
 *        outer frame and the center piece. Thin features (ears) can't fit
 *        an ellipse, so they're ignored automatically.
 * @param {number} [opts.cutGapMm=0.5]  clearance between the two foam-press
 *        pieces so they separate after printing
 * @param {number} [opts.smoothIterations=1]
 * @returns {{ geometry: THREE.BufferGeometry, info: object }}
 */
export function buildPlateGeometry(sil, opts) {
  const {
    plateWidthMm,
    thicknessMm,
    cavityMarginMm,
    cavityDepthMm,
    cavityProfile = 'curved',
    cutGapMm = 0.5,
    smoothIterations = 1,
  } = opts;
  const { mask, W, H } = sil;

  const shapesPx = traceShapes(mask, W, H, { simplifyTol: 1, smoothIterations });
  if (shapesPx.length === 0) {
    throw new Error('No silhouette found — try adjusting line sensitivity.');
  }
  // The silhouette is flood-filled, so there should be a single dominant
  // outer loop. Pick the largest; ignore stray specks.
  let outerPx = null;
  let bestArea = 0;
  for (const s of shapesPx) {
    const a = Math.abs(polygonArea(s.outer));
    if (a > bestArea) {
      bestArea = a;
      outerPx = s.outer;
    }
  }

  // Pixel -> mm: fit the loop's bounding-box width to plateWidthMm,
  // preserve aspect, center on the bbox center, flip Y (image is y-down).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of outerPx) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const scale = plateWidthMm / (maxX - minX);
  const cxPx = (minX + maxX) / 2;
  const cyPx = (minY + maxY) / 2;
  const toMm = ([x, y]) => [(x - cxPx) * scale, (cyPx - y) * scale];

  let outer = outerPx.map(toMm);
  if (polygonArea(outer) < 0) outer = outer.slice().reverse(); // ensure CCW

  if (cavityProfile === 'foam') {
    return buildFoamPress(sil, {
      outer,
      toMm,
      scale,
      plateWidthMm,
      plateDepthMm: (maxY - minY) * scale,
      thicknessMm,
      cavityMarginMm,
      cutGapMm,
    });
  }

  // Cavity placement from the mask's incenter.
  const inc = largestInscribedCircle(mask, W, H);
  const inscribedRadiusMm = inc.radiusPx * scale;
  const [ccx, ccy] = toMm([inc.cx, inc.cy]);
  const cavityR = inscribedRadiusMm - cavityMarginMm;
  const maxMarginMm = inscribedRadiusMm - MIN_CAVITY_RADIUS_MM;

  if (cavityR < MIN_CAVITY_RADIUS_MM) {
    throw new Error(
      `Cavity edge distance is too large for this shape — ` +
      `maximum is about ${(maxMarginMm).toFixed(1)} mm ` +
      `(${(maxMarginMm / 25.4).toFixed(2)} in).`
    );
  }
  const floorMm = thicknessMm - cavityDepthMm;
  if (floorMm < MIN_FLOOR_MM) {
    throw new Error(
      `Cavity depth leaves only ${floorMm.toFixed(2)} mm of floor — ` +
      `keep it at least ${MIN_FLOOR_MM} mm below the plate thickness.`
    );
  }
  if (cavityProfile === 'curved' && cavityDepthMm > cavityR) {
    throw new Error(
      `Curved profile needs depth ≤ cavity radius (${cavityR.toFixed(1)} mm) — ` +
      `reduce the depth or switch to a flat floor.`
    );
  }

  const T = thicknessMm;
  const B = T - cavityDepthMm; // cavity low point

  // Cavity rim ring, CCW viewed from +Z. Shared verbatim between the
  // top-face hole and the cavity surface so the mesh stays watertight.
  const ring = [];
  for (let k = 0; k < CAVITY_SEGMENTS; k++) {
    const t = (k / CAVITY_SEGMENTS) * Math.PI * 2;
    ring.push([ccx + cavityR * Math.cos(t), ccy + cavityR * Math.sin(t)]);
  }

  const geoms = [];

  // Top face: silhouette with the cavity circle punched out, at z = T.
  const topShape = pointsToShape(outer);
  const hole = new THREE.Path();
  hole.moveTo(ring[CAVITY_SEGMENTS - 1][0], ring[CAVITY_SEGMENTS - 1][1]);
  for (let k = CAVITY_SEGMENTS - 2; k >= 0; k--) hole.lineTo(ring[k][0], ring[k][1]);
  hole.closePath();
  topShape.holes.push(hole);
  const topGeo = new THREE.ShapeGeometry(topShape);
  topGeo.translate(0, 0, T);
  geoms.push(topGeo);

  // Bottom face: full silhouette at z = 0, facing down.
  const bottomGeo = new THREE.ShapeGeometry(pointsToShape(outer)).toNonIndexed();
  flipWinding(bottomGeo);
  geoms.push(bottomGeo);

  // Outer wall + cavity surface as raw triangle soup.
  const p = [];
  const tri = (...v) => p.push(...v);

  // Outer wall: for a CCW outer loop these quads face outward.
  for (let i = 0; i < outer.length; i++) {
    const [x0, y0] = outer[i];
    const [x1, y1] = outer[(i + 1) % outer.length];
    tri(x0, y0, 0, x1, y1, 0, x1, y1, T);
    tri(x0, y0, 0, x1, y1, T, x0, y0, T);
  }

  if (cavityProfile === 'flat') {
    // Vertical wall from rim down to the floor, facing the cavity axis.
    for (let k = 0; k < CAVITY_SEGMENTS; k++) {
      const [x0, y0] = ring[k];
      const [x1, y1] = ring[(k + 1) % CAVITY_SEGMENTS];
      tri(x0, y0, T, x1, y1, T, x1, y1, B);
      tri(x0, y0, T, x1, y1, B, x0, y0, B);
    }
    // Flat floor disc at z = B, facing up.
    for (let k = 0; k < CAVITY_SEGMENTS; k++) {
      const [x0, y0] = ring[k];
      const [x1, y1] = ring[(k + 1) % CAVITY_SEGMENTS];
      tri(ccx, ccy, B, x0, y0, B, x1, y1, B);
    }
  } else {
    // Spherical-cap bowl. Sphere radius from rim radius + sag:
    // Rs = (r² + d²) / 2d, center on the cavity axis at z = B + Rs.
    const d = cavityDepthMm;
    const Rs = (cavityR * cavityR + d * d) / (2 * d);
    const thetaRim = Math.asin(Math.min(1, cavityR / Rs));
    const ringAt = (theta) => {
      const rho = Rs * Math.sin(theta);
      const z = B + Rs - Rs * Math.cos(theta);
      return { rho, z };
    };
    let prev = ring.map(([x, y]) => [x, y, T]);
    for (let j = 1; j <= CAP_RINGS; j++) {
      const { rho, z } = ringAt(thetaRim * (1 - j / CAP_RINGS));
      const cur = [];
      for (let k = 0; k < CAVITY_SEGMENTS; k++) {
        const t = (k / CAVITY_SEGMENTS) * Math.PI * 2;
        cur.push([ccx + rho * Math.cos(t), ccy + rho * Math.sin(t), z]);
      }
      for (let k = 0; k < CAVITY_SEGMENTS; k++) {
        const a = prev[k];
        const b = prev[(k + 1) % CAVITY_SEGMENTS];
        const c = cur[(k + 1) % CAVITY_SEGMENTS];
        const e = cur[k];
        tri(...a, ...b, ...c);
        if (j < CAP_RINGS) tri(...a, ...c, ...e); // last ring collapses to a point
      }
      prev = cur;
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
  merged.computeVertexNormals();

  return {
    geometry: merged,
    info: {
      profile: cavityProfile,
      plateWidthMm,
      plateDepthMm: (maxY - minY) * scale,
      thicknessMm,
      cavityDiameterMm: cavityR * 2,
      cavityDepthMm,
      floorMm,
      maxMarginMm,
      cavityCenterMm: [ccx, ccy],
    },
  };
}

// Foam press: the plate stays solid at full thickness, and the largest
// smooth ellipse (circle/oval) that fits `cavityMarginMm` inside the
// silhouette is cut clean through it, like the commercial foam-press tools.
// Both pieces are kept and printed in place, separated by a small clearance
// gap so they come apart after printing. Thin features (the cat's ears)
// can't contain an ellipse, so they never distort the cut.
//
//   ┌───────────╥──────────╥───────────┐  ← one STL, two shells
//   │   frame   ║  center  ║   frame   │
//   └───────────╨──────────╨───────────┘
//     elliptical cut, cavityMarginMm from the edge, cutGapMm wide
function buildFoamPress(sil, opts) {
  const {
    outer,
    toMm,
    scale,
    plateWidthMm,
    plateDepthMm,
    thicknessMm,
    cavityMarginMm,
    cutGapMm,
  } = opts;
  const { mask, W, H } = sil;
  const CUT_SEGMENTS = 256;

  if (cavityMarginMm < 2) {
    throw new Error('Foam press needs an edge distance of at least 2 mm.');
  }

  // The ellipse must fit inside the silhouette eroded by the edge distance.
  const inset = erodeMask(mask, W, H, cavityMarginMm / scale);
  const ellipse = largestInscribedEllipse(inset, W, H);
  if (!ellipse || ellipse.b * scale < 4) {
    const inc = largestInscribedCircle(mask, W, H);
    const maxInset = inc.radiusPx * scale - cutGapMm - 1;
    throw new Error(
      `Edge distance too large — no room for the cut. Keep it below about ` +
      `${maxInset.toFixed(1)} mm (${(maxInset / 25.4).toFixed(2)} in).`
    );
  }

  // Sample the ellipse in pixel space, convert to mm (toMm handles the
  // y-flip), and ensure CCW winding.
  const { cx, cy, a, b, theta } = ellipse;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  let hole = [];
  for (let k = 0; k < CUT_SEGMENTS; k++) {
    const t = (k / CUT_SEGMENTS) * Math.PI * 2;
    const ex = a * Math.cos(t);
    const ey = b * Math.sin(t);
    hole.push(toMm([cx + ex * cosT - ey * sinT, cy + ex * sinT + ey * cosT]));
  }
  if (polygonArea(hole) < 0) hole = hole.slice().reverse();

  // Center piece: the same ellipse offset inward by the gap, so the printing
  // clearance is uniform all the way around.
  const inner = offsetLoopInward(hole, cutGapMm);
  const holeLoops = [hole];
  const innerLoops = [inner];

  const extrude = (shape) =>
    new THREE.ExtrudeGeometry(shape, {
      depth: thicknessMm,
      bevelEnabled: false,
      steps: 1,
    });

  // Outer frame: silhouette with the cut-line loops punched through.
  const frameShape = pointsToShape(outer);
  for (const loop of holeLoops) {
    const rev = loop.slice().reverse(); // CCW -> CW for holes
    const path = new THREE.Path();
    path.moveTo(rev[0][0], rev[0][1]);
    for (let i = 1; i < rev.length; i++) path.lineTo(rev[i][0], rev[i][1]);
    path.closePath();
    frameShape.holes.push(path);
  }
  const geoms = [extrude(frameShape)];

  // Center piece(s): solid prisms of the further-inset silhouette.
  for (const loop of innerLoops) geoms.push(extrude(pointsToShape(loop)));

  const normalized = geoms.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(ng.attributes)) {
      if (name !== 'position') ng.deleteAttribute(name);
    }
    return ng;
  });
  const merged = mergeGeometries(normalized, false);
  merged.computeVertexNormals();

  return {
    geometry: merged,
    info: {
      profile: 'foam',
      plateWidthMm,
      plateDepthMm,
      thicknessMm,
      cutInsetMm: cavityMarginMm,
      cutGapMm,
      cutMajorMm: 2 * Math.max(a, b) * scale,
      cutMinorMm: 2 * Math.min(a, b) * scale,
      pieces: 1 + innerLoops.length,
    },
  };
}

// Largest ellipse that fits inside a mask. The ellipse's orientation and
// aspect come from the region's second moments (so a wide silhouette gets a
// wide oval), then the size is maximized by binary search and the center is
// refined by a shrinking-step local search. Thin appendages (ears) barely
// influence the moments and can never contain the ellipse, so the fit
// naturally settles into the main body.
//
// Returns { cx, cy, a, b, theta } in mask pixel coords, or null.
function largestInscribedEllipse(mask, W, H) {
  let n = 0;
  let mx = 0;
  let my = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        n++;
        mx += x;
        my += y;
      }
    }
  }
  if (n === 0) return null;
  mx /= n;
  my /= n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) {
        const dx = x - mx;
        const dy = y - my;
        sxx += dx * dx;
        sxy += dx * dy;
        syy += dy * dy;
      }
    }
  }
  sxx /= n;
  sxy /= n;
  syy /= n;

  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(tr / 2 - disc, 1e-9);
  // Cap elongation so the cut always reads as a circle/gentle oval.
  const ratio = Math.min(Math.sqrt(l1 / l2), 1.8);

  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const inside = (x, y) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < W && yi < H && mask[yi * W + xi] === 1;
  };
  // Check the boundary plus a mid ring; the mask has no holes, so a fully
  // contained boundary implies a fully contained ellipse.
  const K = 180;
  const fits = (cx, cy, t) => {
    for (let k = 0; k < K; k++) {
      const ang = (k / K) * Math.PI * 2;
      const ex = ratio * t * Math.cos(ang);
      const ey = t * Math.sin(ang);
      const px = ex * cosT - ey * sinT;
      const py = ex * sinT + ey * cosT;
      if (!inside(cx + px, cy + py)) return false;
      if (!inside(cx + px / 2, cy + py / 2)) return false;
    }
    return true;
  };
  const maxT = Math.max(W, H);
  const grow = (cx, cy) => {
    if (!fits(cx, cy, 0.5)) return 0;
    let lo = 0.5;
    let hi = maxT;
    for (let it = 0; it < 30; it++) {
      const mid = (lo + hi) / 2;
      if (fits(cx, cy, mid)) lo = mid;
      else hi = mid;
    }
    return lo;
  };

  // Local search: the centroid is a good start but not optimal (the cat's
  // ear nubs pull it up); walk the center around while the ellipse can grow.
  let cx = mx;
  let cy = my;
  let best = grow(cx, cy);
  let step = Math.max(W, H) / 8;
  while (step > 0.5) {
    let improved = false;
    for (const [dx, dy] of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
      const t = grow(cx + dx, cy + dy);
      if (t > best) {
        best = t;
        cx += dx;
        cy += dy;
        improved = true;
        break;
      }
    }
    if (!improved) step /= 2;
  }

  if (best < 2) return null;
  return { cx, cy, a: ratio * best, b: best, theta };
}

// Offset a smooth CCW loop inward by `d` (per-vertex normal offset). Safe as
// long as d is much smaller than the loop's tightest curvature radius —
// true here: gap ≈ 0.5 mm vs rounding ≥ several mm.
function offsetLoopInward(loop, d) {
  const n = loop.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = loop[(i - 1 + n) % n];
    const [cx, cy] = loop[i];
    const [nx, ny] = loop[(i + 1) % n];
    let tx = nx - px;
    let ty = ny - py;
    const len = Math.hypot(tx, ty) || 1e-9;
    tx /= len;
    ty /= len;
    // CCW loop: inward normal = tangent rotated +90° = (-ty, tx)
    out.push([cx - ty * d, cy + tx * d]);
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
