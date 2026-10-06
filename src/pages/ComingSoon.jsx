import React from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Empty, PageHead } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'

// Build order agreed for step 3. Each placeholder says which stage brings it.
export const STAGES = ['foundations', 'customers', 'catalog', 'jobs', 'print', 'board', 'inventory', 'schedules', 'reports']

export default function ComingSoon({ titleKey, stage, icon }) {
  const { t } = useT()
  const n = STAGES.indexOf(stage) + 1
  return (
    <Page>
      <PageHead title={t(titleKey)} />
      <div className="card">
        <Empty icon={icon} title={t('soon.title')}>
          {t('soon.text', { stage: n, name: t(`stage.${stage}`) })}
        </Empty>
      </div>
    </Page>
  )
}

export function Dashboard() {
  const { t } = useT()
  const { profile } = useAuth()
  const first = (profile?.name || '').split(' ')[0]
  return (
    <Page>
      <PageHead title={t('dash.hello', { name: first })} sub={t('dash.sub')} />
      <div className="card">
        <h2>{t('dash.buildTitle')}</h2>
        <p className="muted" style={{ marginTop: 0, lineHeight: 1.55 }}>{t('dash.buildText')}</p>
        <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
          {STAGES.map((s, i) => (
            <li key={s} style={{ color: i === 0 ? 'var(--green)' : undefined, fontWeight: i === 0 ? 700 : 500 }}>
              {t(`stage.${s}`)}{i === 0 ? ` — ${t('dash.ready')}` : ''}
            </li>
          ))}
        </ol>
        <p className="hint" style={{ marginTop: 12 }}>
          {t('dash.startHere')} <Link to="/settings">{t('nav.settings')}</Link>
        </p>
      </div>
    </Page>
  )
}

export function SearchPage() {
  const { t } = useT()
  const q = new URLSearchParams(useLocation().search).get('q') || ''
  return (
    <Page>
      <PageHead title={t('search.title')} sub={q ? t('search.for', { q }) : null} />
      <div className="card">
        <Empty icon="search" title={t('soon.title')}>{t('search.soon')}</Empty>
      </div>
    </Page>
  )
}

export function NotFound() {
  const { t } = useT()
  return (
    <Page>
      <div className="card">
        <Empty icon="info" title={t('notFound.title')} action={<Link className="btn" to="/">{t('notFound.home')}</Link>}>
          {t('notFound.text')}
        </Empty>
      </div>
    </Page>
  )
}
