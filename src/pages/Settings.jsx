import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../context/AuthContext'
import { colors, PERMISSIONS } from '../lib/theme'
import PageHeader, { PrimaryButton, SecondaryButton } from '../components/PageHeader'
import Badge from '../components/Badge'

const TABS = [
  { key: 'general', label: 'General' },
  { key: 'notif', label: 'Notifications' },
  { key: 'users', label: 'Users & Roles' },
  { key: 'integrations', label: 'Integrations' },
]

const NOTIF_FIELDS = [
  { key: 'notif_maintenance_due', title: 'Maintenance due reminders', desc: 'In-app alert when a service comes due' },
  { key: 'notif_critical_email', title: 'Critical alert emails', desc: 'Email the fleet manager for critical alerts' },
  { key: 'notif_critical_sms', title: 'SMS for critical alerts', desc: 'Text message to on-call staff' },
  { key: 'notif_weekly_summary', title: 'Weekly summary report', desc: 'Cost, uptime and maintenance digest every Monday' },
]

const EMPTY_ROLE_PERMS = Object.fromEntries(PERMISSIONS.map((p) => [p.key, false]))

export default function Settings() {
  const { hasPermission } = useAuth()
  const canEditSettings = hasPermission('edit_settings')
  const canManageUsers = hasPermission('manage_users')

  const [tab, setTab] = useState('general')
  const [loading, setLoading] = useState(true)

  const [settings, setSettings] = useState(null)
  const [settingsDraft, setSettingsDraft] = useState(null)

  const [roles, setRoles] = useState([]) // [{id, name}]
  const [rolePerms, setRolePerms] = useState([]) // [{role_id, permission_key}]
  const [profiles, setProfiles] = useState([]) // [{id, name, phone, status, role_id, roles:{name}}]
  const [integrations, setIntegrations] = useState([])

  const [showInvite, setShowInvite] = useState(false)
  const [invite, setInvite] = useState({ name: '', username: '', email: '', role_id: '', phone: '' })
  const [inviteError, setInviteError] = useState(null)

  const [showAddRole, setShowAddRole] = useState(false)
  const [newRoleName, setNewRoleName] = useState('')
  const [newRolePerms, setNewRolePerms] = useState({ ...EMPTY_ROLE_PERMS })

  useEffect(() => {
    load()
  }, [])

  async function load() {
    setLoading(true)
    const [{ data: s }, { data: r }, { data: rp }, { data: p }, { data: ig }] = await Promise.all([
      supabase.from('app_settings').select('*').eq('id', true).single(),
      supabase.from('roles').select('id, name').order('created_at', { ascending: true }),
      supabase.from('role_permissions').select('role_id, permission_key'),
      supabase.from('profiles').select('id, name, username, phone, status, role_id, roles(name)').order('created_at', { ascending: true }),
      supabase.from('integrations').select('*').order('name', { ascending: true }),
    ])
    setSettings(s ?? null)
    setSettingsDraft(s ?? null)
    setRoles(r ?? [])
    setRolePerms(rp ?? [])
    setProfiles(p ?? [])
    setIntegrations(ig ?? [])
    if (!invite.role_id && r && r.length > 0) setInvite((v) => ({ ...v, role_id: r[0].id }))
    setLoading(false)
  }

  // ---------- General settings ----------
  async function saveGeneral() {
    if (!canEditSettings || !settingsDraft) return
    const { id, ...payload } = settingsDraft
    await supabase.from('app_settings').update(payload).eq('id', true)
    setSettings(settingsDraft)
  }

  // ---------- Notifications (toggle = instant save) ----------
  async function toggleNotif(key) {
    if (!canEditSettings || !settings) return
    const next = { ...settings, [key]: !settings[key] }
    setSettings(next)
    setSettingsDraft((d) => (d ? { ...d, [key]: next[key] } : d))
    await supabase.from('app_settings').update({ [key]: next[key] }).eq('id', true)
  }

  // ---------- Users ----------
  // Creating a real login (a row in auth.users) needs the service_role key,
  // which must never touch client code. This calls the `invite-user`
  // Supabase Edge Function (see supabase/functions/invite-user/index.ts),
  // which holds that key server-side, re-checks the caller's manage_users
  // permission itself, sends the real invite email via
  // auth.admin.inviteUserByEmail(), and updates the resulting profiles row
  // (auto-created by the on_auth_user_created trigger) with the name/phone/
  // role chosen in this form.
  async function sendInvite() {
    setInviteError(null)
    const name = invite.name.trim()
    const email = invite.email.trim()
    const username = invite.username.trim().toLowerCase()
    if (!name || !email || !username || !invite.role_id) {
      setInviteError('Name, username, email, and role are all required.')
      return
    }
    if (!/^[a-z0-9._-]+$/.test(username)) {
      setInviteError('Username can only contain lowercase letters, numbers, dots, dashes, and underscores.')
      return
    }
    try {
      const { data, error } = await supabase.functions.invoke('invite-user', {
        body: { email, name, username, phone: invite.phone || null, roleId: invite.role_id },
      })
      // supabase-js surfaces a non-2xx function response as `error`, but the
      // JSON body with our own `{ error: "..." }` message is on error.context
      // in some client versions — check both so the real reason surfaces.
      const serverMessage = data?.error || error?.context?.error
      if (error || serverMessage) {
        throw new Error(serverMessage || error.message)
      }
      setShowInvite(false)
      setInvite({ name: '', username: '', email: '', role_id: roles[0]?.id || '', phone: '' })
      load()
    } catch (err) {
      setInviteError(
        `Couldn't send the invite (${err.message || 'unknown error'}). Make sure the invite-user Edge Function is deployed — see the Stage 3 README.`
      )
    }
  }

  // ---------- Roles & permissions ----------
  function hasRolePerm(roleId, key) {
    return rolePerms.some((rp) => rp.role_id === roleId && rp.permission_key === key)
  }

  async function toggleRolePerm(roleId, key) {
    if (!canManageUsers) return
    const exists = hasRolePerm(roleId, key)
    if (exists) {
      setRolePerms((rows) => rows.filter((rp) => !(rp.role_id === roleId && rp.permission_key === key)))
      await supabase.from('role_permissions').delete().eq('role_id', roleId).eq('permission_key', key)
    } else {
      setRolePerms((rows) => [...rows, { role_id: roleId, permission_key: key }])
      await supabase.from('role_permissions').insert({ role_id: roleId, permission_key: key })
    }
  }

  async function addRole() {
    const name = newRoleName.trim()
    if (!name || !canManageUsers) return
    const { data: role, error } = await supabase.from('roles').insert({ name }).select().single()
    if (error || !role) return
    const checkedKeys = PERMISSIONS.filter((p) => newRolePerms[p.key]).map((p) => p.key)
    if (checkedKeys.length > 0) {
      await supabase.from('role_permissions').insert(checkedKeys.map((key) => ({ role_id: role.id, permission_key: key })))
    }
    setShowAddRole(false)
    setNewRoleName('')
    setNewRolePerms({ ...EMPTY_ROLE_PERMS })
    load()
  }

  // ---------- Integrations ----------
  async function toggleIntegration(ig) {
    if (!canEditSettings) return
    const nextStatus = ig.status === 'connected' ? 'not_connected' : 'connected'
    setIntegrations((rows) => rows.map((r) => (r.id === ig.id ? { ...r, status: nextStatus } : r)))
    await supabase.from('integrations').update({ status: nextStatus }).eq('id', ig.id)
  }

  if (loading || !settingsDraft) {
    return <main style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.muted }}>Loading settings…</main>
  }

  return (
    <>
      <PageHeader title="Settings" />
      <main style={{ flex: '1 1 auto', padding: '28px 32px 48px 32px', display: 'grid', gridTemplateColumns: '220px 1fr', gap: 32, alignItems: 'start' }}>
        <nav aria-label="Settings sections" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {TABS.map((t) => {
            const active = tab === t.key
            return (
              <button
                key={t.key} type="button" onClick={() => setTab(t.key)}
                style={{
                  textAlign: 'left', fontFamily: 'inherit', fontSize: 14, fontWeight: active ? 700 : 500,
                  background: active ? colors.accentBg : 'transparent', color: active ? colors.accent : colors.text2,
                  border: 'none', borderRadius: 8, padding: '9px 8px', cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            )
          })}
        </nav>

        <div>
          {tab === 'general' && (
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 18 }}>
              <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Organization</h2>
              {!canEditSettings && (
                <div style={{ fontSize: 12, color: colors.mutedLight }}>You don't have permission to edit organization settings. Ask an Owner or Admin for "Edit settings" access.</div>
              )}
              <LabeledField label="Organization name">
                <input type="text" value={settingsDraft.org_name} disabled={!canEditSettings}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, org_name: e.target.value }))} style={fieldInput} />
              </LabeledField>
              <LabeledField label="Timezone">
                <select value={settingsDraft.timezone} disabled={!canEditSettings}
                  onChange={(e) => setSettingsDraft((d) => ({ ...d, timezone: e.target.value }))} style={fieldInput}>
                  <option>Western Indonesia Time (WIB)</option>
                  <option>Central Indonesia Time (WITA)</option>
                  <option>Eastern Indonesia Time (WIT)</option>
                </select>
              </LabeledField>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <LabeledField label="Default service interval">
                  <div style={suffixWrap}>
                    <input type="number" min="0" step="500" value={settingsDraft.default_service_interval_km} disabled={!canEditSettings}
                      onChange={(e) => setSettingsDraft((d) => ({ ...d, default_service_interval_km: Number(e.target.value) || 0 }))}
                      style={suffixInput} />
                    <span style={suffixLabel}>km</span>
                  </div>
                </LabeledField>
                <LabeledField label="Fleet size cap">
                  <div style={suffixWrap}>
                    <input type="number" min="0" step="1" value={settingsDraft.fleet_size_cap} disabled={!canEditSettings}
                      onChange={(e) => setSettingsDraft((d) => ({ ...d, fleet_size_cap: Number(e.target.value) || 0 }))}
                      style={suffixInput} />
                    <span style={suffixLabel}>vehicles</span>
                  </div>
                </LabeledField>
              </div>
              {canEditSettings && <div><PrimaryButton onClick={saveGeneral}>Save changes</PrimaryButton></div>}
            </div>
          )}

          {tab === 'notif' && (
            <div style={{ background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 24, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', maxWidth: 560, display: 'flex', flexDirection: 'column' }}>
              <h2 style={{ margin: '0 0 4px 0', fontSize: 15, fontWeight: 700 }}>Notification preferences</h2>
              <p style={{ margin: '0 0 14px 0', fontSize: 13, color: colors.muted }}>Choose how the team hears about fleet activity.</p>
              {!canEditSettings && (
                <div style={{ fontSize: 12, color: colors.mutedLight, marginBottom: 8 }}>You don't have permission to change notification settings.</div>
              )}
              {NOTIF_FIELDS.map((f) => (
                <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', borderTop: `1px solid ${colors.border}` }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{f.title}</div>
                    <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{f.desc}</div>
                  </div>
                  <Switch on={!!settings[f.key]} onClick={() => toggleNotif(f.key)} disabled={!canEditSettings} label={f.title} />
                </div>
              ))}
            </div>
          )}

          {tab === 'users' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 840 }}>
              {canManageUsers && (
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <PrimaryButton onClick={() => setShowInvite((v) => !v)}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                    Invite User
                  </PrimaryButton>
                </div>
              )}

              {showInvite && canManageUsers && (
                <div style={panelStyle}>
                  <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Invite new user</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <LabeledField label="Name">
                      <input type="text" value={invite.name} onChange={(e) => setInvite((v) => ({ ...v, name: e.target.value }))} style={fieldInput} />
                    </LabeledField>
                    <LabeledField label="Username">
                      <input
                        type="text"
                        placeholder="what they'll sign in with"
                        value={invite.username}
                        onChange={(e) => setInvite((v) => ({ ...v, username: e.target.value }))}
                        style={{ ...fieldInput, fontFamily: 'IBM Plex Mono, monospace' }}
                      />
                    </LabeledField>
                    <LabeledField label="Email">
                      <input type="email" value={invite.email} onChange={(e) => setInvite((v) => ({ ...v, email: e.target.value }))} style={fieldInput} />
                    </LabeledField>
                    <LabeledField label="Role">
                      <select value={invite.role_id} onChange={(e) => setInvite((v) => ({ ...v, role_id: e.target.value }))} style={fieldInput}>
                        {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </LabeledField>
                    <LabeledField label="Phone">
                      <input type="text" placeholder="+62 8XX-XXXX-XXXX" value={invite.phone} onChange={(e) => setInvite((v) => ({ ...v, phone: e.target.value }))} style={{ ...fieldInput, fontFamily: 'IBM Plex Mono, monospace' }} />
                    </LabeledField>
                  </div>
                  {inviteError && <div style={{ fontSize: 12, color: colors.danger, lineHeight: 1.5 }}>{inviteError}</div>}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <SecondaryButton onClick={() => { setShowInvite(false); setInviteError(null) }}>Cancel</SecondaryButton>
                    <PrimaryButton onClick={sendInvite}>Send invite</PrimaryButton>
                  </div>
                </div>
              )}

              <div style={tableWrapStyle}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', minWidth: 700, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                        <th style={thStyle}>Name</th>
                        <th style={thStyle}>Username</th>
                        <th style={thStyle}>Role</th>
                        <th style={thStyle}>Phone</th>
                        <th style={{ ...thStyle, padding: '12px 20px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profiles.length === 0 && <tr><td colSpan={5} style={{ padding: 20, fontSize: 13, color: colors.mutedLight }}>No users yet.</td></tr>}
                      {profiles.map((u) => (
                        <tr key={u.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                          <td style={{ padding: '13px 20px', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{u.name}</td>
                          <td style={{ ...tdStyle2, color: colors.text2, fontFamily: 'IBM Plex Mono, monospace' }}>{u.username || '—'}</td>
                          <td style={{ ...tdStyle2, color: colors.text2 }}>{u.roles?.name || '—'}</td>
                          <td style={{ ...tdStyle2, color: colors.text2, fontFamily: 'IBM Plex Mono, monospace' }}>{u.phone || '—'}</td>
                          <td style={{ padding: '13px 20px' }}>
                            <Badge bg={u.status === 'active' ? colors.accentBg : colors.warnBg} color={u.status === 'active' ? colors.good : colors.warn}>
                              {u.status === 'active' ? 'Active' : 'Invited'}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 }}>
                <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Roles &amp; permissions</h2>
                {canManageUsers && (
                  <SecondaryButton onClick={() => setShowAddRole((v) => !v)}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.ink} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
                    Add role
                  </SecondaryButton>
                )}
              </div>

              {showAddRole && canManageUsers && (
                <div style={panelStyle}>
                  <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>New role</h3>
                  <LabeledField label="Role name">
                    <input type="text" value={newRoleName} onChange={(e) => setNewRoleName(e.target.value)} style={{ ...fieldInput, maxWidth: 280 }} />
                  </LabeledField>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: colors.muted, marginBottom: 8 }}>Permissions</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px' }}>
                      {PERMISSIONS.map((p) => (
                        <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: colors.ink, cursor: 'pointer' }}>
                          <input type="checkbox" checked={!!newRolePerms[p.key]} onChange={() => setNewRolePerms((v) => ({ ...v, [p.key]: !v[p.key] }))} />
                          {p.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                    <SecondaryButton onClick={() => setShowAddRole(false)}>Cancel</SecondaryButton>
                    <PrimaryButton onClick={addRole}>Create role</PrimaryButton>
                  </div>
                </div>
              )}

              <div style={tableWrapStyle}>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', minWidth: 760, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ textAlign: 'left', background: '#FBFAF8' }}>
                        <th style={thStyle}>Role</th>
                        {PERMISSIONS.map((p) => (
                          <th key={p.key} style={{ ...thStyle, padding: '12px 10px', textAlign: 'center' }}>{p.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {roles.map((r) => (
                        <tr key={r.id} style={{ borderTop: `1px solid rgba(28,30,34,0.07)` }}>
                          <td style={{ padding: '13px 16px', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{r.name}</td>
                          {PERMISSIONS.map((p) => (
                            <td key={p.key} style={{ padding: '13px 10px', textAlign: 'center' }}>
                              <input
                                type="checkbox" checked={hasRolePerm(r.id, p.key)} disabled={!canManageUsers}
                                onChange={() => toggleRolePerm(r.id, p.key)} aria-label={`${p.label} for ${r.name}`}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {tab === 'integrations' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 640 }}>
              {integrations.length === 0 && <div style={{ fontSize: 13, color: colors.mutedLight }}>No integrations configured.</div>}
              {integrations.map((ig) => (
                <div key={ig.id} style={{ display: 'flex', alignItems: 'center', gap: 16, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: '18px 20px', boxShadow: '0 1px 2px rgba(20,20,20,0.04)' }}>
                  <div style={{ width: 40, height: 40, borderRadius: 10, background: colors.neutralBg, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 13, fontWeight: 800, color: colors.neutral }}>
                    {ig.name.slice(0, 3).toUpperCase()}
                  </div>
                  <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700 }}>{ig.name}</div>
                    <div style={{ fontSize: 12, color: colors.mutedLight, marginTop: 2 }}>{ig.description}</div>
                  </div>
                  <Badge bg={ig.status === 'connected' ? colors.accentBg : colors.neutralBg} color={ig.status === 'connected' ? colors.good : colors.neutral}>
                    {ig.status === 'connected' ? 'Connected' : 'Not connected'}
                  </Badge>
                  <SecondaryButton onClick={() => toggleIntegration(ig)} disabled={!canEditSettings} style={{ opacity: canEditSettings ? 1 : 0.5, cursor: canEditSettings ? 'pointer' : 'not-allowed' }}>
                    {ig.status === 'connected' ? 'Manage' : 'Connect'}
                  </SecondaryButton>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  )
}

function LabeledField({ label, children }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: colors.muted, marginBottom: 6 }}>{label}</label>
      {children}
    </div>
  )
}

function Switch({ on, onClick, disabled, label }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled}
      style={{
        position: 'relative', width: 40, height: 22, borderRadius: 999, border: 'none',
        background: on ? colors.accent : '#D1CFC5', cursor: disabled ? 'not-allowed' : 'pointer', flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ position: 'absolute', top: 2, left: on ? 20 : 2, width: 18, height: 18, borderRadius: 999, background: colors.white, boxShadow: '0 1px 2px rgba(20,20,20,0.25)' }} />
    </button>
  )
}

const fieldInput = { width: '100%', fontFamily: 'inherit', fontSize: 13, padding: '9px 12px', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, background: colors.white, color: colors.ink }
const suffixWrap = { display: 'flex', alignItems: 'center', border: `1px solid ${colors.borderStrong}`, borderRadius: 8, background: colors.white, overflow: 'hidden' }
const suffixInput = { flex: '1 1 auto', minWidth: 0, fontFamily: 'IBM Plex Mono, monospace', fontSize: 13, padding: '9px 12px', border: 'none', background: 'transparent', color: colors.ink, outline: 'none' }
const suffixLabel = { flexShrink: 0, fontSize: 12, color: colors.mutedLight, padding: '9px 12px 9px 0' }
const panelStyle = { background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 20, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', display: 'flex', flexDirection: 'column', gap: 14 }
const tableWrapStyle = { background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 12, boxShadow: '0 1px 2px rgba(20,20,20,0.04)', overflow: 'hidden' }
const thStyle = { padding: '12px 20px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: colors.mutedLight, fontWeight: 700 }
const tdStyle2 = { padding: '13px 12px', fontSize: 13, whiteSpace: 'nowrap' }
