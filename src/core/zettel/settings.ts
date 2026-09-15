/**
 * Zettelkasten preferences.
 *
 * These live in Dexie, which is device-local, while the metadata they influence lives in the file.
 * So a naming rule chosen on one machine does not travel to another. `inferIdPrefix` is the cheap
 * mitigation: when the setting has never been written, read the answer off the vault itself so a
 * second device converges on the first one's choice instead of silently renaming every new card.
 *
 * Relative imports only: `scripts/verify-zettel.mts` runs this under plain node with no alias
 * resolver.
 */
import { isCardType, zidFromPath, type CardType } from './card.ts'

export const ZETTEL_SETTINGS_KEY = 'zettel-settings'

export interface ZettelSettings {
  /** `202609151423 标题.md` versus `标题.md`. */
  idPrefix: boolean
  defaultType: CardType
}

export const DEFAULT_ZETTEL_SETTINGS: ZettelSettings = {
  idPrefix: true,
  defaultType: 'fleeting',
}

/**
 * Settings as read out of Dexie, which may be absent, partial, hand-edited or from an older shape.
 * Anything unrecognized falls back to the default rather than throwing: a bad preferences row must
 * never stop the vault from opening.
 */
export function normalizeSettings(raw: unknown): ZettelSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_ZETTEL_SETTINGS }
  const value = raw as { idPrefix?: unknown; defaultType?: unknown }
  const defaultType = typeof value.defaultType === 'string' && isCardType(value.defaultType)
    ? value.defaultType
    : DEFAULT_ZETTEL_SETTINGS.defaultType
  return {
    idPrefix: typeof value.idPrefix === 'boolean' ? value.idPrefix : DEFAULT_ZETTEL_SETTINGS.idPrefix,
    defaultType,
  }
}

/** The ratio of id-prefixed filenames above which the vault is judged to use the prefix. */
const PREFIX_MAJORITY = 0.6

/**
 * What the library already does, for the case where the user has never opened the settings page.
 *
 * Cards with no id are excluded from both the numerator and the denominator: a plain note says
 * nothing about naming. With nothing to go on the answer is the default, so an empty vault and a
 * vault of frontmatter-less notes both start out id-prefixed.
 *
 * Never write the result back to Dexie. Persisting an inference pins it, and the user could then no
 * longer tell the app "stop doing what you guessed I wanted".
 */
export function inferIdPrefix(cards: readonly { path: string; zid: string }[]): boolean {
  let known = 0
  let prefixed = 0
  for (const c of cards) {
    if (c.zid === '') continue
    known++
    if (zidFromPath(c.path) === c.zid) prefixed++
  }
  if (known === 0) return DEFAULT_ZETTEL_SETTINGS.idPrefix
  return prefixed / known >= PREFIX_MAJORITY
}
