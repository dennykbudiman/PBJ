import React from 'react'
import { Card, Notice } from '../../components/ui'
import Icon from '../../components/Icon'
import { useT } from '../../lib/i18n'
import { PRESETS, accentOf, contrast, isHex, palette } from '../../lib/theme'

// A small picture of the top bar and a button in a palette, so a theme can be judged at a glance.
function Swatch({ accent, label, selected, onClick, disabled }) {
  const p = palette(accent)
  return (
    <button type="button" className={`swatch ${selected ? 'on' : ''}`} onClick={onClick} disabled={disabled} aria-pressed={selected}>
      <span className="swatch-bar" style={{ background: p['--accent'] }}>
        <span className="swatch-dot" />
        <span className="swatch-line" />
      </span>
      <span className="swatch-body">
        <span className="swatch-btn" style={{ background: p['--accent'] }} />
        <span className="swatch-soft" style={{ background: p['--accent-soft'], color: p['--link'] }}>Aa</span>
      </span>
      <span className="swatch-label">
        {selected && <Icon name="check" size={13} stroke={3} />}
        {label}
      </span>
    </button>
  )
}

// Settings → Appearance. Only Owners and Admins see it (edit_settings).
export default function Appearance({ id, value, onChange, disabled, error }) {
  const { t } = useT()
  const theme = value || { preset: 'teal' }
  const custom = theme.preset === 'custom'
  const customAccent = isHex(theme.accent) ? theme.accent : accentOf({ preset: 'teal' })
  const ratio = contrast(accentOf(theme), '#FFFFFF')

  return (
    <Card title={t('settings.nav.appearance')} id={id}>
      <div className="hint" style={{ marginTop: -4, marginBottom: 12 }}>{t('theme.intro')}</div>
      <div className="swatches">
        {PRESETS.map((p) => (
          <Swatch key={p.id} accent={p.accent} label={t(`theme.${p.id}`)} selected={theme.preset === p.id}
            onClick={() => onChange({ preset: p.id })} disabled={disabled} />
        ))}
        <Swatch accent={customAccent} label={t('theme.custom')} selected={custom}
          onClick={() => onChange({ preset: 'custom', accent: customAccent })} disabled={disabled} />
      </div>

      {custom && (
        <div className="row wrap" style={{ marginTop: 14, gap: 12, alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="theme-picker">{t('theme.pick')}</label>
            <input id="theme-picker" type="color" className="colorpick" value={customAccent.toLowerCase()} disabled={disabled}
              onChange={(e) => onChange({ preset: 'custom', accent: e.target.value.toUpperCase() })} />
          </div>
          <div className="field" style={{ width: 150 }}>
            <label htmlFor="theme-hex">{t('theme.hex')}</label>
            <input id="theme-hex" className={`input ${error ? 'invalid' : ''}`} value={theme.accent ?? ''} disabled={disabled} maxLength={7}
              onChange={(e) => {
                let v = e.target.value.trim()
                if (v && !v.startsWith('#')) v = `#${v}`
                onChange({ preset: 'custom', accent: v.toUpperCase() })
              }} placeholder="#0E9F7E" style={{ fontFamily: 'ui-monospace, Menlo, monospace' }} />
          </div>
        </div>
      )}
      {error && <div className="error" style={{ marginTop: 8 }}>{error}</div>}
      {!error && custom && ratio < 4.5 && (
        <Notice kind="warn" style={{ marginTop: 12 }}>{t('theme.lowContrast')}</Notice>
      )}
      <div className="hint">{t('theme.hint')}</div>
    </Card>
  )
}

// Returns an error message for a theme that can't be saved, or null.
export function themeError(theme, t) {
  if (theme?.preset !== 'custom') return null
  if (!isHex(theme.accent)) return t('theme.badHex')
  if (contrast(theme.accent, '#FFFFFF') < 3) return t('theme.tooLight')
  return null
}
