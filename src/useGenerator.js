// Shared state machine for one tool tab: image -> params -> geometry -> STL.
// Each tab owns its own instance, so switching tabs never loses settings.

import { useEffect, useMemo, useRef, useState } from 'react';
import { geometryToBinarySTL } from './plate/stl.js';

export async function fileToImageData(source) {
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

/**
 * @param {object} cfg
 * @param {object} cfg.defaults          initial params
 * @param {(imageData, params) => {geometry, info}} cfg.build  pure builder (stable ref)
 * @param {() => Promise<ImageData>} [cfg.loadInitialImage]
 * @param {string} cfg.initialName       default download base name
 * @param {string} [cfg.suffix='']       appended to the file name before .stl
 */
export function useGenerator({ defaults, build, loadInitialImage, initialName, suffix = '' }) {
  const [params, setParams] = useState(defaults);
  const [imageData, setImageData] = useState(null);
  const [fileName, setFileName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [stlBuffer, setStlBuffer] = useState(null);

  useEffect(() => {
    if (!loadInitialImage) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(loadInitialImage)
      .then((data) => {
        if (!cancelled && data) setImageData(data);
      })
      .catch(() => {}); // fine - user can upload manually
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (!imageData) return { result: null, error: null };
    try {
      return { result: build(imageData, debouncedParams), error: null };
    } catch (err) {
      console.error('Build failed', err);
      return { result: null, error: err.message || String(err) };
    }
  }, [imageData, debouncedParams, build]);

  const geometry = built.result?.geometry ?? null;
  const info = built.result?.info ?? null;
  const [actionError, setActionError] = useState(null);
  const error = built.error ?? actionError;

  // Dispose old geometries - three.js holds GPU buffers.
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
      setActionError(null);
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
      setActionError(null);
    } catch (err) {
      console.error(err);
      setActionError(err.message || String(err));
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
    a.download = (fileName || initialName) + suffix + '.stl';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return {
    params,
    setParams,
    imageData,
    geometry,
    info,
    error,
    busy,
    stlBuffer,
    handleUpload,
    handleGenerate,
    handleDownload,
  };
}
