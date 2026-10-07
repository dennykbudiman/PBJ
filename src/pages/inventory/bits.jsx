import React from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '../../components/ui'
import { useT } from '../../lib/i18n'
import { jobNo } from '../../lib/format'
import { PAY_COLOR, PO_COLOR } from '../../lib/inventory'

// Small pieces shared by the inventory screens and the job page.
// "Job 100042 · B 1234 XY", linking to the job.
export function JobRef({ data, roId, plain }) {
  const { t } = useT()
  if (!roId) return <span className="muted">{t('inv.forStock')}</span>
  const j = data.jobById[roId]
  const v = j && data.vehicleById[j.vehicle_id]
  const text = `${t('inv.job')} ${j ? jobNo(j.job_number) : '…'}${v ? ` · ${v.plate}` : ''}`
  return plain ? <span>{text}</span> : <Link to={`/jobs/${roId}`}>{text}</Link>
}

export function PoBadge({ status }) {
  const { t } = useT()
  return <Badge color={PO_COLOR[status]}>{t(`inv.po.st.${status}`)}</Badge>
}

export function PayBadge({ status }) {
  const { t } = useT()
  return <Badge color={PAY_COLOR[status]}>{t(`inv.pay.st.${status}`)}</Badge>
}

// A small checkbox cell for selectable rows.
export function Tick({ checked, onChange, label, disabled }) {
  return <input type="checkbox" className="tick" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
}
