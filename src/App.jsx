import { useState } from 'react';
import Controls from './components/Controls.jsx';
import RibControls from './components/RibControls.jsx';
import PlateViewer from './components/PlateViewer.jsx';
import { buildSilhouette } from './plate/silhouette.js';
import { buildPlateGeometry } from './plate/mesh.js';
import { buildRibGeometry } from './rib/mesh.js';
import { useGenerator, fileToImageData } from './useGenerator.js';
import './App.css';

const IN_TO_MM = 25.4;

const PLATE_DEFAULTS = {
  unit: 'in',            // 'in' | 'mm' - all dimension params below are in this unit
  plateWidth: 6,         // overall silhouette width
  thickness: 1,          // plate thickness (1 inch default)
  cavityMargin: 0.75,    // distance from cavity rim to silhouette edge
  cavityDepth: 0.5,      // recess depth
  cavityProfile: 'curved', // 'flat' | 'curved' | 'foam'
  cutGap: 0.02,          // foam press: clearance between frame and center piece
  threshold: 0.3,        // line sensitivity
  smoothIterations: 1,   // Chaikin passes on the traced outline
};

const RIB_DEFAULTS = {
  unit: 'in',
  footWidth: 4,          // widest span across the bottom edge
  thickness: 0.2,        // rib thickness
  edgeAngle: 45,         // bevel angle on the working edge, degrees from vertical
  bottomShape: 'none',   // 'none' | 'foot'
  footHeight: 0.4,       // foot rail height up the rib
  footBottomWidth: 0.5,  // foot rail thickness (the surface it stands on)
  keepHoles: true,       // keep enclosed holes (thumb hole) open
  threshold: 0.3,
  smoothIterations: 3,   // ribs are mostly long curves: smooth hard by default
};

function buildPlate(imageData, p) {
  const toMm = p.unit === 'in' ? IN_TO_MM : 1;
  const sil = buildSilhouette(imageData, { threshold: p.threshold });
  return buildPlateGeometry(sil, {
    plateWidthMm: p.plateWidth * toMm,
    thicknessMm: p.thickness * toMm,
    cavityMarginMm: p.cavityMargin * toMm,
    cavityDepthMm: p.cavityDepth * toMm,
    cavityProfile: p.cavityProfile,
    cutGapMm: p.cutGap * toMm,
    smoothIterations: p.smoothIterations,
  });
}

function buildRib(imageData, p) {
  const toMm = p.unit === 'in' ? IN_TO_MM : 1;
  const sil = buildSilhouette(imageData, { threshold: p.threshold, keepHoles: p.keepHoles });
  return buildRibGeometry(sil, {
    footWidthMm: p.footWidth * toMm,
    thicknessMm: p.thickness * toMm,
    edgeAngleDeg: p.edgeAngle,
    bottomShape: p.bottomShape,
    footHeightMm: p.footHeight * toMm,
    footBottomWidthMm: p.footBottomWidth * toMm,
    smoothIterations: p.smoothIterations,
  });
}

const loadPlateImage = () => fileToImageData(import.meta.env.BASE_URL + 'cat_plate_mold.png');

// Default rib: a D-shaped kidney rib with a flat bottom, drawn on a canvas so
// the tab opens with something to look at.
async function loadDefaultRibImage() {
  const w = 512;
  const h = 400;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(60, 330);
  ctx.lineTo(452, 330);
  ctx.bezierCurveTo(470, 330, 480, 310, 470, 290);
  ctx.bezierCurveTo(430, 180, 330, 80, 256, 70);
  ctx.bezierCurveTo(180, 80, 80, 180, 42, 290);
  ctx.bezierCurveTo(32, 310, 42, 330, 60, 330);
  ctx.closePath();
  ctx.fill();
  return ctx.getImageData(0, 0, w, h);
}

const TABS = [
  { id: 'plate', label: 'Dish Plate Generator' },
  { id: 'rib', label: 'Pottery Rib Tool' },
];

export default function App() {
  const [tab, setTab] = useState('plate');

  // One generator per tab; both live for the whole session so switching
  // tabs keeps each tool's image, settings and generated STL.
  const plate = useGenerator({
    defaults: PLATE_DEFAULTS,
    build: buildPlate,
    loadInitialImage: loadPlateImage,
    initialName: 'cat_plate_mold',
  });
  const rib = useGenerator({
    defaults: RIB_DEFAULTS,
    build: buildRib,
    loadInitialImage: loadDefaultRibImage,
    initialName: 'rib',
    suffix: '_rib',
  });

  const active = tab === 'plate' ? plate : rib;
  const ControlsView = tab === 'plate' ? Controls : RibControls;
  const emptyHint =
    tab === 'plate'
      ? 'Upload a silhouette image to see your plate here.'
      : 'Upload a rib outline to see your rib here.';

  return (
    <div className="app">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <ControlsView
          params={active.params}
          setParams={active.setParams}
          info={active.info}
          onUpload={active.handleUpload}
          onGenerate={active.handleGenerate}
          onDownload={active.handleDownload}
          hasImage={!!active.imageData}
          hasGeometry={!!active.geometry}
          hasStl={!!active.stlBuffer}
          busy={active.busy}
          error={active.error}
        />
        <PlateViewer
          key={tab}
          geometry={active.geometry}
          placeholder={
            active.imageData
              ? active.error
                ? `Build failed: ${active.error}`
                : 'Building preview…'
              : emptyHint
          }
        />
      </div>
    </div>
  );
}
