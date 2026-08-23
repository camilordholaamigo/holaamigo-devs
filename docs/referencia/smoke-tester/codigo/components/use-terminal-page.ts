'use client'

import { useEffect } from 'react'
import {
  useTerminalStore,
  type CopilotInsight,
} from '@/store/terminal-store'

interface UseTerminalPageOptions {
  title: string
  crumb?: string
  contextLabel?: string
  insights?: CopilotInsight[]
  nav?: string
}

/**
 * Page-level configuration hook for the /terminal shell.
 * Sets the topbar title/breadcrumb, copiloto context summary,
 * and the insights cards rendered in the right panel.
 */
export function useTerminalPage(opts: UseTerminalPageOptions) {
  const setTopbar = useTerminalStore((s) => s.setTopbar)
  const setContextLabel = useTerminalStore((s) => s.setCopilotContextLabel)
  const setInsights = useTerminalStore((s) => s.setCopilotInsights)
  const setActiveNav = useTerminalStore((s) => s.setActiveNav)

  const { title, crumb, contextLabel, insights, nav } = opts

  useEffect(() => {
    setTopbar({ title, crumb: crumb ?? '' })
    setContextLabel(contextLabel ?? '')
    setInsights(insights ?? [])
    if (nav) setActiveNav(nav)
  }, [title, crumb, contextLabel, insights, nav, setTopbar, setContextLabel, setInsights, setActiveNav])
}
