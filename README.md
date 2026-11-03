# Pottery Tool

Two browser tools for turning a silhouette image into a printable STL, in one
tabbed app:

- **Dish Plate Generator** - the silhouette extruded to a uniform thickness
  with a circular dish cavity recessed into the top surface. The cavity is
  auto-placed at the center of the largest circle that fits inside the
  silhouette, and its rim keeps a configurable distance from the edge.
- **Pottery Rib Tool** - the silhouette becomes a flat rib with a bevelled
  working edge and an optional foot rail along the bottom edge.

## Web UI

```
npm install
npm run dev
```

Pick a tab at the top; each tab keeps its own image, settings and STL.

**Dish Plate Generator** opens with the cat-plate image preloaded. Adjust
plate width/thickness (1 inch default), cavity edge distance, depth, and
profile (curved bowl, flat floor, or foam press — the plate stays solid and a
smaller copy of the silhouette is cut clean through it, keeping both the
outer frame and the center piece with a small clearance gap), then Generate
+ Download STL. Interface mirrors the `3dPrinting stamp` project.

**Pottery Rib Tool** opens with a default D-shaped rib. Upload a rib outline
drawn with its working edge at the bottom of the image, then set:

- *Bottom foot width* - the outline is scaled so its widest span along the
  bottom edge equals this; every other dimension follows that scale.
- *Thickness* - rib thickness.
- *Inside edge angle* (default 45°) - the top-face contour is offset inward
  by thickness × tan(angle) and lofted to the bottom outline, giving a
  bevelled working edge instead of a square cut. 0° = square.
- *Bottom shape* - "None", or "Foot" to add a thickened rail along the bottom
  edge with its own foot height (how far up the rib it reaches) and foot
  bottom width (the rail's thickness, centred on the rib).

The rib mesh lives in `src/rib/mesh.js` and reuses the plate's silhouette
tracer and STL exporter.

## CLI

```
npm run generate -- --thickness 1 --margin 0.75 --depth 0.5 --profile curved
```

Dimensions are in inches (pass `--mm` to use millimeters). See
`scripts/generate.js` for all flags.

## How it works

1. Image → darkness threshold → flood-fill from the border, so outline
   drawings get their interior filled (`src/plate/silhouette.js`).
2. Marching-squares contour trace + smoothing (`src/plate/tracer.js`).
3. Chamfer distance transform finds the incenter → cavity circle =
   inscribed radius − edge distance.
4. Watertight mesh: bottom face, outer wall, top face with the cavity circle
   punched out, and either a spherical-cap bowl or a cylinder wall + flat
   floor (`src/plate/mesh.js`). Exported as binary STL.
