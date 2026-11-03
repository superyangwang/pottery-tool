// Binary STL exporter for a non-indexed Three.js BufferGeometry.
// Format: 80-byte header, uint32 triangle count, then for each triangle:
//   3 floats normal, 9 floats vertices, uint16 attribute byte count (0).

export function geometryToBinarySTL(geometry) {
  const pos = geometry.getAttribute('position');
  const triCount = pos.count / 3;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);

  // Header (80 bytes) — left zeroed. Some loaders read it; "solid " at the
  // start is an ASCII-STL marker, so we deliberately leave it blank.
  view.setUint32(80, triCount, true);

  let offset = 84;
  const a = new Float32Array(3),
    b = new Float32Array(3),
    c = new Float32Array(3);
  const ab = new Float32Array(3),
    ac = new Float32Array(3),
    n = new Float32Array(3);

  for (let t = 0; t < triCount; t++) {
    const i = t * 3;
    a[0] = pos.getX(i);
    a[1] = pos.getY(i);
    a[2] = pos.getZ(i);
    b[0] = pos.getX(i + 1);
    b[1] = pos.getY(i + 1);
    b[2] = pos.getZ(i + 1);
    c[0] = pos.getX(i + 2);
    c[1] = pos.getY(i + 2);
    c[2] = pos.getZ(i + 2);

    ab[0] = b[0] - a[0];
    ab[1] = b[1] - a[1];
    ab[2] = b[2] - a[2];
    ac[0] = c[0] - a[0];
    ac[1] = c[1] - a[1];
    ac[2] = c[2] - a[2];
    n[0] = ab[1] * ac[2] - ab[2] * ac[1];
    n[1] = ab[2] * ac[0] - ab[0] * ac[2];
    n[2] = ab[0] * ac[1] - ab[1] * ac[0];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= len;
    n[1] /= len;
    n[2] /= len;

    view.setFloat32(offset, n[0], true);
    view.setFloat32(offset + 4, n[1], true);
    view.setFloat32(offset + 8, n[2], true);
    view.setFloat32(offset + 12, a[0], true);
    view.setFloat32(offset + 16, a[1], true);
    view.setFloat32(offset + 20, a[2], true);
    view.setFloat32(offset + 24, b[0], true);
    view.setFloat32(offset + 28, b[1], true);
    view.setFloat32(offset + 32, b[2], true);
    view.setFloat32(offset + 36, c[0], true);
    view.setFloat32(offset + 40, c[1], true);
    view.setFloat32(offset + 44, c[2], true);
    view.setUint16(offset + 48, 0, true);
    offset += 50;
  }
  return buffer;
}

export function downloadSTL(geometry, filename = 'stamp.stl') {
  const buffer = geometryToBinarySTL(geometry);
  const blob = new Blob([buffer], { type: 'model/stl' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
