import { PALETTE } from '../lib/palette.js'

const BRUSHES = [
  { label: 'S', value: 3 },
  { label: 'M', value: 6 },
  { label: 'L', value: 14 },
]

/**
 * The rooms toolbar: colour, brush and ink. Deliberately not `Toolbar.jsx`,
 * because that component's undo and report buttons have no meaning in a room
 * (no stroke_remove in the rooms wire) and a dead control is worse than no
 * control. Everything else is the plaza markup so `src/index.css` styles it
 * unchanged.
 */
export default function RoomToolbar({
  color,
  onColorChange,
  brushWidth,
  onBrushWidthChange,
  ink,
  inkMax,
  inkFlashing,
}) {
  const inkPercent = Math.round((ink / inkMax) * 100)

  return (
    <div className="toolbar">
      <div className={`ink-meter ${inkFlashing ? 'ink-meter-flash' : ''}`} title={`Ink ${inkPercent}%`}>
        <div className="ink-fill" style={{ width: `${inkPercent}%` }} />
      </div>

      <div className="toolbar-row">
        <div className="swatches" role="radiogroup" aria-label="Color">
          {PALETTE.map((c) => (
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

        <span className="name-pill" title="You">
          {name}
        </span>
      </div>
    </div>
  )
}
