/**
 * Path helpers for the JSONL session layout.
 *
 * These mirror the naming rules of `@deepseek-ai/dsh-session-persistence-jsonl`
 * (MIT) so this plugin can find a session directory even when the persistence
 * backend does not expose a `locate()` helper. The encoding is injective over
 * JavaScript strings, so a caller-supplied session id can never escape the
 * project directory.
 *
 * @module dsh-session-delete/paths
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Encode an arbitrary string as one safe path segment.
 * @param {string} raw - non-empty string to encode.
 * @returns {string} an injective, filesystem-safe path segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new TypeError('cannot encode an empty path segment')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) out += char
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Whether `target` is strictly inside `root` (lexically).
 * @param {string} root - absolute root directory.
 * @param {string} target - absolute candidate path.
 * @returns {boolean} true when target is a descendant of root.
 */
export function isInside(root, target) {
  if (typeof root !== 'string' || typeof target !== 'string') return false
  if (!isAbsolute(root) || !isAbsolute(target)) return false
  const relativePath = relative(resolve(root), resolve(target))
  return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
}

/**
 * Resolve the effective JSONL persistence root.
 * @param {unknown} persistence - the session persistence service.
 * @returns {string | undefined} an absolute root, when one is known.
 */
export function persistenceRoot(persistence) {
  const configured = persistence?.root
  if (typeof configured === 'string' && isAbsolute(configured)) return resolve(configured)
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home.length > 0) return join(resolve(home), 'sessions')
  return undefined
}

/**
 * Compute the conventional session directory for a header.
 * @param {string} root - absolute persistence root.
 * @param {{ cwd?: string }} header - stored session header.
 * @param {string} sessionId - session identity.
 * @returns {string} the expected session directory.
 */
export function conventionalSessionDir(root, header, sessionId) {
  const segment = encodeSegment(sessionId)
  if (header?.cwd === undefined) return join(root, '_no-cwd', segment)
  return join(root, projectKey(header.cwd), segment)
}

/**
 * Encode a working directory into the readable project-directory key.
 * @param {string} cwd - absolute session working directory.
 * @returns {string} a project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new TypeError('cannot encode an empty project path')
  }
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const char = String.fromCharCode(code)
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/.test(char)) {
      readable += char
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}
