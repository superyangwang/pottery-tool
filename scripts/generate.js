// CLI: generate the plate STL straight from a PNG, no browser needed.
//
//   npm run generate -- [options]
//
//   --image <path>      input PNG            (default: public/cat_plate_mold.png)
//   --out <path>        output STL           (default: <image name>.stl)
//   --width <in>        plate width          (default: 6)
//   --thickness <in>    plate thickness      (default: 1)
//   --margin <in>       cavity edge distance (default: 0.75)
//   --depth <in>        cavity depth         (default: 0.5)
//   --profile <name>    flat | curved | foam (default: curved)
//                       foam = solid plate with the largest smooth oval that
//                       fits (at --margin from the edge, ears ignored) cut
//                       clean through: outer frame + center piece
//   --gap <in>          foam cut clearance between pieces (default: 0.02)
//   --mm                interpret dimensions as millimeters instead of inches
//
// Example:
//   npm run generate -- --thickness 1 --margin 0.6 --profile curved

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { buildSilhouette } from '../src/plate/silhouette.js';
import { buildPlateGeometry } from '../src/plate/mesh.js';
import { geometryToBinarySTL } from '../src/plate/stl.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes('--' + name);

const unitToMm = has('mm') ? 1 : 25.4;
const imagePath = flag('image', path.join('public', 'cat_plate_mold.png'));
const outPath = flag(
  'out',
  path.basename(imagePath).replace(/\.[^.]+$/, '') + '.stl'
);

const opts = {
  plateWidthMm: Number(flag('width', 6)) * unitToMm,
  thicknessMm: Number(flag('thickness', 1)) * unitToMm,
  cavityMarginMm: Number(flag('margin', 0.75)) * unitToMm,
  cavityDepthMm: Number(flag('depth', 0.5)) * unitToMm,
  cavityProfile: flag('profile', 'curved'),
  cutGapMm: Number(flag('gap', 0.02)) * unitToMm,
  smoothIterations: 1,
};

const png = PNG.sync.read(fs.readFileSync(imagePath));
const sil = buildSilhouette(
  { data: png.data, width: png.width, height: png.height },
  { threshold: 0.3 }
);
const { geometry, info } = buildPlateGeometry(sil, opts);
const buffer = geometryToBinarySTL(geometry);
fs.writeFileSync(outPath, Buffer.from(buffer));

const inches = (mm) => (mm / 25.4).toFixed(2);
console.log(`Wrote ${outPath}`);
console.log(`  footprint: ${info.plateWidthMm.toFixed(1)} x ${info.plateDepthMm.toFixed(1)} mm` +
  ` (${inches(info.plateWidthMm)} x ${inches(info.plateDepthMm)} in)`);
console.log(`  thickness: ${info.thicknessMm.toFixed(1)} mm (${inches(info.thicknessMm)} in)`);
if (info.profile === 'foam') {
  console.log(`  cut:       oval ${info.cutMajorMm.toFixed(1)} x ${info.cutMinorMm.toFixed(1)} mm ` +
    `(${inches(info.cutMajorMm)} x ${inches(info.cutMinorMm)} in), through-thickness, ` +
    `${info.cutGapMm.toFixed(2)} mm gap, ${info.pieces} pieces`);
} else {
  console.log(`  cavity:    ⌀${info.cavityDiameterMm.toFixed(1)} mm, ${opts.cavityProfile}, ` +
    `${info.cavityDepthMm.toFixed(1)} mm deep, floor ${info.floorMm.toFixed(1)} mm`);
}
console.log(`  triangles: ${geometry.getAttribute('position').count / 3}`);
