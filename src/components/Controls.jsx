const IN_TO_MM = 25.4;

export default function Controls({
  params,
  setParams,
  info,
  onUpload,
  onGenerate,
  onDownload,
  hasImage,
  hasGeometry,
  hasStl,
  busy,
  error,
}) {
  const update = (patch) => setParams({ ...params, ...patch });
  const isInch = params.unit === 'in';
  const unitLabel = isInch ? 'in' : 'mm';
  const step = isInch ? 0.05 : 1;

  // Switching units converts the stored dimension values in place.
  const setUnit = (unit) => {
    if (unit === params.unit) return;
    const f = unit === 'mm' ? IN_TO_MM : 1 / IN_TO_MM;
    const cv = (v) => +(v * f).toFixed(unit === 'mm' ? 1 : 3);
    update({
      unit,
      plateWidth: cv(params.plateWidth),
      thickness: cv(params.thickness),
      cavityMargin: cv(params.cavityMargin),
      cavityDepth: cv(params.cavityDepth),
      cutGap: cv(params.cutGap),
    });
  };

  const dim = (key, props = {}) => (
    <input
      type="number"
      value={params[key]}
      step={props.step ?? step}
      min={props.min ?? 0}
      max={props.max}
      onChange={(e) => update({ [key]: Number(e.target.value) })}
    />
  );

  const show = (mm) =>
    isInch ? `${(mm / IN_TO_MM).toFixed(2)} in` : `${mm.toFixed(1)} mm`;

  return (
    <aside className="controls">
      <h2>Dish Plate Generator</h2>

      <section>
        <label className="upload">
          <span>{hasImage ? 'Replace image' : 'Upload image'}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
            }}
          />
        </label>
        <p className="hint">
          Works with outline drawings (like the cat head) or filled
          silhouettes — enclosed areas are filled automatically.
        </p>
      </section>

      <section>
        <h3>Units</h3>
        <div className="shape-toggle" role="radiogroup">
          <label className={`shape-opt ${isInch ? 'active' : ''}`}>
            <input
              type="radio"
              name="unit"
              checked={isInch}
              onChange={() => setUnit('in')}
            />
            Inches
          </label>
          <label className={`shape-opt ${isInch ? '' : 'active'}`}>
            <input
              type="radio"
              name="unit"
              checked={!isInch}
              onChange={() => setUnit('mm')}
            />
            Millimeters
          </label>
        </div>
      </section>

      <section>
        <h3>Plate ({unitLabel})</h3>
        <div className="row">
          <label>Width {dim('plateWidth', { min: isInch ? 1 : 25 })}</label>
          <label>Thickness {dim('thickness', { min: isInch ? 0.2 : 5 })}</label>
        </div>
        <p className="hint">
          Width is the silhouette&apos;s overall size; height follows the image
          aspect ratio{info ? ` (currently ${show(info.plateDepthMm)})` : ''}.
          Thickness defaults to 1&nbsp;inch.
        </p>
      </section>

      <section>
        <h3>Dish cavity ({unitLabel})</h3>
        <div className="row">
          <label>Edge distance {dim('cavityMargin', { min: 0 })}</label>
          <label className={params.cavityProfile === 'foam' ? 'disabled' : ''}>
            Depth {dim('cavityDepth', { min: isInch ? 0.05 : 1 })}
          </label>
        </div>
        <p className="hint">
          {params.cavityProfile === 'foam'
            ? 'The cut-out is always the largest smooth circle/oval that fits inside the silhouette while keeping the edge distance — thin parts like ears are ignored. Depth is ignored too: the cut goes clean through.'
            : 'The cavity is the largest circle that fits inside the silhouette, pulled in by the edge distance — its rim always keeps that much material to the nearest edge.'}
          {info && info.maxMarginMm != null && (
            <>
              {' '}Max edge distance for this shape ≈ {show(info.maxMarginMm)}.
            </>
          )}
        </p>
        <div
          className="shape-toggle"
          style={{ marginTop: 10, gridTemplateColumns: '1fr 1fr 1fr' }}
          role="radiogroup"
        >
          <label className={`shape-opt ${params.cavityProfile === 'curved' ? 'active' : ''}`}>
            <input
              type="radio"
              name="profile"
              checked={params.cavityProfile === 'curved'}
              onChange={() => update({ cavityProfile: 'curved' })}
            />
            Curved
          </label>
          <label className={`shape-opt ${params.cavityProfile === 'flat' ? 'active' : ''}`}>
            <input
              type="radio"
              name="profile"
              checked={params.cavityProfile === 'flat'}
              onChange={() => update({ cavityProfile: 'flat' })}
            />
            Flat
          </label>
          <label className={`shape-opt ${params.cavityProfile === 'foam' ? 'active' : ''}`}>
            <input
              type="radio"
              name="profile"
              checked={params.cavityProfile === 'foam'}
              onChange={() => update({ cavityProfile: 'foam' })}
            />
            Foam press
          </label>
        </div>
        <p className="hint">
          Curved = smooth spherical dish well. Flat = straight walls with a
          flat bottom. Foam press = no recess — a smooth oval is cut clean
          through the solid plate, keeping both the outer frame and the
          center piece.
        </p>
        <div className={params.cavityProfile === 'foam' ? '' : 'disabled'} style={{ marginTop: 10 }}>
          <label>
            Cut gap ({unitLabel})
            <input
              type="number"
              value={params.cutGap}
              step={isInch ? 0.01 : 0.1}
              min={isInch ? 0.01 : 0.2}
              disabled={params.cavityProfile !== 'foam'}
              onChange={(e) => update({ cutGap: Number(e.target.value) })}
            />
          </label>
          <p className="hint">
            Clearance between the frame and the center piece so they separate
            cleanly after printing. ~0.02 in (0.5 mm) works for most printers.
          </p>
        </div>
      </section>

      <section>
        <h3>Outline</h3>
        <label>
          Line sensitivity: {params.threshold.toFixed(2)}
          <input
            type="range"
            min={0.1}
            max={0.7}
            step={0.01}
            value={params.threshold}
            onChange={(e) => update({ threshold: Number(e.target.value) })}
          />
        </label>
        <label style={{ marginTop: 10 }}>
          Edge smoothing: {params.smoothIterations}
          <input
            type="range"
            min={0}
            max={3}
            step={1}
            value={params.smoothIterations}
            onChange={(e) => update({ smoothIterations: Number(e.target.value) })}
          />
        </label>
        <p className="hint">
          Smoothing rounds the staircase pixel edges of the traced outline.
        </p>
      </section>

      {info && (
        <section>
          <h3>Result</h3>
          <table className="stats">
            <tbody>
              <tr><td>Footprint</td><td>{show(info.plateWidthMm)} × {show(info.plateDepthMm)}</td></tr>
              {info.profile === 'foam' ? (
                <>
                  <tr><td>Cut-out oval</td><td>{show(info.cutMajorMm)} × {show(info.cutMinorMm)}</td></tr>
                  <tr><td>Cut gap</td><td>{show(info.cutGapMm)}</td></tr>
                  <tr><td>Pieces</td><td>{info.pieces}</td></tr>
                </>
              ) : (
                <>
                  <tr><td>Cavity diameter</td><td>{show(info.cavityDiameterMm)}</td></tr>
                  <tr><td>Floor under cavity</td><td>{show(info.floorMm)}</td></tr>
                </>
              )}
            </tbody>
          </table>
        </section>
      )}

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={onGenerate}
          disabled={!hasGeometry || busy}
        >
          {busy ? 'Working…' : hasStl ? 'Regenerate STL' : 'Generate STL'}
        </button>
        <button
          type="button"
          className="primary"
          onClick={onDownload}
          disabled={!hasStl || busy}
        >
          Download STL
        </button>
      </div>
    </aside>
  );
}
