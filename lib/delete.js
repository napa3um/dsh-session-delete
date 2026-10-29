/**
 * Permanent session deletion.
 *
 * A deletion is deliberately staged:
 *   1. resolve and preflight every session artifact (the target plus subagent
 *      descendants) without writing anything;
 *   2. rename each session directory to a hidden sibling, which makes the
 *      session disappear atomically and proves the filesystem is writable
 *      before any metadata is touched;
 *   3. remove workspace references, projection-cache records, and scheduled
 *      tasks bound to the session;
 *   4. delete the quarantined directories.
 *
 * A live session is never deleted: its Agent and clients still hold it, and
 * deleting the log underneath them would leave a corrupt or resurrected
 * session. The UI asks the user to open another conversation first.
 *
 * @module dsh-session-delete/delete
 */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, readdir, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  conventionalSessionDir,
  encodeSegment,
  isInside,
  persistenceRoot,
} from './paths.js'

/** A deletion refusal or failure with a stable, UI-facing code. */
export class SessionDeleteError extends Error {
  /**
   * @param {string} code - stable machine-readable code.
   * @param {string} message - human-readable explanation.
   * @param {number} [status] - HTTP status for the route.
   * @param {Record<string, unknown>} [details] - optional structured facts.
   */
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'SessionDeleteError'
    this.code = code
    this.status = status
    if (details !== undefined) this.details = details
  }
}

/** Session ids currently being deleted by this process. */
const inFlight = new Set()

/**
 * Delete one session tree.
 * @param {object} deps - host services, injected for testability.
 * @param {object} deps.sessions - live Session store.
 * @param {object} deps.persistence - session-persistence service.
 * @param {object} [deps.workspaceRegistry] - Workspace registry.
 * @param {object} [deps.projectionCache] - `session_projcache` table handle.
 * @param {string} [deps.jsonStorageRoot] - JSON backend root, for backup files.
 * @param {object} [deps.schedule] - Schedule service.
 * @param {object} [deps.spillStore] - Local spill backend (`root` property).
 * @param {object} [deps.logger] - Cordis-style logger.
 * @param {string} sessionId - exact session identity.
 * @returns {Promise<{deleted: Array<{id: string, title?: string}>, warnings: Array<{code: string, message: string, path?: string}>}>}
 */
export async function deleteSession(deps, sessionId) {
  assertSessionId(sessionId)
  if (inFlight.has(sessionId)) {
    throw new SessionDeleteError(
      'DELETE_IN_PROGRESS',
      `Session "${sessionId}" is already being deleted.`,
      409,
    )
  }
  inFlight.add(sessionId)
  try {
    return await deleteSessionTree(deps, sessionId)
  } finally {
    inFlight.delete(sessionId)
  }
}

/**
 * Reject ids that cannot be addressed or would only produce confusing errors.
 * @param {unknown} sessionId - candidate identity.
 */
function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 512) {
    throw new SessionDeleteError('INVALID_SESSION_ID', 'A session id must be a non-empty string up to 512 characters.', 400)
  }
  if (sessionId.includes('\0')) {
    throw new SessionDeleteError('INVALID_SESSION_ID', 'A session id cannot contain NUL.', 400)
  }
}

/**
 * @param {object} deps - host services.
 * @param {string} sessionId - root session identity.
 */
