/**
 * Pure decisions shared by the sync engine and the vault store, kept free of browser
 * imports so they can be asserted in Node.
 */
import type { NoteMeta } from '../db.ts'

export interface PathSet {
  has(path: string): boolean
}

/**
 * Notes the remote no longer lists but that we last saw there.
 *
 * A note we never pushed (`remoteSha === null`) is deliberately excluded: it is absent
 * from the remote tree simply because it has not been uploaded yet. Flagging it would
 * tell the user the file was deleted remotely and re-publish it on every sync.
 */
export function findRemoteDeletions(local: readonly NoteMeta[], remotePaths: PathSet): NoteMeta[] {
  return local.filter(
    (n) => !n.removedLocal && !n.removedRemote && n.remoteSha !== null && !remotePaths.has(n.path),
  )
}

/** A local delete/rename only has to be queued for the remote when the remote holds the file. */
export function needsRemoteDelete(meta: Pick<NoteMeta, 'remoteSha'> | undefined): boolean {
  return meta?.remoteSha != null
}
