// Preview of the pot a rib would throw.
//
// The rib stands upright on the wheel head with its foot down, and one of
// its side edges is pressed against the clay wall - so that edge, read from
// bottom to top, is the pot's wall profile. The pot is exactly as tall as
// the rib; the base diameter is whatever the potter types in, and the wall
// follows the edge outward or inward from there.
//
//        rib (side view)              pot (section)
//         .--.                       .--------.
//        /    |                     /          \
//       |     |    ->   revolve    |            |
//        \    |                     \          /
//         '---'                      '--------'
//          foot                      base = bottom diameter

import * as THREE from 'three';

const MIN_RADIUS_MM = 0.3;
// The base radius is pinned to the edge this far up the rib (fraction of its
// height), not to the very bottom row: a rounded corner, a slight tilt or a
// speck on the bottom edge would otherwise shift the whole profile.
const BASE_FRACTION = 0.03;

/**
 * @param {Array<[number, number]>} outlineMm  rib outer loop in mm, bottom edge at y = 0
 * @param {number} heightMm                    rib height (= pot height)
 * @param {object} opts
 * @param {number} opts.bottomDiameterMm       pot base diameter
 * @param {'auto'|'left'|'right'} [opts.side='auto']  which rib edge is the profile
 * @param {number} [opts.segments=96]          revolution segments
 * @param {number} [opts.samples=160]          profile samples up the height
 */
export function buildPotGeometry(outlineMm, heightMm, opts) {
  const { bottomDiameterMm, side = 'auto', segments = 96, samples = 160 } = opts;
  if (!(bottomDiameterMm > 0)) throw new Error('Pot bottom diameter must be greater than zero.');
  if (!(heightMm > 0) || !outlineMm || outlineMm.length < 3) {
    throw new Error('No rib outline to throw from.');
  }

  // Sample the outline's leftmost and rightmost x at evenly spaced heights.
  const ys = new Float64Array(samples);
  const left = new Float64Array(samples);
  const right = new Float64Array(samples);
  let lastLo = NaN;
  let lastHi = NaN;
  for (let k = 0; k < samples; k++) {
    const y = ((k + 0.5) / samples) * heightMm;
    let [lo, hi] = polygonSpanAtY(outlineMm, y);
    if (!(hi > lo)) {
      lo = lastLo;
      hi = lastHi;
    }
    if (Number.isNaN(lo)) {
      // Nothing yet (should not happen inside the outline's height) - look ahead.
      for (let j = k + 1; j < samples && Number.isNaN(lo); j++) {
        [lo, hi] = polygonSpanAtY(outlineMm, ((j + 0.5) / samples) * heightMm);
        if (!(hi > lo)) lo = NaN;
      }
      if (Number.isNaN(lo)) throw new Error('Could not read a profile from the rib outline.');
    }
    ys[k] = y;
    left[k] = lo;
    right[k] = hi;
    lastLo = lo;
    lastHi = hi;
  }

  // Auto: the edge that bows away from a straight line the most is the
  // shaped working edge; a straight back edge barely deviates at all.
  const chosen = side === 'auto' ? (deviation(right) > deviation(left) ? 'right' : 'left') : side;
  const xs = chosen === 'left' ? left : right;
  // The pot sits on the chosen side of the rib, so its axis is further out
  // that way. Left edge: the edge moving left (towards the axis) means a
  // smaller radius, moving right a bigger one. Mirror for the right edge.
  const sign = chosen === 'left' ? 1 : -1;

  let kRef = 0;
  while (kRef < samples - 1 && ys[kRef] < heightMm * BASE_FRACTION) kRef++;
  const xRef = xs[kRef];

  const R0 = bottomDiameterMm / 2;
  const radius = new Float64Array(samples);
  let maxR = 0;
  for (let k = 0; k < samples; k++) {
    const x = k < kRef ? xRef : xs[k];
    radius[k] = Math.max(MIN_RADIUS_MM, R0 + sign * (x - xRef));
    if (radius[k] > maxR) maxR = radius[k];
  }
  const rimR = radius[samples - 1];

  // Hollow pot: a wall thickness that stays sensible for tiny bases, and a
  // floor inside the base.
  const wall = Math.min(6, Math.max(1.5, R0 * 0.35));
  const floor = Math.min(8, Math.max(2, heightMm * 0.12));

  const pts = [];
  pts.push(new THREE.Vector2(0, floor));
  for (let k = 0; k < samples; k++) {
    if (ys[k] <= floor) continue;
    pts.push(new THREE.Vector2(Math.max(MIN_RADIUS_MM, radius[k] - wall), ys[k]));
  }
  pts.push(new THREE.Vector2(Math.max(MIN_RADIUS_MM, rimR - wall), heightMm));
  pts.push(new THREE.Vector2(rimR, heightMm));
  for (let k = samples - 1; k >= 0; k--) pts.push(new THREE.Vector2(radius[k], ys[k]));
  pts.push(new THREE.Vector2(radius[0], 0));
  pts.push(new THREE.Vector2(0, 0));

  // LatheGeometry revolves around Y; the viewer is Z-up, so stand it up.
  const geometry = new THREE.LatheGeometry(pts, segments);
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();

  return {
    geometry,
    info: {
      side: chosen,
      heightMm,
      bottomDiameterMm,
      rimDiameterMm: rimR * 2,
      maxDiameterMm: maxR * 2,
      wallMm: wall,
      // [height, outer radius] up the pot, for inspection.
      profileMm: Array.from(ys, (y, k) => [y, radius[k]]),
    },
  };
}

// How far the sampled edge bows away from a straight line, judged over the
// middle 70 % of the height so rounded top and bottom corners do not count:
// max residual from the least-squares line through those samples.
function deviation(xs) {
  const n = xs.length;
  const lo = Math.floor(n * 0.15);
  const hi = Math.ceil(n * 0.85);
  let sy = 0, sx = 0, syy = 0, sxy = 0, cnt = 0;
  for (let i = lo; i < hi; i++) {
    sy += i; sx += xs[i]; syy += i * i; sxy += i * xs[i]; cnt++;
  }
  const den = cnt * syy - sy * sy || 1e-12;
  const b = (cnt * sxy - sy * sx) / den;
  const a = (sx - b * sy) / cnt;
  let m = 0;
  for (let i = lo; i < hi; i++) {
    const d = Math.abs(xs[i] - (a + b * i));
    if (d > m) m = d;
  }
  return m;
}

// [min x, max x] where the horizontal line at `y` crosses the polygon.
function polygonSpanAtY(poly, y) {
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
  return [lo, hi];
}
