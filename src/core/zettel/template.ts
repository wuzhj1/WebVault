/**
 * The body of a brand-new card.
 *
 * The exact byte shape matters: Lute eats a blank line after the closing `---` and eats trailing
 * blank lines at EOF, so emitting either one guarantees a phantom diff the first time the note is
 * saved — which flips `gitBlobSha`, marks the note dirty and pushes a no-op change to Gitee.
 * Verified against the vendored Lute binary in Phase 0.
 *
 * Relative imports only: `scripts/verify-zettel.mts` runs this under plain node with no alias
 * resolver.
 */
import { encodeList, encodeScalar } from '../parse/frontmatter.ts'
import type { CardType } from './card.ts'

export interface CardDraft {
  zid: string
  type: CardType
  /** `2026-09-15 14:23`, as written by `createdStamp`. */
  created: string
  title: string
  tags?: readonly string[]
  aliases?: readonly string[]
}

/**
 * `---\nid: …\ntype: …\ncreated: …\n---\n# 标题\n`
 *
 * Keys go in the order the writer uses (`KEY_ORDER`), so a later `writeKeys` of the same value is
 * the identity function. Empty lists are omitted rather than written as `tags: []`: an empty list
 * is noise a reader would have to delete by hand.
 */
export function renderCardTemplate(draft: CardDraft): string {
  const keys = [`id: ${encodeScalar(draft.zid)}`, `type: ${encodeScalar(draft.type)}`]
  if (draft.created !== '') keys.push(`created: ${encodeScalar(draft.created)}`)
  if (draft.tags && draft.tags.length > 0) keys.push(`tags: ${encodeList(draft.tags)}`)
  if (draft.aliases && draft.aliases.length > 0) keys.push(`aliases: ${encodeList(draft.aliases)}`)

  return `---\n${keys.join('\n')}\n---\n# ${draft.title}\n`
}
