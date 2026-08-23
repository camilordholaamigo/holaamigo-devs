'use client'

import { useEffect, useState } from 'react'

/**
 * Returns true after the component has mounted on the client.
 * Useful to gate any time-relative computation (e.g. "hace 5m") that uses
 * `Date.now()` during render — those values differ between server and
 * client and cause React #418 hydration errors. With `useMounted`, we
 * render a stable placeholder during SSR + initial hydration, then the
 * real value once we know we're on the client.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  return mounted
}
