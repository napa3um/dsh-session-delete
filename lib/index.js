/**
 * Host half of `dsh-session-delete`.
 *
 * The browser calls the authenticated `/api/session-delete` Fetch route, which
 * lives on the Connection service's owner-only shared channel. That means the
 * same signed browser cookie, Host/Origin fence, and launch-token admission
 * that protect `/api` also protect this destructive operation.
 *
 * @module dsh-session-delete
 */

import { deleteSession, SessionDeleteError } from './delete.js'

export const name = 'dsh-session-delete'

/**
 * Required services. `connection` gates this plugin to browser-facing
 * compositions; the other two are the authoritative session sources.
 */
export const inject = ['connection', 'sessions', 'sessionPersistence']

/** Exact, owner-only Fetch route. */
export const ROUTE_PATH = '/api/session-delete'

/** Bound the JSON envelope before parsing. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Mount the route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export function apply(ctx) {
  ctx.connection.fetch.register({
    path: ROUTE_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleRequest(ctx, request),
  })
}

/**
 * Handle one deletion request.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {Request} request - authenticated request.
 * @returns {Promise<Response>} JSON response.
 */
async function handleRequest(ctx, request) {
  const declaredLength = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json(413, {
      ok: false,
      code: 'BODY_TOO_LARGE',
      message: 'The request body is too large.',
    })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return json(400, {
      ok: false,
      code: 'INVALID_JSON',
      message: 'The request body must be a JSON object.',
    })
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return json(400, {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'The request body must be a JSON object.',
    })
  }
  if (body.action !== 'delete' || body.confirm !== true) {
    return json(400, {
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      message: 'Set action to "delete" and confirm to true to delete a session.',
    })
  }
  if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
    return json(400, {
      ok: false,
      code: 'INVALID_SESSION_ID',
      message: 'A non-empty sessionId is required.',
    })
  }

  let projectionTable
  let jsonStorageRoot
  try {
    const storageDomain = ctx.get('storageDomain')
    projectionTable = storageDomain?.get?.('session_projcache')?.table?.('sessions')
    const jsonBackend = ctx.get('storage.backend.json')
    if (typeof jsonBackend?.root === 'string') jsonStorageRoot = jsonBackend.root
  } catch (error) {
    // Cache cleanup is best-effort; an unavailable or closing domain must not
    // prevent the authoritative log from being deleted.
    ctx.logger?.warn?.(`[dsh-session-delete] cache services unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const result = await deleteSession(
      {
        sessions: ctx.get('sessions'),
        persistence: ctx.get('sessionPersistence'),
        workspaceRegistry: ctx.get('workspaceRegistry'),
        projectionCache: projectionTable,
        jsonStorageRoot,
        schedule: ctx.get('schedule'),
        spillStore: ctx.get('spillStore'),
        logger: ctx.logger,
      },
      body.sessionId,
    )
    await reconcileSearchIndex(ctx)
    return json(200, { ok: true, ...result })
  } catch (error) {
    if (error instanceof SessionDeleteError) {
      return json(error.status, {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      })
    }
    ctx.logger?.error?.(`[dsh-session-delete] unexpected failure: ${error instanceof Error ? error.stack : String(error)}`)
    return json(500, {
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'The session could not be deleted because of an internal error. The host log has the details.',
    })
  }
}

/**
 * Ask a composed full-text search backend to reconcile its derived index.
 *
 * The search seam has no deletion API, but every search starts with one
 * corpus reconciliation and drops rows whose session log is gone. A backend
 * that is disabled or not composed declines immediately; its failure must
 * never turn a committed deletion into an error response.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
async function reconcileSearchIndex(ctx) {
  try {
    const query = ctx.get('sessionQuery')
    if (query === undefined || typeof query.searchSessions !== 'function') return
    await query.searchSessions({ query: 'dsh-session-delete', limit: 1 })
  } catch (error) {
    ctx.logger?.debug?.(`[dsh-session-delete] search index reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * @param {number} status - HTTP status.
 * @param {Record<string, unknown>} payload - JSON payload.
 * @returns {Response} a no-store JSON response.
 */
function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
