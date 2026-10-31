import React, { useCallback, useEffect, useState } from 'react'
import { Avatar, Badge, Button, Card, Input, Modal, Notice, Select, useToast } from '../../components/ui'
import { supabase, errorText } from '../../lib/supabase'
import Icon from '../../components/Icon'
import { useAuth } from '../../context/AuthContext'
import { useT } from '../../lib/i18n'
import { timeAgo } from '../../lib/format'

// Role order and descriptions shown in Settings (decided Oct 5; technicians view-only Oct 5).
const ROLE_ORDER = ['Owner', 'Admin', 'Service advisor', 'Cashier', 'Technician', 'Viewer', 'Fleet manager']
const STATUS_COLOR = { active: 'green', invited: 'amber', disabled: 'gray' }

const BLANK = { name: '', email: '', username: '', phone: '', role_id: '', companies: [], method: 'email', password: '' }
// Invites can't create Owners; an Owner promotes someone afterwards.

// A temporary password that is easy to read out or type: no 0/O, 1/l/I (e.g. "k7mp-x2qa-9r").
export function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  const s = Array.from(bytes, (b) => chars[b % chars.length]).join('')
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`
}

export default function Users({ id }) {
  const { t, lang } = useT()
  const toast = useToast()
  const { can, user, roleName: myRole } = useAuth()
  const manage = can('manage_users')
  const [people, setPeople] = useState(null)
  const [roles, setRoles] = useState([])
  const [logins, setLogins] = useState({}) // id → { invited, last_sign_in_at } (people who manage users only)
  const [invite, setInvite] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const [confirm, setConfirm] = useState(null) // { person, patch | remove, text }
  const [links, setLinks] = useState({}) // Fleet manager id → [company ids] (migration 133)
  const [companies, setCompanies] = useState([])
  const [linking, setLinking] = useState(null) // { person, picked }
  const [made, setMade] = useState(null) // { name, username, password, reset, copied } after a temporary password is set
  // Closing the result empties the clipboard if we put the password there (shared counter PCs).
  const closeMade = () => {
    if (made?.copied) navigator.clipboard?.writeText('').catch(() => {})
    setMade(null)
  }
  const [resetting, setResetting] = useState(null) // { person, password, error }

  const load = useCallback(async () => {
    const [p, r, l, f, c] = await Promise.all([
      supabase.from('profiles').select('id, name, username, phone, status, role_id, roles(name)').order('name'),
      supabase.from('roles').select('id, name'),
      manage ? supabase.rpc('user_logins') : { data: [] },
      manage ? supabase.from('fleet_manager_companies').select('user_id, customer_id') : { data: [] },
      manage ? supabase.from('customers').select('id, display_name, active').order('display_name') : { data: [] },
    ])
    setLogins(Object.fromEntries((l.data ?? []).map((x) => [x.id, x])))
    const byUser = {}
    for (const x of f.data ?? []) (byUser[x.user_id] ||= []).push(x.customer_id)
    setLinks(byUser)
    setCompanies(c.data ?? [])
    if (p.error) toast(errorText(p.error, t), 'err')
    setPeople(p.data ?? [])
    const sorted = (r.data ?? []).slice().sort((a, b) => ROLE_ORDER.indexOf(a.name) - ROLE_ORDER.indexOf(b.name))
    setRoles(sorted)
  }, [manage]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load() }, [load])

  const roleOptions = roles.map((r) => ({ value: r.id, label: t(`role.${r.name}`) }))
  const ownerRoleId = roles.find((r) => r.name === 'Owner')?.id
  const activeOwners = (people ?? []).filter((p) => p.role_id === ownerRoleId && p.status === 'active').length
  // Only an Owner can change another Owner, or make someone an Owner, and the last active Owner stays.
  const canTouch = (p) => manage && p.id !== user?.id && (p.role_id !== ownerRoleId || myRole === 'Owner')
  const ownerLocked = (p) => p.role_id === ownerRoleId && p.status === 'active' && activeOwners <= 1
  const choosable = myRole === 'Owner' ? roleOptions : roleOptions.filter((o) => o.value !== ownerRoleId)
  const invitable = roleOptions.filter((o) => o.value !== ownerRoleId)
  const fleetRoleId = roles.find((r) => r.name === 'Fleet manager')?.id
  const companyName = Object.fromEntries(companies.map((c) => [c.id, c.display_name]))

  // Which companies a Fleet manager login sees: add the new links, remove the dropped ones.
  async function saveLinks(personId, picked) {
    const had = links[personId] || []
    const add = picked.filter((x) => !had.includes(x)).map((customer_id) => ({ user_id: personId, customer_id }))
    const drop = had.filter((x) => !picked.includes(x))
    const r1 = add.length ? await supabase.from('fleet_manager_companies').insert(add) : { error: null }
    const r2 = drop.length ? await supabase.from('fleet_manager_companies').delete().eq('user_id', personId).in('customer_id', drop) : { error: null }
    return r1.error || r2.error || null
  }

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
    const byPassword = f.method === 'password'
    if (!f.name || (!byPassword && !f.email) || !f.username || !f.role_id) return setError(t(byPassword ? 'logins.required' : 'users.inviteRequired'))
    if (!byPassword && !/^\S+@\S+\.\S+$/.test(f.email)) return setError(t('settings.badEmail'))
    if (!/^[a-z0-9._-]{3,30}$/.test(f.username)) return setError(t('users.usernameRule'))
    if (byPassword && (f.password.length < 8 || f.password.length > 72)) return setError(t('logins.passwordRule'))
    const isFleetRole = f.role_id === fleetRoleId
    if (isFleetRole && !f.companies.length) return setError(t('users.fleetPickCompany'))
    setBusy(true)
    const { data, error: err } = await supabase.functions.invoke('invite-user', {
      body: { name: f.name, email: byPassword ? null : f.email, username: f.username, phone: f.phone || null, roleId: f.role_id, redirectTo: `${window.location.origin}/set-password`,
        method: f.method, password: byPassword ? f.password : undefined },
    })
    setBusy(false)
    const message = await functionError(data, err)
    if (message) { setBusy(false); return setError(message) }
    if (isFleetRole && data?.userId) {
      const linkErr = await saveLinks(data.userId, f.companies)
      if (linkErr) toast(errorText(linkErr, t), 'err')
    }
    setInvite(null)
    if (byPassword) setMade({ name: f.name, username: f.username, password: f.password })
    else toast(t('users.invited', { email: f.email }))
    load()
  }

  // A new temporary password for someone who forgot theirs (edge function reset-password, migration 134).
  async function resetPassword() {
    const r = resetting
    if (r.password.length < 8 || r.password.length > 72) return setResetting({ ...r, error: t('logins.passwordRule') })
    setSavingId(r.person.id)
    const { data, error: err } = await supabase.functions.invoke('reset-password', { body: { userId: r.person.id, password: r.password } })
    setSavingId(null)
    const message = await functionError(data, err)
    if (message) return setResetting({ ...r, error: message })
    setResetting(null)
    setMade({ name: r.person.name, username: r.person.username, password: r.password, reset: true })
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
                          {manage && logins[p.id] && (
                            <div className="muted small">{logins[p.id].invited ? t('users.inviteNotDone')
                              : logins[p.id].last_sign_in_at ? t('users.lastSignIn', { when: timeAgo(logins[p.id].last_sign_in_at, lang) }) : t('users.neverSignedIn')}
                              {logins[p.id].no_email && <> · {t('logins.noEmail')}</>}</div>
                          )}
                          {manage && logins[p.id]?.temp_password && <div className="small" style={{ color: 'var(--amber-text, #92400e)' }}>{t('logins.tempNotChanged')}</div>}
                          {canTouch(p) && (roleName !== 'Fleet manager' || myRole === 'Owner') && (
                            <button type="button" className="linkbtn small" disabled={savingId === p.id}
                              onClick={() => setResetting({ person: p, password: tempPassword(), error: null })}>{t('logins.reset')}</button>
                          )}
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
                      {roleName === 'Fleet manager' && manage && (
                        <div className="small" style={{ marginTop: 4 }}>
                          <span className="muted">{(links[p.id] || []).map((x) => companyName[x]).filter(Boolean).join(', ') || t('users.fleetNone')}</span>
                          {canTouch(p) && <> · <button type="button" className="linkbtn small" onClick={() => setLinking({ person: p, picked: links[p.id] || [] })}>{t('users.fleetEdit')}</button></>}
                        </div>
                      )}
                    </td>
                    <td style={{ minWidth: 170 }}>
                      <div className="row">
                        {p.status === 'active' && logins[p.id]?.invited
                          ? <Badge color="amber" title={t('users.inviteNotDone')}>{t('users.status.invitedPending')}</Badge>
                          : <Badge color={STATUS_COLOR[p.status]}>{t(`users.status.${p.status}`)}</Badge>}
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
        open={!!linking}
        onClose={() => setLinking(null)}
        title={t('users.fleetTitle', { name: linking?.person.name || '' })}
        footer={<>
          <Button onClick={() => setLinking(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={savingId === linking?.person.id} onClick={async () => {
            const l = linking
            setSavingId(l.person.id)
            const err = await saveLinks(l.person.id, l.picked)
            setSavingId(null)
            if (err) return toast(errorText(err, t), 'err')
            setLinking(null)
            toast(t('users.updated', { name: l.person.name }))
            load()
          }}>{t('common.save')}</Button>
        </>}
      >
        {linking && <CompanyPicker companies={companies} picked={linking.picked} onChange={(picked) => setLinking({ ...linking, picked })} />}
      </Modal>

      <Modal
        open={!!invite}
        onClose={() => setInvite(null)}
        title={t('users.invite')}
        footer={<>
          <Button onClick={() => setInvite(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" icon={invite?.method === 'password' ? 'check' : 'mail'} onClick={sendInvite} loading={busy}>{t(invite?.method === 'password' ? 'logins.create' : 'users.sendInvite')}</Button>
        </>}
      >
        {invite && <>
          {error && <Notice kind="err">{error}</Notice>}
          <div className="sectionlabel" style={{ marginTop: 0 }}>{t('logins.how')}</div>
          <div className="seg" role="radiogroup" aria-label={t('logins.how')} style={{ marginBottom: 12 }}>
            {['email', 'password'].map((m) => (
              <button key={m} type="button" role="radio" aria-checked={invite.method === m} className={`seg-btn ${invite.method === m ? 'on' : ''}`}
                onClick={() => setInvite({ ...invite, method: m, password: m === 'password' && !invite.password ? tempPassword() : invite.password })}>{t(`logins.how.${m}`)}</button>
            ))}
          </div>
          <div className="grid2">
            <Input label={t('users.fullName')} value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} autoFocus />
            {invite.method === 'email' && <Input label={t('users.email')} type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />}
            <Input label={t('users.username')} value={invite.username} onChange={(e) => setInvite({ ...invite, username: e.target.value })} autoCapitalize="none" hint={t('users.usernameHint')} />
            <Input label={t('users.phone')} value={invite.phone} onChange={(e) => setInvite({ ...invite, phone: e.target.value })} />
            <Select fieldClass="span2" label={t('users.role')} value={invite.role_id} onChange={(e) => setInvite({ ...invite, role_id: e.target.value })}
              options={[{ value: '', label: t('users.pickRole'), disabled: true }, ...invitable]} />
            {invite.method === 'password' && (
              <div className="span2 row" style={{ gap: 8, alignItems: 'flex-end' }}>
                <Input fieldClass="grow" label={t('logins.tempPassword')} value={invite.password} onChange={(e) => setInvite({ ...invite, password: e.target.value })}
                  autoComplete="off" spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace' }} />
                <Button type="button" icon="refresh" onClick={() => setInvite({ ...invite, password: tempPassword() })}>{t('logins.generate')}</Button>
              </div>
            )}
          </div>
          {invite.role_id && invite.role_id === fleetRoleId && (
            <CompanyPicker companies={companies} picked={invite.companies} onChange={(companies2) => setInvite({ ...invite, companies: companies2 })} />
          )}
          <div className="hint" style={{ marginTop: 0 }}>{t(invite.method === 'password' ? 'logins.hint' : 'users.inviteHint')}</div>
        </>}
      </Modal>

      <Modal
        open={!!resetting}
        onClose={() => setResetting(null)}
        title={t('logins.resetTitle', { name: resetting?.person.name || '' })}
        footer={<>
          <Button onClick={() => setResetting(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" loading={savingId === resetting?.person.id} onClick={resetPassword}>{t('logins.resetSave')}</Button>
        </>}
      >
        {resetting && <>
          {resetting.error && <Notice kind="err">{resetting.error}</Notice>}
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <Input fieldClass="grow" label={t('logins.tempPassword')} value={resetting.password} onChange={(e) => setResetting({ ...resetting, password: e.target.value, error: null })}
              autoComplete="off" spellCheck={false} style={{ fontFamily: 'ui-monospace, monospace' }} />
            <Button type="button" icon="refresh" onClick={() => setResetting({ ...resetting, password: tempPassword(), error: null })}>{t('logins.generate')}</Button>
          </div>
          <div className="hint">{t('logins.resetHint', { username: resetting.person.username || '' })}</div>
        </>}
      </Modal>

      <Modal
        open={!!made}
        onClose={closeMade}
        title={t(made?.reset ? 'logins.resetDoneTitle' : 'logins.madeTitle', { name: made?.name || '' })}
        footer={<Button variant="primary" onClick={closeMade}>{t('common.close')}</Button>}
      >
        {made && <>
          <div style={{ lineHeight: 1.55 }}>{t('logins.madeText', { name: made.name })}</div>
          <div className="credbox">
            <span className="muted">{t('users.username')}</span><b>{made.username}</b>
            <span className="muted">{t('logins.tempPassword')}</span><b style={{ fontFamily: 'ui-monospace, monospace' }}>{made.password}</b>
          </div>
          <Button size="sm" icon="copy" onClick={async () => {
            try { await navigator.clipboard.writeText(`${t('users.username')}: ${made.username}\n${t('logins.tempPassword')}: ${made.password}`); setMade({ ...made, copied: true }); toast(t('logins.copied')) }
            catch { toast(t('logins.copyFailed'), 'err') }
          }}>{t('logins.copy')}</Button>
          <div className="hint">{t('logins.madeHint')}</div>
        </>}
      </Modal>
    </Card>
  )
}

// The companies a Fleet manager login may see (only their vehicles, work orders and invoices).
function CompanyPicker({ companies, picked, onChange }) {
  const { t } = useT()
  const shown = companies.filter((c) => c.active !== false || picked.includes(c.id))
  return (
    <div style={{ marginTop: 12 }}>
      <div className="sectionlabel" style={{ marginTop: 0 }}>{t('users.fleetCompanies')}</div>
      <div className="checklist" style={{ maxHeight: 260, overflow: 'auto' }}>
        {shown.map((c) => (
          <label key={c.id} className="checkrow">
            <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} />
            <span>{c.display_name}</span>
          </label>
        ))}
      </div>
      <div className="hint">{t('users.fleetHint')}</div>
    </div>
  )
}
