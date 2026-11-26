import { useEffect, useState } from 'react'

/**
 * The host theme's light/dark mode, as the plugin's client halves read it.
 * @param {any} ctx client context with the theme service.
 * @returns {'light'|'dark'} active color scheme.
 */
export function useThemeMode(ctx: any): 'light' | 'dark' {
  const [snapshot, setSnapshot] = useState<any>(() => ctx.theme.getTheme())
  useEffect(() => ctx.on('theme/change', (next: any) => setSnapshot(next)), [ctx])
  return snapshot?.active?.colorScheme === 'dark' ? 'dark' : 'light'
}
