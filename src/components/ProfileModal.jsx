import React, { useEffect, useState } from 'react'
import { Button, Input, Modal, Notice, Select } from './ui'
import { supabase, errorText } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useT } from '../lib/i18n'
import { PW_CHANGED_KEY } from '../pages/Login'

// "My profile": a person's own name, phone, language and password.
export default function ProfileModal({ open, onClose }) {
  const { t, setLang } = useT()
  const { profile, refreshProfile } = useAuth()
  const [form, setForm] = useState({ name: '', phone: '', language: '' })
  const [pw, setPw] = useState({ a: '', b: '' })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  useEffect(() => {
    if (open && profile) {
      setForm({ name: profile.name || '', phone: profile.phone || '', language: profile.language || '' })
      setPw({ a: '', b: '' })
      setMsg(null)
    }
  }, [open, profile])

  async function save() {
    setMsg(null)
    if (!form.name.trim()) return setMsg({ kind: 'err', text: t('profile.nameRequired') })
    if (pw.a || pw.b) {
      if (pw.a.length < 8) return setMsg({ kind: 'err', text: t('auth.pwTooShort') })
      if (pw.a !== pw.b) return setMsg({ kind: 'err', text: t('auth.pwMismatch') })
    }
    setBusy(true)
    const { error } = await supabase
      .from('profiles')
      .update({ name: form.name.trim(), phone: form.phone.trim() || null, language: form.language || null })
      .eq('id', profile.id)
    if (error) {
      setBusy(false)
      return setMsg({ kind: 'err', text: errorText(error, t) })
    }
    if (pw.a) {
      const { error: pwErr } = await supabase.auth.updateUser({ password: pw.a, data: { password_set: true } })
      if (pwErr) {
        setBusy(false)
        return setMsg({ kind: 'err', text: errorText(pwErr, t) })
      }
      // A new password signs you out everywhere; sign in again with it (Oct 31, Denny). The sign-in page says so.
      setLang(form.language || null, { persist: false })
      try { sessionStorage.setItem(PW_CHANGED_KEY, profile?.username || '1') } catch { /* private window: no notice */ }
      const { error: outErr } = await supabase.auth.signOut({ scope: 'global' })
      if (outErr) await supabase.auth.signOut({ scope: 'local' })
      setBusy(false)
      onClose()
      return
    }
    await refreshProfile()
    setLang(form.language || null, { persist: false })
    setBusy(false)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('profile.title')}
      footer={<>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="primary" onClick={save} loading={busy}>{t('common.save')}</Button>
      </>}
    >
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <div className="grid2">
        <Input label={t('profile.name')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input label={t('profile.username')} value={profile?.username || ''} disabled hint={t('profile.usernameHint')} />
        <Input label={t('profile.phone')} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <Select
          label={t('profile.language')}
          value={form.language}
          onChange={(e) => setForm({ ...form, language: e.target.value })}
          options={[
            { value: '', label: t('profile.languageShop') },
            { value: 'en', label: 'English' },
            { value: 'id', label: 'Bahasa Indonesia' },
          ]}
        />
      </div>
      <div className="sectionlabel">{t('profile.changePassword')}</div>
      <div className="grid2">
        <Input type="password" autoComplete="new-password" label={t('auth.newPassword')} value={pw.a} onChange={(e) => setPw({ ...pw, a: e.target.value })} />
        <Input type="password" autoComplete="new-password" label={t('auth.confirmPassword')} value={pw.b} onChange={(e) => setPw({ ...pw, b: e.target.value })} />
      </div>
      <div className="hint" style={{ marginTop: -4 }}>{t('profile.passwordHint')}</div>
    </Modal>
  )
}
