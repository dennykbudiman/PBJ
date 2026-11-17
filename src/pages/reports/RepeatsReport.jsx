import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge, Empty, PageHead } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { fmtDate, km, num } from '../../lib/format'
import { downloadCsv } from '../../lib/reports'
import { ReportBar, ReportError, companiesOf, useCompany, usePeriod, useReport } from './ReportsArea'

// Laporan → Ganti ulang (151, review 24): parts and services done again on the same truck — how many days and km
// since the last time — so early repeats (tyres, brake linings, clutch, battery …) stand out.
const GROUPS = { all: null, tyre: /\bban\b|tyre|tire|velg/i, brake: /kampas|rem\b|brake/i, clutch: /kopling|clutch/i, battery: /\baki\b|accu|battery/i }
const days = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000)

export default function RepeatsReport() {
  const { t, lang } = useT()
  const period = usePeriod('this_year')
  const [kind, setKind] = useState('part')
  const [group, setGroup] = useState('all')
  const [early, setEarly] = useState(90)
  const { rows, error, loading } = useReport('report_repeats', { p_from: period.from, p_to: period.to }, [period.from, period.to], period.valid)
  const [company, setCompany] = useCompany(rows)
  const list = useMemo(() => (rows || []).filter((r) => r.kind === kind && (!company || r.customer_id === company)
    && (!GROUPS[group] || GROUPS[group].test(`${r.name} ${r.category || ''}`))).map((r) => ({
    ...r, d: days(r.prev_day, r.day), k: r.km != null && r.prev_km != null ? r.km - r.prev_km : null,
  })).filter((r) => !early || r.d <= early).sort((a, b) => a.d - b.d), [rows, kind, company, group, early])

  function csv() {
    downloadCsv(`ganti-ulang-${period.from}-${period.to}.csv`, [t('rep.col.plate'), t('rep.col.company'), t('rep.col.item'), t('rep.col.invoice'), t('rep.col.date'), t('rep.col.km'),
      t('u151.rep2.prevInvoice'), t('u151.rep2.prevDate'), t('u151.rep2.prevKm'), t('u151.rep2.days'), t('u151.rep2.kmSince')],
    list.map((r) => [r.plate, r.company, r.name, r.invoice_no, r.day, r.km ?? '', r.prev_invoice_no, r.prev_day, r.prev_km ?? '', r.d, r.k ?? '']))
  }
  return (
    <>
      <PageHead title={t('u151.rep2.title')} sub={t('u151.rep2.sub')} />
      <ReportBar period={period} companies={companiesOf(rows)} company={company} setCompany={setCompany} onCsv={csv} csvDisabled={!list.length || loading}>
        <select className="select chipselect" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t('u151.rep2.kind')}>
          <option value="part">{t('u151.rep2.parts')}</option><option value="service">{t('u151.rep2.services')}</option>
        </select>
        {kind === 'part' && (
          <select className="select chipselect" value={group} onChange={(e) => setGroup(e.target.value)} aria-label={t('u151.rep2.group')}>
            {Object.keys(GROUPS).map((g) => <option key={g} value={g}>{t(`u151.rep2.g.${g}`)}</option>)}
          </select>
        )}
        <select className="select chipselect" value={early} onChange={(e) => setEarly(Number(e.target.value))} aria-label={t('u151.rep2.within')}>
          {[30, 90, 180, 365, 0].map((d) => <option key={d} value={d}>{d ? t('u151.rep2.withinN', { n: d }) : t('u151.rep2.any')}</option>)}
        </select>
      </ReportBar>
      <ReportError error={error} />
      {error ? null : rows === null ? <div className="muted">{t('common.loading')}</div> : list.length === 0 ? (
        <div className="card"><Empty icon="check" title={t('u151.rep2.none')}>{t('u151.rep2.noneText')}</Empty></div>
      ) : (
        <div className={`table ${loading ? 'stale' : ''}`}>
          <table>
            <thead><tr><th>{t('rep.col.plate')}</th><th>{t('rep.col.item')}</th><th>{t('u151.rep2.now')}</th><th className="wide-only">{t('u151.rep2.before')}</th>
              <th className="num">{t('u151.rep2.days')}</th><th className="num">{t('u151.rep2.kmSince')}</th></tr></thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i}>
                  <td><Link to={`/customers/vehicles/${r.vehicle_id}`}><b>{r.plate}</b></Link><div className="small muted">{r.company}</div></td>
                  <td>{r.name}{r.category && <div className="small muted">{r.category}</div>}</td>
                  <td className="small"><Link to={`/jobs/${r.ro_id}`}>{r.invoice_no}</Link> · {fmtDate(r.day, lang)}{r.km != null && ` · ${km(r.km)}`}</td>
                  <td className="small wide-only"><Link to={`/jobs/${r.prev_ro_id}`}>{r.prev_invoice_no}</Link> · {fmtDate(r.prev_day, lang)}{r.prev_km != null && ` · ${km(r.prev_km)}`}</td>
                  <td className="num">{r.d <= 30 ? <Badge color="red">{num(r.d)}</Badge> : r.d <= 90 ? <Badge color="amber">{num(r.d)}</Badge> : num(r.d)}</td>
                  <td className="num">{r.k != null ? km(r.k) : <span className="muted">–</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="hint">{t('u151.rep2.hint')}</div>
    </>
  )
}