async function deleteSessionTree(deps, sessionId) {
  const { sessions, persistence } = deps
  if (sessions === undefined || persistence === undefined) {
    throw new SessionDeleteError(
      'SERVICE_UNAVAILABLE',
      'Session deletion requires both the Session store and session persistence.',
      503,
    )
  }

  const snapshots = await listSnapshots(persistence)
  let rootSnapshot = snapshots.find((snapshot) => snapshot?.header?.id === sessionId)
  if (rootSnapshot === undefined) {
    // `list()` can omit a session whose header is being repaired; `stat()` is
    // the narrower lookup and also covers a created-but-unmaterialized log.
    const observed = await persistence.stat(sessionId).catch((error) => {
      throw wrapStorageError('SESSION_LOOKUP_FAILED', `Could not inspect session "${sessionId}".`, error)
    })
    if (observed === undefined) {
      throw new SessionDeleteError('SESSION_NOT_FOUND', `Session "${sessionId}" was not found.`, 404)
    }
    rootSnapshot = observed
    snapshots.push(observed)
  }

  const targets = collectTargets(rootSnapshot, snapshots)
  const live = targets.filter((snapshot) => sessions.get(snapshot.header.id) !== undefined)
  if (live.length > 0) {
    throw new SessionDeleteError(
      'SESSION_LIVE',
      live.length === 1
        ? `Session "${live[0].header.id}" is open. Open another conversation before deleting it.`
        : `Sessions ${live.map((snapshot) => `"${snapshot.header.id}"`).join(', ')} are open. Open another conversation before deleting them.`,
      409,
      { sessionIds: live.map((snapshot) => snapshot.header.id) },
    )
  }

  const artifacts = []
  for (const snapshot of targets) {
    const directory = await findSessionDirectory(persistence, snapshot.header, snapshot.header.id)
    if (directory === undefined) continue
    await assertDeletableDirectory(directory)
    artifacts.push({ header: snapshot.header, directory })
  }

  const quarantines = await quarantineArtifacts(artifacts)
  const warnings = []

  const schedules = await readSchedules(deps.schedule, warnings)
  for (const snapshot of targets) {
    await cleanSchedules(deps.schedule, schedules, snapshot.header.id, warnings)
    await cleanWorkspace(deps.workspaceRegistry, snapshot.header.id, warnings)
    await cleanProjectionCache(deps, snapshot.header.id, warnings)
    await cleanSpillFiles(deps.spillStore, snapshot.header.id, warnings)
  }

  for (const quarantine of quarantines) {
    try {
      await rm(quarantine.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } catch (error) {
      warnings.push({
        code: 'ARTIFACT_LEAK',
        message: `Session data at "${quarantine.path}" could not be removed: ${errorMessage(error)}`,
        path: quarantine.path,
      })
    }
  }

  for (const warning of warnings) {
    deps.logger?.warn?.(`[dsh-session-delete] ${warning.code}: ${warning.message}`)
  }

  return {
    deleted: targets.map((snapshot) => ({ id: snapshot.header.id })),
    warnings,
  }
}

/**
 * Read the persistence listing, tolerating only the empty-root case.
 * @param {object} persistence - session-persistence service.
 * @returns {Promise<object[]>} snapshots.
 */
async function listSnapshots(persistence) {
  try {
    const listing = await persistence.list()
    return Array.isArray(listing) ? listing : []
  } catch (error) {
    throw wrapStorageError('SESSION_LIST_FAILED', 'Could not list stored sessions.', error)
  }
}

/**
 * The root and every subagent descendant reachable through `parentSession`.
 * Forks are deliberately excluded: a fork is an independent top-level session,
 * even though its header points at the source.
 * @param {object} root - root snapshot.
 * @param {object[]} snapshots - all stored snapshots.
 * @returns {object[]} root first, then descendants.
 */
function collectTargets(root, snapshots) {
  const selected = [root]
  const seen = new Set([root.header.id])
  for (let index = 0; index < selected.length; index += 1) {
    const current = selected[index]
    for (const candidate of snapshots) {
      const header = candidate?.header
      if (header?.origin !== 'subagent' || header.parentSession !== current.header.id) continue
      if (seen.has(header.id)) continue
      seen.add(header.id)
      selected.push(candidate)
    }
  }
  return selected
}

/**
 * Resolve a session's on-disk directory.
 * @param {object} persistence - session-persistence service.
 * @param {object} header - stored session header.
 * @param {string} sessionId - session identity.
 * @returns {Promise<string | undefined>} an existing directory, when materialized.
 */
async function findSessionDirectory(persistence, header, sessionId) {
  const segment = encodeSegment(sessionId)
  const root = persistenceRoot(persistence)
  const candidates = []

  if (typeof persistence.locate === 'function') {
    try {
      const location = persistence.locate(header)
      if (location !== undefined && typeof location.path === 'string' && isAbsolute(location.path)) {
        const directory = resolve(dirname(location.path))
        if (basename(directory) === segment && (root === undefined || isInside(root, directory))) {
          candidates.push(directory)
        }
      }
    } catch {
      // A backend without working diagnostics falls through to the layout scan.
    }
  }

  if (root !== undefined) {
    const conventional = conventionalSessionDir(root, header, sessionId)
    if (isInside(root, conventional)) candidates.push(conventional)

    let projects = []
    try {
      projects = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if (!isMissing(error)) throw wrapStorageError('SESSION_ROOT_UNREADABLE', `Could not read the session root "${root}".`, error)
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const candidate = join(root, project.name, segment)
      if (isInside(root, candidate)) candidates.push(candidate)
    }
  }

  for (const candidate of candidates) {
    try {
      const info = await lstat(candidate)
      if (!info.isDirectory() || info.isSymbolicLink()) continue
      return candidate
    } catch (error) {
      if (isMissing(error)) continue
      throw wrapStorageError('ARTIFACT_UNREADABLE', `Could not inspect session directory "${candidate}".`, error)
    }
  }

  if (root === undefined && candidates.length === 0) {
    throw new SessionDeleteError(
      'PERSISTENCE_ROOT_UNKNOWN',
      'The persistence backend exposes neither a session location nor a root directory, so its files cannot be deleted safely.',
      500,
    )
  }
  return undefined
}

/**
 * Refuse a symlink or a directory whose name does not match the encoded id.
 * @param {string} directory - resolved session directory.
 */
async function assertDeletableDirectory(directory) {
  const info = await lstat(directory)
  if (info.isSymbolicLink()) {
    throw new SessionDeleteError('ARTIFACT_SYMLINK', `Refusing to delete symlinked session directory "${directory}".`, 409)
  }
  if (!info.isDirectory()) {
    throw new SessionDeleteError('ARTIFACT_NOT_DIRECTORY', `Session artifact "${directory}" is not a directory.`, 409)
  }
}

/**
 * Rename every artifact to a hidden sibling before metadata changes.
 * @param {Array<{header: object, directory: string}>} artifacts - resolved directories.
 * @returns {Promise<Array<{path: string, original: string}>>} quarantined paths.
 */
async function quarantineArtifacts(artifacts) {
  const quarantined = []
  try {
    for (const artifact of artifacts) {
      const target = join(
        dirname(artifact.directory),
        `.${basename(artifact.directory)}.dsh-delete-${randomUUID()}`,
      )
      await rename(artifact.directory, target)
      quarantined.push({ path: target, original: artifact.directory })
    }
    return quarantined
  } catch (error) {
    // Put back what this request already moved. Failures here are reported in
    // the thrown error rather than silently losing the location.
    const rollback = []
    for (const item of quarantined.reverse()) {
      try {
        await rename(item.path, item.original)
      } catch (rollbackError) {
        rollback.push(`${item.path}: ${errorMessage(rollbackError)}`)
      }
    }
    const suffix = rollback.length === 0 ? '' : ` Rollback also failed for ${rollback.join('; ')}.`
    throw new SessionDeleteError(
      'ARTIFACT_BUSY',
      `Could not quarantine a session directory: ${errorMessage(error)}.${suffix}`,
      409,
    )
  }
}

/**
 * Read the schedule catalog once; a missing or failing service only disables
 * its cleanup, never the session deletion itself.
 * @param {object | undefined} schedule - Schedule service.
 * @param {object[]} warnings - collected warnings.
 * @returns {Promise<object[]>} tasks, or an empty list.
 */
async function readSchedules(schedule, warnings) {
  if (schedule === undefined || typeof schedule.catalog !== 'function') return []
  try {
    const tasks = await schedule.catalog()
    return Array.isArray(tasks) ? tasks : []
  } catch (error) {
    warnings.push({ code: 'SCHEDULE_READ_FAILED', message: `Scheduled tasks could not be inspected: ${errorMessage(error)}` })
    return []
  }
}

/**
 * Delete every stored task bound to one session.
 * @param {object | undefined} schedule - Schedule service.
 * @param {object[]} tasks - catalog snapshot.
 * @param {string} sessionId - session binding.
 * @param {object[]} warnings - collected warnings.
 */
async function cleanSchedules(schedule, tasks, sessionId, warnings) {
  if (schedule === undefined || typeof schedule.delete !== 'function') return
  for (const task of tasks) {
    if (task?.sessionId !== sessionId || typeof task.id !== 'string') continue
    try {
      await schedule.delete({ sessionId, id: task.id })
    } catch (error) {
      warnings.push({
        code: 'SCHEDULE_DELETE_FAILED',
        message: `Scheduled task "${task.id}" could not be deleted: ${errorMessage(error)}`,
      })
    }
  }
}

/**
 * Remove pin/archive membership and workspace accounting.
 * @param {object | undefined} registry - Workspace registry.
 * @param {string} sessionId - session identity.
 * @param {object[]} warnings - collected warnings.
 */
async function cleanWorkspace(registry, sessionId, warnings) {
  if (registry === undefined) return

  for (const [method, code] of [['unpinSession', 'WORKSPACE_UNPIN_FAILED'], ['unarchiveSession', 'WORKSPACE_UNARCHIVE_FAILED']]) {
    if (typeof registry[method] !== 'function') continue
    try {
      await registry[method](sessionId)
    } catch (error) {
      warnings.push({ code, message: `${method} failed for "${sessionId}": ${errorMessage(error)}` })
    }
  }

  if (typeof registry.list !== 'function') return
  let entities
  try {
    entities = registry.list()
  } catch (error) {
    warnings.push({ code: 'WORKSPACE_LIST_FAILED', message: `Workspaces could not be listed: ${errorMessage(error)}` })
    return
  }
  for (const entity of entities) {
    let sessionIds
    try {
      sessionIds = entity.sessionIds
    } catch (error) {
      warnings.push({ code: 'WORKSPACE_READ_FAILED', message: `Workspace membership could not be read: ${errorMessage(error)}` })
      continue
    }
    if (!Array.isArray(sessionIds) || !sessionIds.includes(sessionId)) continue
    try {
      await entity.detachSession(sessionId)
    } catch (error) {
      warnings.push({ code: 'WORKSPACE_DETACH_FAILED', message: `Workspace membership could not be removed: ${errorMessage(error)}` })
    }
  }
}

/**
 * Delete the persisted projection record and any legacy backup documents.
 * @param {object} deps - host services.
 * @param {string} sessionId - session identity.
 * @param {object[]} warnings - collected warnings.
 */
async function cleanProjectionCache(deps, sessionId, warnings) {
  const table = deps.projectionCache
  if (table !== undefined && typeof table.delete === 'function') {
    try {
      await table.delete(sessionId)
    } catch (error) {
      warnings.push({ code: 'PROJECTION_CACHE_DELETE_FAILED', message: `Projection cache could not be deleted: ${errorMessage(error)}` })
    }
  }

  const root = deps.jsonStorageRoot
  if (typeof root !== 'string' || !isAbsolute(root)) return
  const directory = join(root, 'session_projcache', 'sessions')
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (isMissing(error)) return
    warnings.push({ code: 'PROJECTION_CACHE_READ_FAILED', message: `Projection cache directory could not be read: ${errorMessage(error)}` })
    return
  }

  const primary = `${sessionId}.json`
  const backupPrefix = `${primary}.bak.`
  for (const name of names) {
    const removePrimary = table === undefined && name === primary
    if (!removePrimary && !name.startsWith(backupPrefix)) continue
    try {
      await unlink(join(directory, name))
    } catch (error) {
      if (isMissing(error)) continue
      warnings.push({
        code: 'PROJECTION_CACHE_UNLINK_FAILED',
        message: `Projection cache file "${name}" could not be removed: ${errorMessage(error)}`,
        path: join(directory, name),
      })
    }
  }
}

