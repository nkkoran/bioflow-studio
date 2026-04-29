export const DEFAULT_LOCALE = 'en-US'

export const MESSAGES: Record<string, Record<string, string>> = {
  'en-US': {
    appName: 'BioFlow Studio',
  },
}

export function t(key: string, locale = DEFAULT_LOCALE): string {
  return MESSAGES[locale]?.[key] ?? MESSAGES[DEFAULT_LOCALE]?.[key] ?? key
}
