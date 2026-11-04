import { useEffect, useRef } from 'react';

const IN_TO_MM = 25.4;

// Thumbnail of the detected shapes: every shape found is drawn dim, the one
// used for the rib bright. Clicking a shape picks it.
function MaskPreview({ silhouette, onPick }) {
  const ref = useRef();
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !silhouette) return;
    const { W, H, mask, allMask } = silhouette;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) {
      const used = mask[i];
      const found = allMask ? allMask[i] : used;
      img.data[i * 4] = used ? 232 : found ? 88 : 21;
      img.data[i * 4 + 1] = used ? 222 : found ? 90 : 23;
      img.data[i * 4 + 2] = used ? 204 : found ? 96 : 26;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }, [silhouette]);
  if (!silhouette) return null;
  return (
    <canvas
      ref={ref}
      className="mask-preview"
      aria-label="Detected shapes - click one to use it"
      title="Click a shape to use it as the rib"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onPick([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
      }}
    />
  );
}

export default function RibControls({
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
  pot,
  view = 'rib',
  setView = () => {},
}) {
  const update = (patch) => setParams({ ...params, ...patch });
  const isAuto = params.detect !== 'ink';
  const showingPot = view === 'pot';
  const isInch = params.unit === 'in';
  const unitLabel = isInch ? 'in' : 'mm';
  const step = isInch ? 0.05 : 1;
  const hasFoot = params.bottomShape === 'foot';

  // Switching units converts the stored dimension values in place.
  const setUnit = (unit) => {
    if (unit === params.unit) return;
    const f = unit === 'mm' ? IN_TO_MM : 1 / IN_TO_MM;
    const cv = (v) => +(v * f).toFixed(unit === 'mm' ? 1 : 3);
    update({
      unit,
      footWidth: cv(params.footWidth),
      thickness: cv(params.thickness),
      footHeight: cv(params.footHeight),
      footBottomWidth: cv(params.footBottomWidth),
      potBottomDiameter: cv(params.potBottomDiameter),
    });
  };

  const dim = (key, props = {}) => (
    <input
      type="number"
      value={params[key]}
      step={props.step ?? step}
      min={props.min ?? 0}
      max={props.max}
      disabled={props.disabled}
      onChange={(e) => update({ [key]: Number(e.target.value) })}
    />
  );

  const show = (mm) =>
    isInch ? `${(mm / IN_TO_MM).toFixed(2)} in` : `${mm.toFixed(1)} mm`;

  return (
    <aside className="controls">
      <h2>Pottery Rib Tool</h2>

      <section>
        <label className="upload">
          <span>{hasImage ? 'Replace rib image' : 'Upload rib image'}</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                update({ pick: null }); // a new image gets a fresh automatic choice
                onUpload(f);
              }
            }}
          />
        </label>
        <p className="hint">
          Draw or photograph the rib with its foot (bottom) edge at the bottom
          of the image. Photos on any background work: the rib is picked out
          automatically. Outlines or filled silhouettes work too, and an
          enclosed thumb hole is kept open and bevelled like the edge.
        </p>
        <MaskPreview silhouette={info?.silhouette} onPick={(pick) => update({ pick })} />
        {info?.silhouette && (
          <p className="hint">
            {info.silhouette.shapes > 1
              ? `${info.silhouette.shapes} shapes found. The bright one is used` +
                (params.pick ? ' (your pick).' : ': the flattest-shaded one, which is usually the rib, not the pot.') +
                ' Click another shape in the thumbnail to use it instead.'
              : 'The bright shape is what becomes the rib.'}
            {params.pick && (
              <>
                {' '}
                <a href="#auto" onClick={(e) => { e.preventDefault(); update({ pick: null }); }}>
                  Back to automatic choice
                </a>
              </>
            )}
          </p>
        )}
      </section>

      <section>
        <h3>Units</h3>
        <div className="shape-toggle" role="radiogroup">
          <label className={`shape-opt ${isInch ? 'active' : ''}`}>
            <input
              type="radio"
              name="rib-unit"
              checked={isInch}
              onChange={() => setUnit('in')}
            />
            Inches
          </label>
          <label className={`shape-opt ${isInch ? '' : 'active'}`}>
            <input
              type="radio"
              name="rib-unit"
              checked={!isInch}
              onChange={() => setUnit('mm')}
            />
            Millimeters
          </label>
        </div>
      </section>

      <section>
        <h3>Rib ({unitLabel})</h3>
        <div className="row">
          <label>Bottom foot width {dim('footWidth', { min: isInch ? 0.5 : 10 })}</label>
          <label>Thickness {dim('thickness', { min: isInch ? 0.05 : 1, step: isInch ? 0.01 : 0.5 })}</label>
        </div>
        <p className="hint">
          The outline is scaled so its widest span along the bottom edge equals
          the foot width; every other dimension follows that scale
          {info ? ` (overall ${show(info.widthMm)} × ${show(info.heightMm)})` : ''}.
        </p>
      </section>

      <section>
        <h3>Working edge</h3>
        <label>
          Inside edge angle: {params.edgeAngle}°
          <input
            type="range"
            min={0}
            max={80}
            step={1}
            value={params.edgeAngle}
            onChange={(e) => update({ edgeAngle: Number(e.target.value) })}
          />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <label>
            Angle (degrees)
            <input
              type="number"
              min={0}
              max={80}
              step={1}
              value={params.edgeAngle}
              onChange={(e) => update({ edgeAngle: Number(e.target.value) })}
            />
          </label>
        </div>
        <p className="hint">
          0° is a square-cut edge. The default 45° bevels the whole edge: the
          top face is pulled in by thickness × tan(angle)
          {info ? ` = ${show(info.bevelInsetMm)}` : ''} and joined to the bottom
          outline with a sloped wall.
        </p>
      </section>

      <section>
        <h3>Bottom shape</h3>
        <div className="shape-toggle" role="radiogroup">
          <label className={`shape-opt ${!hasFoot ? 'active' : ''}`}>
            <input
              type="radio"
              name="rib-bottom"
              checked={!hasFoot}
              onChange={() => update({ bottomShape: 'none' })}
            />
            None
          </label>
          <label className={`shape-opt ${hasFoot ? 'active' : ''}`}>
            <input
              type="radio"
              name="rib-bottom"
              checked={hasFoot}
              onChange={() => update({ bottomShape: 'foot' })}
            />
            Foot
          </label>
        </div>
        {hasFoot && (
          <>
            <div className="row" style={{ marginTop: 10 }}>
              <label>Foot height ({unitLabel}) {dim('footHeight', { min: isInch ? 0.05 : 1 })}</label>
              <label>Foot bottom width ({unitLabel}) {dim('footBottomWidth', { min: isInch ? 0.05 : 1, step: isInch ? 0.01 : 0.5 })}</label>
            </div>
            <p className="hint">
              Adds a thicker rail along the bottom edge: it reaches the foot
              height up the rib and is the foot bottom width thick, centred on
              the rib so it stands proud of both faces. The rail is square
              edged; the edge angle does not apply to it. Must be wider than
              the rib thickness.
            </p>
          </>
        )}
      </section>

      <section>
        <h3>Outline</h3>
        <div className="shape-toggle" role="radiogroup">
          <label className={`shape-opt ${isAuto ? 'active' : ''}`}>
            <input
              type="radio"
              name="rib-detect"
              checked={isAuto}
              onChange={() => update({ detect: 'auto' })}
            />
            Auto detect
          </label>
          <label className={`shape-opt ${isAuto ? '' : 'active'}`}>
            <input
              type="radio"
              name="rib-detect"
              checked={!isAuto}
              onChange={() => update({ detect: 'ink' })}
            />
            Dark lines
          </label>
        </div>
        {isAuto ? (
          <>
            <label style={{ marginTop: 10 }}>
              Detection strictness: {params.autoBias.toFixed(2)}
              <input
                type="range"
                min={0.5}
                max={1.6}
                step={0.05}
                value={params.autoBias}
                onChange={(e) => update({ autoBias: Number(e.target.value) })}
              />
            </label>
            <p className="hint">
              Auto detect reads the background colour from the image border and
              keeps whatever differs from it, then drops specks and keeps the
              biggest shape. Raise strictness if a shadow or the table gets
              included; lower it if part of the rib is missed.
            </p>
          </>
        ) : (
          <>
            <label style={{ marginTop: 10 }}>
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
            <p className="hint">
              Dark lines treats dark pixels as the rib - for black-on-white
              drawings.
            </p>
          </>
        )}
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
        <div className="shape-toggle" style={{ marginTop: 10 }} role="radiogroup">
          <label className={`shape-opt ${params.keepHoles ? 'active' : ''}`}>
            <input
              type="radio"
              name="rib-holes"
              checked={!!params.keepHoles}
              onChange={() => update({ keepHoles: true })}
            />
            Keep holes
          </label>
          <label className={`shape-opt ${params.keepHoles ? '' : 'active'}`}>
            <input
              type="radio"
              name="rib-holes"
              checked={!params.keepHoles}
              onChange={() => update({ keepHoles: false })}
            />
            Fill holes
          </label>
        </div>
        <p className="hint">
          Keep holes leaves enclosed openings (a thumb hole) in the rib. Fill
          holes makes the whole silhouette solid.
        </p>
      </section>

      <section>
        <h3>Thrown pot preview</h3>
        <div className="row">
          <label>
            Bottom diameter ({unitLabel}){' '}
            {dim('potBottomDiameter', { min: isInch ? 0.1 : 2, step: isInch ? 0.1 : 1 })}
          </label>
        </div>
        <div className="shape-toggle" style={{ marginTop: 10 }} role="radiogroup">
          {['auto', 'left', 'right'].map((opt) => (
            <label key={opt} className={`shape-opt ${params.potSide === opt ? 'active' : ''}`}>
              <input
                type="radio"
                name="rib-pot-side"
                checked={params.potSide === opt}
                onChange={() => update({ potSide: opt })}
              />
              {opt === 'auto' ? 'Auto edge' : opt === 'left' ? 'Left edge' : 'Right edge'}
            </label>
          ))}
        </div>
        <p className="hint">
          Stand the rib on its foot against the wall of a pot: the chosen side
          edge becomes the wall profile. The pot is as tall as the rib
          {info ? ` (${show(info.heightMm)})` : ''} and starts from the bottom
          diameter you enter. Auto picks the more curved edge.
          {pot?.info
            ? ` Using the ${pot.info.side} edge: rim ${show(pot.info.rimDiameterMm)}, widest ${show(pot.info.maxDiameterMm)}.`
            : ''}
        </p>
        {pot?.error && <p className="error">{pot.error}</p>}
        <button
          type="button"
          className={showingPot ? 'primary' : 'secondary'}
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => setView(showingPot ? 'rib' : 'pot')}
          disabled={!hasGeometry || (!showingPot && !pot?.geometry)}
        >
          {showingPot ? 'Back to rib' : 'Preview pot'}
        </button>
        {showingPot && (
          <p className="hint">The STL buttons below still export the rib, not the pot.</p>
        )}
      </section>

      {info && (
        <section>
          <h3>Result</h3>
          <table className="stats">
            <tbody>
              <tr><td>Overall size</td><td>{show(info.widthMm)} × {show(info.heightMm)}</td></tr>
              <tr><td>Bottom foot width</td><td>{show(info.footWidthMm)}</td></tr>
              <tr><td>Thickness</td><td>{show(info.thicknessMm)}</td></tr>
              <tr><td>Edge bevel</td><td>{info.edgeAngleDeg}° ({show(info.bevelInsetMm)} inset)</td></tr>
              <tr><td>Holes</td><td>{info.holes}</td></tr>
              {info.foot && (
                <tr><td>Foot rail</td><td>{show(info.foot.heightMm)} tall, {show(info.foot.bottomWidthMm)} wide</td></tr>
              )}
              <tr><td>Triangles</td><td>{info.triangles}</td></tr>
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
