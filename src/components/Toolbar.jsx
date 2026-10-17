const COLORS = [
  '#1d1d1f',
  '#e5484d',
  '#f76b15',
  '#f5a623',
  '#30a46c',
  '#0090ff',
  '#8e4ec6',
  '#e93d82',
]

const BRUSHES = [
  { label: 'S', value: 3 },
  { label: 'M', value: 6 },
  { label: 'L', value: 14 },
]

export default function Toolbar({
  color,
  onColorChange,
  brushWidth,
  onBrushWidthChange,
  ink,
  inkMax,
  inkFlashing,
  canUndo,
  onUndo,
  reportMode,
  onToggleReport,
}) {
  const inkPercent = Math.round((ink / inkMax) * 100)

  return (
    <div className="toolbar">
      <div className={`ink-meter ${inkFlashing ? 'ink-meter-flash' : ''}`} title={`Ink ${inkPercent}%`}>
        <div className="ink-fill" style={{ width: `${inkPercent}%` }} />
      </div>

      <div className="toolbar-row">
        <div className="swatches" role="radiogroup" aria-label="Color">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={`Color ${c}`}
              className={`swatch ${color === c ? 'swatch-active' : ''}`}
              style={{ background: c }}
              onClick={() => onColorChange(c)}
            />
          ))}
        </div>

        <div className="brushes" role="radiogroup" aria-label="Brush size">
          {BRUSHES.map((b) => (
            <button
              key={b.value}
              type="button"
              role="radio"
              aria-checked={brushWidth === b.value}
              className={`brush ${brushWidth === b.value ? 'brush-active' : ''}`}
              onClick={() => onBrushWidthChange(b.value)}
            >
              <span className="brush-dot" style={{ width: b.value + 4, height: b.value + 4 }} />
              {b.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="undo-button"
          onClick={onUndo}
          disabled={!canUndo}
          aria-label="Undo last stroke"
        >
          <UndoIcon />
        </button>

        <button
          type="button"
          className={`undo-button ${reportMode ? 'report-active' : ''}`}
          onClick={onToggleReport}
          aria-pressed={reportMode}
          aria-label="Report a stroke"
          title={reportMode ? 'Reporting: tap a stroke' : 'Report a stroke'}
        >
          <FlagIcon />
        </button>
      </div>
    </div>
  )
}

function FlagIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 3v14"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M5 4h9.5l-2 3 2 3H5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function UndoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M7 5 3.5 8.5 7 12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3.5 8.5h7.75A5.25 5.25 0 0 1 16.5 13.75v0A5.25 5.25 0 0 1 11.25 19H9"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
