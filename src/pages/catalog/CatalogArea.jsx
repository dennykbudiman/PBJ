import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Page } from '../../components/Layout'
import { Notice, SubTabs } from '../../components/ui'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../lib/i18n'
import { errorText } from '../../lib/supabase'
import { useCatalogData } from './useCatalogData'
import ItemsTab from './ItemsTab'
import TemplatesTab from './TemplatesTab'
import DiscountsTab from './DiscountsTab'
import InspectionsTab from './InspectionsTab'
import ChecklistsTab from './ChecklistsTab'
import CategoriesTab from './CategoriesTab'
import SuppliersTab from './SuppliersTab'

export const CATALOG_TABS = ['labor', 'parts', 'fees', 'discounts', 'flat-rate', 'bundles', 'inspections', 'checklists', 'categories', 'suppliers']

// /catalog → Parts, /catalog/<tab>, /catalog/<tab>/<id>, /catalog/<tab>/new
export function parseCatalogPath(pathname) {
  const parts = pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent)
  if (!parts.length || !CATALOG_TABS.includes(parts[0])) return { tab: 'parts', id: null }
  return { tab: parts[0], id: parts[1] || null }
}

export default function CatalogArea() {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const { can } = useAuth()
  const canEdit = can('edit_catalog')
  const { tab, id } = parseCatalogPath(location.pathname)
  const { data, error, reload } = useCatalogData()
  const go = (path) => navigate(path)

  const tabs = <SubTabs tabs={CATALOG_TABS.map((x) => ({ value: x, label: t(`cat.tab.${x}`) }))} active={tab} onChange={(x) => go(`/catalog/${x}`)} />
  if (!data) return <Page tabs={tabs}><div className="muted">{t('common.loading')}</div></Page>

  // After a partial load failure, editing is paused so child lists aren't saved over rows that didn't load.
  const props = { tab, data, id, canEdit: canEdit && !error, showCost: can('view_costs'), canAdjust: can('adjust_stock'), reload, go }
  let body
  if (['labor', 'parts', 'fees'].includes(tab)) body = <ItemsTab key={tab} {...props} />
  else if (tab === 'flat-rate' || tab === 'bundles') body = <TemplatesTab key={tab} {...props} />
  else if (tab === 'discounts') body = <DiscountsTab {...props} />
  else if (tab === 'inspections') body = <InspectionsTab {...props} />
  else if (tab === 'checklists') body = <ChecklistsTab {...props} />
  else if (tab === 'categories') body = <CategoriesTab {...props} />
  else body = <SuppliersTab {...props} />

  return (
    <Page tabs={tabs}>
      {error && <Notice kind="err" style={{ marginBottom: 12 }}>{t('cat.loadFailed', { error: errorText(error, t) })}</Notice>}
      {body}
    </Page>
  )
}
