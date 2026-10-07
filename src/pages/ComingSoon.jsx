import React from 'react'
import { Link } from 'react-router-dom'
import { Page } from '../components/Layout'
import { Empty, PageHead } from '../components/ui'
import { useT } from '../lib/i18n'

// Build order agreed for step 3. Each placeholder says which stage brings it.
export const STAGES = ['foundations', 'customers', 'catalog', 'jobs', 'print', 'board', 'inventory', 'schedules', 'reports']
// Stages built so far (stage 8 was built before stage 7, at Denny's request).
export const DONE = new Set(['foundations', 'customers', 'catalog', 'jobs', 'print', 'board', 'inventory', 'schedules', 'reports'])

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
