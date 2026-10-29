import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { deleteSession } from '../lib/delete.js'
import { encodeSegment, isInside } from '../lib/paths.js'

const WORK = resolve('work', 'demo')
const PROJECT = '--work-demo--'

/**
 * Build a temporary persistence root with one session directory.
 * @param {object} options - fixture options.
 * @returns {Promise<object>} fixture handles.
 */
async function fixture(options = {}) {
  const base = options.base ?? await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  const root = options.root ?? join(base, 'sessions')
  const id = options.id ?? 'session-root'
  const parentId = options.parentId
  const origin = options.origin
  const project = join(root, PROJECT)
  const directory = join(project, encodeSegment(id))
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'session.v4.jsonl.zstd'), 'log-bytes')
  await writeFile(join(directory, 'extra.bin'), 'sidecar')

  const header = {
    version: 4,
    id,
    createdAt: 1,
    cwd: WORK,
    isSeeded: false,
    ...(parentId === undefined ? {} : { parentSession: parentId }),
    ...(origin === undefined ? {} : { origin }),
  }
  return { base, root, project, directory, header, id }
}

/**
 * Assemble a fake persistence service over a fixture list.
 * @param {object[]} fixtures - session fixtures.
 * @returns {object} fake persistence service.
 */
function persistence(fixtures) {
  const snapshots = fixtures.map((item) => ({ header: item.header, sizeBytes: 1, revision: 'r1' }))
  return {
    root: fixtures[0].root,
    async list() {
      return snapshots
    },
    async stat(id) {
      return snapshots.find((snapshot) => snapshot.header.id === id)
    },
    locate(header) {
      const item = fixtures.find((candidate) => candidate.header.id === header.id)
      return item === undefined
        ? undefined
        : { kind: 'jsonl', path: join(item.directory, 'session.v4.jsonl.zstd') }
    },
  }
}

test('deletes the log, cache record, workspace membership, and schedules', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))

  const cacheDeletes = []
  const scheduleDeletes = []
  const workspace = {
    unpinned: [],
    unarchived: [],
    detached: [],
    async unpinSession(id) {
      this.unpinned.push(id)
    },
    async unarchiveSession(id) {
      this.unarchived.push(id)
    },
    list() {
      return [{
        sessionIds: [item.id],
        async detachSession(id) {
          workspace.detached.push(id)
        },
      }]
    },
  }
  const schedule = {
    async catalog() {
      return [
        { id: 'task-1', sessionId: item.id },
        { id: 'task-2', sessionId: 'session-other' },
      ]
    },
    async delete(request) {
      scheduleDeletes.push(request)
    },
  }
  const spillRoot = join(item.base, 'spill')
  const spillDir = join(spillRoot, `session-${createHash('sha256').update(item.id).digest('hex').slice(0, 12)}`)
  await mkdir(spillDir, { recursive: true })
  await writeFile(join(spillDir, 'output.txt'), 'oversized tool output')

  const result = await deleteSession({
    sessions: { get: () => undefined },
    persistence: persistence([item]),
    workspaceRegistry: workspace,
    projectionCache: { async delete(id) { cacheDeletes.push(id) } },
    schedule,
    spillStore: { root: spillRoot },
  }, item.id)

  assert.deepEqual(result.deleted, [{ id: item.id }])
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(cacheDeletes, [item.id])
  assert.deepEqual(scheduleDeletes, [{ sessionId: item.id, id: 'task-1' }])
  assert.deepEqual(workspace.unpinned, [item.id])
  assert.deepEqual(workspace.unarchived, [item.id])
  assert.deepEqual(workspace.detached, [item.id])
  await assert.rejects(access(item.directory), (error) => error.code === 'ENOENT')
  await assert.rejects(access(spillDir), (error) => error.code === 'ENOENT')
  assert.deepEqual(await readdir(item.project), [])
})

