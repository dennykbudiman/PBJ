import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Card, Empty, PageHead } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { supabase } from '../../lib/supabase'
import { fmtDate, jobNo, num } from '../../lib/format'
import { downloadCsv } from '../../lib/reports'
import { ReportBar, ReportError, usePeriod } from './ReportsArea'

// Laporan → Tutup bulan (151, review 21): what to check before the month's bills go out, one list per check, each
// line linking to where it is fixed. Owner/Admin (the database decides: report_month_close).
const SECTIONS = ['paperwork', 'overrides', 'po_not_invoiced', 'done_not_invoiced', 'zero_parts', 'oil_one', 'drums', 'negative_stock', 'adjustments']

export default function CloseReport() {
  const { t, lang } = useT()
  const period = usePeriod('last_month')
  const [res, setRes] = useState({ data: null, error: null })
  const seq = useRef(0)
  useEffect(() => {
    if (!period.valid) return
    const n = ++seq.current
    setRes((r) => ({ ...r, loading: true }))
    supabase.rpc('report_month_close', { p_from: period.from, p_to: period.to }).then(({ data, error }) => {
      if (n === seq.current) setRes({ data: error ? null : data, error, loading: false })
    })
  }, [period.from, period.to, period.valid])
  const d = res.data

  const line = (k, x) => {
    switch (k) {
      case 'paperwork':
      case 'zero_parts':
      case 'oil_one':
      case 'overrides':
        return <><Link to={`/jobs/${x.ro_id}`}>{x.invoice_no}</Link> · {fmtDate(x.day, lang)}{x.plate && ` · ${x.plate}`}{x.company && ` · ${x.company}`}
          {x.name && <span> · <b>{x.name}</b>{k === 'zero_parts' && x.qty != null ? ` × ${num(x.qty, 2)}` : ''}</span>}
          {x.note && <div className="small muted">{x.note}</div>}</>
      case 'po_not_invoiced':
        return <><Link to={`/jobs/${x.ro_id}`}>#{jobNo(x.job_number)}</Link> · <Link to={`/inventory/purchase-orders/${x.po_id}`}>PO {x.po_number}</Link> · {x.name} × {num(x.qty, 2)} · {t('u151.close.received', { date: fmtDate(x.delivered_at, lang) })}{x.plate && ` · ${x.plate}`}</>
      case 'done_not_invoiced':
        return <><Link to={`/jobs/${x.ro_id}`}>#{jobNo(x.job_number)}</Link>{x.plate && ` · ${x.plate}`}{x.company && ` · ${x.company}`} · {t('u151.close.since', { date: fmtDate(x.since, lang) })}</>
      case 'drums':
        return <><Link to="/inventory/drums">{x.oil}</Link> · {t('u151.close.opened', { date: fmtDate(x.opened_on, lang) })} · {[x.payer, x.book].filter(Boolean).join(' · ')}
          {x.estimated && <> <Badge color="amber">{t('u151.close.estimated')}</Badge></>}
          {Number(x.used) > Number(x.litres) + 0.005 && <> <Badge color="red">{t('u151.close.over', { used: num(x.used, 2), litres: num(x.litres, 2) })}</Badge></>}</>
      case 'negative_stock':
        return <><Link to={`/catalog/parts/${x.item_id}`}>{x.name}</Link>{x.code && <span className="muted"> · {x.code}</span>} · <b style={{ color: 'var(--red)' }}>{num(x.qty, 2)}</b></>
      case 'adjustments':
        return <><Link to={`/catalog/parts/${x.item_id}`}>{x.name}</Link> · <b>{Number(x.qty) > 0 ? '+' : ''}{num(x.qty, 2)}</b> · {fmtDate(x.day, lang)}{x.by && ` · ${x.by}`}{x.note && <span className="muted"> · {x.note}</span>}</>
      default: return null
    }
  }
  function csv() {
    const rows = []
    for (const k of SECTIONS) for (const x of d?.[k] || []) {
      rows.push([t(`u151.close.s.${k}`), x.invoice_no || (x.job_number ? `#${jobNo(x.job_number)}` : ''), x.day || x.delivered_at || x.since || x.opened_on || '',
        x.plate || '', x.company || '', x.name || x.oil || '', x.qty ?? x.used ?? '', x.note || ''])
    }
    downloadCsv(`tutup-bulan-${period.from}-${period.to}.csv`, [t('u151.close.check'), t('u151.close.doc'), t('rep.col.date'), t('rep.col.plate'), t('rep.col.company'),
      t('rep.col.item'), t('u151.close.qty'), t('u151.close.note')], rows)
  }
  const total = d ? SECTIONS.reduce((a, k) => a + (d[k] || []).length, 0) : 0
  return (
    <>
      <PageHead title={t('u151.close.title')} sub={t('u151.close.sub')} />
      <ReportBar period={period} onCsv={csv} csvDisabled={!total} />
      <ReportError error={res.error} />
      {res.error ? null : !d ? <div className="muted">{t('common.loading')}</div> : total === 0 ? (
        <Card><Empty icon="check" title={t('u151.close.allClear')}>{t('u151.close.allClearText')}</Empty></Card>
      ) : (
        <div className={res.loading ? 'stale' : ''}>
          {SECTIONS.map((k) => {
            const list = d[k] || []
            return (
              <section key={k} className="card" style={{ marginBottom: 12 }}>
                <div className="row" style={{ gap: 8 }}>
                  <b>{t(`u151.close.s.${k}`)}</b>
                  {list.length ? <Badge color="amber">{num(list.length)}</Badge> : <Badge color="green">{t('u151.close.ok')}</Badge>}
                </div>
                <div className="small muted" style={{ margin: '2px 0 6px' }}>{t(`u151.close.h.${k}`)}</div>
                {list.length > 0 && <ul className="close-list">{list.slice(0, 200).map((x, i) => <li key={i}>{line(k, x)}</li>)}</ul>}
                {list.length > 200 && <div className="small muted">{t('u151.close.more', { n: list.length - 200 })}</div>}
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}
