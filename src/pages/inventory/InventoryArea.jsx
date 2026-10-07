import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../../components/Layout'
import { Notice, SubTabs } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { useInventoryData } from './useInventoryData'
import StockTab from './StockTab'
import PurchaseOrdersTab from './PurchaseOrdersTab'
import PoPage from './PoPage'
import ReturnsTab from './ReturnsTab'
import CoresTab from './CoresTab'
import BillsTab from './BillsTab'

export const INVENTORY_TABS = ['stock', 'purchase-orders', 'returns', 'cores', 'bills']

// /inventory → Stock, /inventory/<tab>, /inventory/purchase-orders/<id>
export function parseInventoryPath(pathname) {
  const parts = pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
  if (!parts.length || !INVENTORY_TABS.includes(parts[0])) return { tab: 'stock', id: null }
  return { tab: parts[0], id: parts[1] || null }
}

export default function InventoryArea() {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { can } = useAuth()
  const showCost = can('view_costs')
  const { tab: asked, id } = parseInventoryPath(location.pathname)
  // Supplier bills are money only, so they need cost access.
  const tabs = INVENTORY_TABS.filter((x) => x !== 'bills' || showCost)
  const tab = tabs.includes(asked) ? asked : 'stock'
  const { data, error, reload } = useInventoryData()
  const go = (path) => navigate(path)

  const tabBar = <SubTabs tabs={tabs.map((x) => ({ value: x, label: t(`inv.tab.${x}`) }))} active={tab} onChange={(x) => go(`/inventory/${x}`)} />
  if (!data) return <Page tabs={tabBar}><div className="muted">{error ? errorText(error, t) : t('common.loading')}</div></Page>

  // After a partial load failure, changes are paused so nothing is worked out from rows that didn't load.
  const props = { data, reload, go, canEdit: can('manage_inventory') && !error, canAdjust: can('adjust_stock'), showCost }
  let body
  if (tab === 'purchase-orders') body = id ? <PoPage key={id} id={id} {...props} /> : <PurchaseOrdersTab {...props} />
  else if (tab === 'returns') body = <ReturnsTab {...props} />
  else if (tab === 'cores') body = <CoresTab {...props} />
  else if (tab === 'bills') body = <BillsTab {...props} />
  else body = <StockTab {...props} />

  return (
    <Page tabs={tabBar}>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{t('inv.loadFailed', { error: errorText(error, t) })}</Notice>}
      {body}
    </Page>
  )
}
