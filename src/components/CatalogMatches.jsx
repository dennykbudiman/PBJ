import React from 'react'
import { useT } from '../lib/i18n'
import { num, rp } from '../lib/format'

// "Sudah ada di katalog: …" under a part typed by hand on a PO or job line (145, item 39): the catalog parts that
// look like it, each with its brand, part number and stock, and a button to use it instead (when allowed).
export default function CatalogMatches({ matches, onUse, useLabel, disabledHint, title, showPrice }) {
  const { t } = useT()
  if (!matches?.length) return null
  return (
    <div className="catmatch" role="note">
      <div className="catmatch-head">{title || t('u145.inCatalog')}</div>
      {matches.map(({ item: x, why }) => (
        <div key={x.id} className="catmatch-row">
          <span className="catmatch-name">
            <b>{x.name}</b>
            <span className="muted small"> · {[x.brand, x.code, why === 'number' ? t('u145.sameNumber') : null].filter(Boolean).join(' · ')}
              {x.track_inventory && <> · {t('u145.stockN', { n: num(x.qty_on_hand, 2) })}</>}
              {showPrice && x.price != null && <> · {rp(x.price)}</>}</span>
          </span>
          {onUse ? <button type="button" className="btn sm" onClick={() => onUse(x)}>{useLabel || t('u145.useThis')}</button>
            : disabledHint ? <span className="muted small">{disabledHint}</span> : null}
        </div>
      ))}
    </div>
  )
}
