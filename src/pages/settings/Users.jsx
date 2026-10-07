import React, { useCallback, useEffect, useState } from 'react'
import { Avatar, Badge, Button, Card, Input, Modal, Notice, Select, useToast } from '../../components/ui'
import { supabase, errorText } from '../../lib/supabase'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../lib/i18n'

// Role order and descriptions shown in Settings (decided Oct 5; technicians view-only Oct 5).
const ROLE_ORDER = ['Owner', 'Admin', 'Service advisor', 'Cashier', 'Technician', 'Viewer', 'Fleet manager']
const STATUS_COLOR = { active: 'green', invited: 'amber', disabled: 'gray' }

const BLANK = { name: '', email: '', username: '', phone: '', role_id: '' }
// Invites can't create Owners; an Owner promotes someone afterwards.

export default function Users({ id }) {
  const { t } = useT()
  const toast = useToast()
  const { can, user, roleName: myRole } = useAuth()
  const manage = can('manage_users')
  const [people, setPeople] = useState(null)
  const [roles, setRoles] = useState([])
  const [invite, setInvite] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [confirm, setConfirm] = useState(null) // { person, patch | remove, text }

  const load = useCallback(async () => {
    const [p, r] = await Promise.all([
      supabase.from('profiles').select('id, name, username, phone, status, role_id, roles(name)').order('name'),
      supabase.from('roles').select('id, name'),
    ])
    if (p.error) toast(errorText(p.error, t), 'err')
    setPeople(p.data ?? [])
    const sorted = (r.data ?? []).slice().sort((a, b) => ROLE_ORDER.indexOf(a.name) - ROLE_ORDER.indexOf(b.name))
    setRoles(sorted)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const roleOptions = roles.map((r) => ({ value: r.id, label: t(`role.${r.name}`) }))
  const ownerRoleId = roles.find((r) => r.name === 'Owner')?.id
  const activeOwners = (people ?? []).filter((p) => p.role_id === ownerRoleId && p.status === 'active').length
  // Only an Owner can change another Owner, or make someone an Owner, and the last active Owner stays.
  const canTouch = (p) => manage && p.id !== user?.id && (p.role_id !== ownerRoleId || myRole === 'Owner')
  const ownerLocked = (p) => p.role_id === ownerRoleId && p.status === 'active' && activeOwners <= 1
  const choosable = myRole === 'Owner' ? roleOptions : roleOptions.filter((o) => o.value !== ownerRoleId)

  function askChange(person, patch) {
    if (ownerLocked(person) && (patch.status === 'disabled' || (patch.role_id && patch.role_id !== ownerRoleId))) {
      return toast(t('users.lastOwner'), 'err')
    }
    if (patch.status === 'disabled') return setConfirm({ person, patch, text: t('users.confirmDisable', { name: person.name }) })
    if (patch.role_id === ownerRoleId) return setConfirm({ person, patch, text: t('users.confirmOwner', { name: person.name }) })
    change(person, patch)
  }

  async function change(person, patch) {
    setSavingId(person.id)
    const { error: err } = await supabase.from('profiles').update(patch).eq('id', person.id)
    setSavingId(null)
    if (err) return toast(errorText(err, t), 'err')
    toast(t('users.updated', { name: person.name }))
    load()
  }

  // Edge functions return their message in the response body.
  async function functionError(data, err) {
    let message = data?.error
    if (err && !message) {
      try { message = (await err.context?.json())?.error } catch { /* not JSON */ }
      message = message || errorText(err, t)
    }
    return message
  }

  async function remove(person) {
    setSavingId(person.id)
    const { data, error: err } = await supabase.functions.invoke('delete-user', { body: { userId: person.id } })
    setSavingId(null)
    const message = await functionError(data, err)
    if (message) return toast(message, 'err')
    toast(t('users.removed', { name: person.name }))
    load()
  }

  async function sendInvite() {
    setError(null)
    const f = { ...invite, name: invite.name.trim(), email: invite.email.trim().toLowerCase(), username: invite.username.trim().toLowerCase(), phone: invite.phone.trim() }
    if (!f.name || !f.email || !f.username || !f.role_id) return setError(t('users.inviteRequired'))
    if (!/^\S+@\S+\.\S+$/.test(f.email)) return setError(t('settings.badEmail'))
    if (!/^[a-z0-9._-]{3,30}$/.test(f.username)) return setError(t('users.usernameRule'))
    setBusy(true)
    const { data, error: err } = await supabase.functions.invoke('invite-user', {
      body: { name: f.name, email: f.email, username: f.username, phone: f.phone || null, roleId: f.role_id, redirectTo: `${window.location.origin}/set-password` },
    })
    setBusy(false)
    const message = await functionError(data, err)
    if (message) return setError(message)
    setInvite(null)
    toast(t('users.invited', { email: f.email }))
    load()
  }

  return (
    <Card
      id={id}
      title={t('settings.nav.users')}
      actions={manage && <Button icon="mail" size="sm" onClick={() => { setError(null); setInvite({ ...BLANK, role_id: roles.find((r) => r.name === 'Service advisor')?.id || '' }) }}>{t('users.invite')}</Button>}
    >
      {people === null && <div className="muted small">{t('common.loading')}</div>}
      {people?.length > 0 && (
        <div className="table" style={{ border: 'none', borderRadius: 0 }}>
          <table>
            <thead>
              <tr><th>{t('users.person')}</th><th>{t('users.username')}</th><th>{t('users.role')}</th><th>{t('users.status')}</th>{manage && <th aria-label={t('users.remove')} />}</tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const self = p.id === user?.id
                const roleName = p.roles?.name
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="row" style={{ gap: 9 }}>
                        <Avatar name={p.name} />
                        <div>
                          <div style={{ fontWeight: 700 }}>{p.name}{self && <span className="muted small"> · {t('users.you')}</span>}</div>
                          {p.phone && <div className="muted small">{p.phone}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="muted">{p.username ? `@${p.username}` : '—'}</td>
                    <td style={{ minWidth: 170 }}>
                      {canTouch(p) ? (
                        <select className="select" value={p.role_id || ''} disabled={savingId === p.id} onChange={(e) => askChange(p, { role_id: e.target.value })} aria-label={t('users.role')}>
                          {(choosable.some((o) => o.value === p.role_id) ? choosable : [...roleOptions.filter((o) => o.value === p.role_id), ...choosable]).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      ) : (roleName ? t(`role.${roleName}`) : '—')}
                    </td>
                    <td style={{ minWidth: 170 }}>
                      <div className="row">
                        <Badge color={STATUS_COLOR[p.status]}>{t(`users.status.${p.status}`)}</Badge>
                        {canTouch(p) && p.status !== 'active' && (
                          <button className="linkbtn small" disabled={savingId === p.id} onClick={() => askChange(p, { status: 'active' })}>{t('users.activate')}</button>
                        )}
                        {canTouch(p) && p.status === 'active' && (
                          <button className="linkbtn small" style={{ color: 'var(--red)' }} disabled={savingId === p.id} onClick={() => askChange(p, { status: 'disabled' })}>{t('users.disable')}</button>
                        )}
                      </div>
                    </td>
                    {manage && (
                      <td style={{ width: 44 }}>
                        {canTouch(p) && !ownerLocked(p) && (
                          <button className="btn ghost sm danger" disabled={savingId === p.id} title={t('users.remove')} aria-label={t('users.removeWho', { name: p.name })}
                            onClick={() => setConfirm({ person: p, remove: true, text: t('users.confirmRemove', { name: p.name }) })}>
                            <Icon name="trash" size={15} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="sectionlabel">{t('users.rolesTitle')}</div>
      <div className="rolelist">
        <b>{t('role.Owner')}</b><span>{t('users.desc.owner')}</span>
        <b>{t('role.Admin')}</b><span>{t('users.desc.admin')}</span>
        <b>{t('role.Service advisor')}</b><span>{t('users.desc.advisor')}</span>
        <b>{t('role.Cashier')}</b><span>{t('users.desc.cashier')}</span>
        <b>{t('role.Technician')}</b><span>{t('users.desc.technician')}</span>
        <b>{t('role.Viewer')}</b><span>{t('users.desc.viewer')}</span>
        <b>{t('role.Fleet manager')}</b><span>{t('users.desc.fleet')}</span>
      </div>
      <div className="hint">{t('users.hint')}</div>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={t('users.confirmTitle')}
        footer={<>
          <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
          <Button variant={confirm?.remove ? 'danger' : 'primary'} className={confirm?.remove ? 'solid' : ''}
            onClick={() => { const c = confirm; setConfirm(null); if (c.remove) remove(c.person); else change(c.person, c.patch) }}>
            {confirm?.remove ? t('users.confirmRemoveYes') : t('users.confirmYes')}
          </Button>
        </>}
      >
        <div style={{ lineHeight: 1.55 }}>{confirm?.text}</div>
      </Modal>

      <Modal
        open={!!invite}
        onClose={() => setInvite(null)}
        title={t('users.invite')}
        footer={<>
          <Button onClick={() => setInvite(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" icon="mail" onClick={sendInvite} loading={busy}>{t('users.sendInvite')}</Button>
        </>}
      >
        {invite && <>
          {error && <Notice kind="err">{error}</Notice>}
          <div className="grid2">
            <Input label={t('users.fullName')} value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} autoFocus />
            <Input label={t('users.email')} type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            <Input label={t('users.username')} value={invite.username} onChange={(e) => setInvite({ ...invite, username: e.target.value })} autoCapitalize="none" hint={t('users.usernameHint')} />
            <Input label={t('users.phone')} value={invite.phone} onChange={(e) => setInvite({ ...invite, phone: e.target.value })} />
            <Select fieldClass="span2" label={t('users.role')} value={invite.role_id} onChange={(e) => setInvite({ ...invite, role_id: e.target.value })}
              options={[{ value: '', label: t('users.pickRole'), disabled: true }, ...choosable]} />
          </div>
          <div className="hint" style={{ marginTop: 0 }}>{t('users.inviteHint')}</div>
        </>}
      </Modal>
    </Card>
  )
}
