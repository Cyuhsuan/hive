import { say } from '../hooks/i18n'
import { zhTW } from '../hooks/strings-zh-TW'
import type { Say } from '../types'

/** What a source says, in the zh-TW words the pane has always used. */
export const zh = (value: Say | undefined): string => say(zhTW, value)

/** An object whose values are all things a source says, with each put into zh-TW words. */
export const spoken = (value: Record<string, Say | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(value).map(([key, said]) => [key, zh(said)]))