test('refuses a live session and leaves every byte in place', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))

  await assert.rejects(
    deleteSession({
      sessions: { get: () => ({ id: item.id }) },
      persistence: persistence([item]),
    }, item.id),
    (error) => {
      assert.equal(error.code, 'SESSION_LIVE')
      assert.equal(error.status, 409)
      return true
    },
  )
  await access(join(item.directory, 'session.v4.jsonl.zstd'))
})

test('returns not found for an unknown session', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))

  await assert.rejects(
    deleteSession({
      sessions: { get: () => undefined },
      persistence: { root: item.root, async list() { return [] }, async stat() { return undefined } },
    }, 'session-missing'),
    (error) => error.code === 'SESSION_NOT_FOUND' && error.status === 404,
  )
})

test('cascades through subagent descendants but not forks', async (t) => {
  const root = await fixture({ id: 'session-root' })
  t.after(() => rm(root.base, { recursive: true, force: true }))
  const child = await fixture({ id: 'session-child', parentId: root.id, origin: 'subagent', base: root.base, root: root.root })
  const grandchild = await fixture({ id: 'session-grandchild', parentId: child.id, origin: 'subagent', base: root.base, root: root.root })
  const fork = await fixture({ id: 'session-fork', parentId: root.id, base: root.base, root: root.root })

  const cacheDeletes = []
  const result = await deleteSession({
    sessions: { get: () => undefined },
    persistence: persistence([root, child, grandchild, fork]),
    projectionCache: { async delete(id) { cacheDeletes.push(id) } },
  }, root.id)

  assert.deepEqual(result.deleted.map((entry) => entry.id), [
    'session-root',
    'session-child',
    'session-grandchild',
  ])
  for (const item of [root, child, grandchild]) {
    await assert.rejects(access(item.directory), (error) => error.code === 'ENOENT')
  }
  await access(join(fork.directory, 'session.v4.jsonl.zstd'))
  assert.deepEqual(cacheDeletes, ['session-root', 'session-child', 'session-grandchild'])
})

test('refuses a live subagent descendant before deleting anything', async (t) => {
  const root = await fixture({ id: 'session-root' })
  t.after(() => rm(root.base, { recursive: true, force: true }))
  const child = await fixture({ id: 'session-child', parentId: root.id, origin: 'subagent', base: root.base, root: root.root })

  await assert.rejects(
    deleteSession({
      sessions: { get: (id) => id === 'session-child' ? { id } : undefined },
      persistence: persistence([root, child]),
    }, root.id),
    (error) => error.code === 'SESSION_LIVE' && error.details.sessionIds.includes('session-child'),
  )
  await access(join(root.directory, 'session.v4.jsonl.zstd'))
  await access(join(child.directory, 'session.v4.jsonl.zstd'))
})

test('removes projection-cache backups when no domain handle is open', async (t) => {
  const item = await fixture()
  t.after(() => rm(item.base, { recursive: true, force: true }))
  const storageRoot = join(item.base, 'storages')
  const cacheDir = join(storageRoot, 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, 'session-root.json'), '{}')
  await writeFile(join(cacheDir, 'session-root.json.bak.202610291200'), '{}')
  await writeFile(join(cacheDir, 'session-other.json'), '{}')

  await deleteSession({
    sessions: { get: () => undefined },
    persistence: persistence([item]),
    jsonStorageRoot: storageRoot,
  }, item.id)

  assert.deepEqual((await readdir(cacheDir)).sort(), ['session-other.json'])
})

test('rejects an unsafe id by encoding it rather than traversing', () => {
  assert.equal(encodeSegment('../../outside'), '..~002F..~002Foutside')
  assert.equal(encodeSegment('a/b\\c:d'), 'a~002Fb~005Cc~003Ad')
  const rootPath = resolve('root')
  assert.equal(isInside(rootPath, join(rootPath, 'a')), true)
  assert.equal(isInside(rootPath, join(rootPath, '..', 'outside')), false)
  assert.equal(isInside(rootPath, resolve('other')), false)
})