/**
 * Remove the session-scoped spill directory when the local spill backend is
 * composed. Spill files contain full oversized tool output, so leaving them
 * behind would defeat a permanent delete. The directory name is the backend's
 * stable `sha256(sessionId)` prefix.
 * @param {object | undefined} store - `spillStore` service.
 * @param {string} sessionId - session identity.
 * @param {object[]} warnings - collected warnings.
 */
async function cleanSpillFiles(store, sessionId, warnings) {
  if (store === undefined || typeof store.root !== 'string' || !isAbsolute(store.root)) return
  const directory = join(store.root, `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 12)}`)
  if (!isInside(store.root, directory)) return

  let info
  try {
    info = await lstat(directory)
  } catch (error) {
    if (isMissing(error)) return
    warnings.push({ code: 'SPILL_READ_FAILED', message: `Spill directory could not be inspected: ${errorMessage(error)}` })
    return
  }
  if (info.isSymbolicLink()) {
    warnings.push({ code: 'SPILL_SYMLINK', message: `Refusing to delete symlinked spill directory "${directory}".`, path: directory })
    return
  }
  if (!info.isDirectory()) return

  try {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  } catch (error) {
    warnings.push({ code: 'SPILL_DELETE_FAILED', message: `Spill directory could not be deleted: ${errorMessage(error)}`, path: directory })
  }
}

/**
 * @param {unknown} error - unknown thrown value.
 * @returns {boolean} whether this is an ENOENT-class miss.
 */
function isMissing(error) {
  return error instanceof Error && /** @type {{ code?: string }} */ (error).code === 'ENOENT'
}

/**
 * @param {string} code - stable failure code.
 * @param {string} message - caller-facing message.
 * @param {unknown} error - underlying failure.
 * @returns {SessionDeleteError} wrapped failure.
 */
function wrapStorageError(code, message, error) {
  return new SessionDeleteError(code, `${message} ${errorMessage(error)}`, 500, { cause: errorMessage(error) })
}

/**
 * @param {unknown} error - unknown thrown value.
 * @returns {string} a diagnostic string.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
