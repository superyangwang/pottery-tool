import { useEffect, useMemo, useRef, useState } from 'react';
import Controls from './components/Controls.jsx';
import PlateViewer from './components/PlateViewer.jsx';
import { buildSilhouette } from './plate/silhouette.js';
import { buildPlateGeometry } from './plate/mesh.js';
import { geometryToBinarySTL } from './plate/stl.js';
import './App.css';

const IN_TO_MM = 25.4;

const DEFAULTS = {
  unit: 'in',            // 'in' | 'mm' — all dimension params below are in this unit
  plateWidth: 6,         // overall silhouette width
  thickness: 1,          // plate thickness (1 inch default)
  cavityMargin: 0.75,    // distance from cavity rim to silhouette edge
  cavityDepth: 0.5,      // recess depth
  cavityProfile: 'curved', // 'flat' | 'curved' | 'foam'
  cutGap: 0.02,          // foam press: clearance between frame and center piece
  threshold: 0.3,        // line sensitivity
  smoothIterations: 1,   // Chaikin passes on the traced outline
};

async function fileToImageData(source) {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const maxIn = 1024;
    const scale = Math.min(1, maxIn / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(2, Math.round(img.naturalWidth * scale));
    const h = Math.max(2, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    if (typeof source !== 'string') URL.revokeObjectURL(url);
  }
}

export default function App() {
  const [params, setParams] = useState(DEFAULTS);
  const [imageData, setImageData] = useState(null);
  const [fileName, setFileName] = useState('cat_plate_mold');
  const [busy, setBusy] = useState(false);
  const [stlBuffer, setStlBuffer] = useState(null);
  const [error, setError] = useState(null);

  // Load the bundled cat-plate image on startup so the app opens ready to go.
  useEffect(() => {
    let cancelled = false;
    fileToImageData(import.meta.env.BASE_URL + 'cat_plate_mold.png')
      .then((data) => {
        if (!cancelled) setImageData(data);
      })
      .catch(() => {}); // fine — user can upload manually
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounce param changes so dragging a slider doesn't rebuild every pixel.
  const [debouncedParams, setDebouncedParams] = useState(params);
  const debounceRef = useRef(0);
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedParams(params), 120);
    return () => clearTimeout(debounceRef.current);
  }, [params]);

  // Any change to inputs invalidates the cached STL.
  useEffect(() => {
    setStlBuffer(null);
  }, [imageData, debouncedParams]);

  const built = useMemo(() => {
    if (!imageData) return null;
    try {
      const p = debouncedParams;
      const toMm = p.unit === 'in' ? IN_TO_MM : 1;
      const sil = buildSilhouette(imageData, { threshold: p.threshold });
      const result = buildPlateGeometry(sil, {
        plateWidthMm: p.plateWidth * toMm,
        thicknessMm: p.thickness * toMm,
        cavityMarginMm: p.cavityMargin * toMm,
        cavityDepthMm: p.cavityDepth * toMm,
        cavityProfile: p.cavityProfile,
        cutGapMm: p.cutGap * toMm,
        smoothIterations: p.smoothIterations,
      });
      setError(null);
      return result;
    } catch (err) {
      console.error('Plate build failed', err);
      setError(err.message || String(err));
      return null;
    }
  }, [imageData, debouncedParams]);

  const geometry = built?.geometry ?? null;
  const info = built?.info ?? null;

  // Dispose old geometries — three.js holds GPU buffers.
  const lastGeom = useRef(null);
  useEffect(() => {
    if (lastGeom.current && lastGeom.current !== geometry) {
      lastGeom.current.dispose();
    }
    lastGeom.current = geometry;
  }, [geometry]);

  const handleUpload = async (file) => {
    setBusy(true);
    try {
      const data = await fileToImageData(file);
      setImageData(data);
      setFileName(file.name.replace(/\.[^.]+$/, ''));
    } catch (err) {
      console.error(err);
      alert('Could not decode that image.');
    } finally {
      setBusy(false);
    }
  };

  const handleGenerate = () => {
    if (!geometry) return;
    setBusy(true);
    try {
      setStlBuffer(geometryToBinarySTL(geometry));
    } catch (err) {
      console.error(err);
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = () => {
    if (!stlBuffer) return;
    const blob = new Blob([stlBuffer], { type: 'model/stl' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (fileName || 'plate') + '.stl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app">
      <Controls
        params={params}
        setParams={setParams}
        info={info}
        onUpload={handleUpload}
        onGenerate={handleGenerate}
        onDownload={handleDownload}
        hasImage={!!imageData}
        hasGeometry={!!geometry}
        hasStl={!!stlBuffer}
        busy={busy}
        error={error}
      />
      <PlateViewer
        geometry={geometry}
        placeholder={
          imageData
            ? error
              ? `Build failed: ${error}`
              : 'Building preview…'
            : 'Upload a silhouette image to see your plate here.'
        }
      />
    </div>
  );
}
