import { type RefObject, useEffect, useState } from 'react'

/**
 * Whether this widget iframe is actually shown to the agent: page visible
 * AND the element intersecting the top-level viewport (works cross-origin;
 * a display:none / detached iframe never intersects).
 */
export const useWidgetVisibility = (
  ref: RefObject<HTMLElement | null>
): boolean => {
  const [visible, setVisible] = useState<boolean>(true)
  useEffect(() => {
    let intersecting = true
    const update = (): void => {
      setVisible(document.visibilityState !== 'hidden' && intersecting)
    }
    document.addEventListener('visibilitychange', update)
    let observer: IntersectionObserver | undefined
    if (ref.current != null && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        intersecting = entries.some((e) => e.isIntersecting)
        update()
      })
      observer.observe(ref.current)
    }
    update()
    return () => {
      document.removeEventListener('visibilitychange', update)
      observer?.disconnect()
    }
  }, [ref])
  return visible
}
