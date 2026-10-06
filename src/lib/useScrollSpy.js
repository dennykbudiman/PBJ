import { useCallback, useEffect, useRef, useState } from 'react'

// Keeps a side menu in step with the page: the highlighted entry is the section
// whose top has scrolled up to just under the top bar. At the very bottom of the
// page the last section wins, because short last sections never reach the top.
// `go(id)` scrolls to a section and holds the highlight on it while the page glides.
export function useScrollSpy(ids, { prefix = '', offset = 96 } = {}) {
  const [active, setActive] = useState(ids[0])
  const holdUntil = useRef(0)
  const key = ids.join('|')

  useEffect(() => {
    let frame = 0
    const measure = () => {
      frame = 0
      if (Date.now() < holdUntil.current) return
      const doc = document.documentElement
      const scrollable = doc.scrollHeight > window.innerHeight + 4
      const atBottom = scrollable && window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 4
      let current = ids[0]
      if (atBottom) current = ids[ids.length - 1]
      else {
        for (const id of ids) {
          const el = document.getElementById(prefix + id)
          if (el && el.getBoundingClientRect().top - offset <= 1) current = id
        }
      }
      setActive((a) => (a === current ? a : current))
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure) }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    // Sections load in after the page opens and change height: measure again when they do.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onScroll) : null
    ro?.observe(document.body)
    measure()
    return () => {
      ro?.disconnect()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [key, prefix, offset]) // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((id) => {
    const el = document.getElementById(prefix + id)
    if (!el) return
    setActive(id)
    holdUntil.current = Date.now() + 900
    const top = el.getBoundingClientRect().top + window.scrollY - offset + 16
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [prefix, offset])

  return [active, go]
}
