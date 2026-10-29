import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, ROUTE_PATH } from '../lib/index.js'

test('mounts one authenticated POST route and requires explicit confirmation', async () => {
  let route
  const ctx = {
    connection: {
      fetch: {
        register(value) {
          route = value
          return () => {}
        },
      },
    },
    get() {
      return undefined
    },
  }

  apply(ctx)

  assert.equal(route.path, ROUTE_PATH)
  assert.deepEqual(route.methods, ['POST'])
  assert.equal(route.requestBody, 'buffered')

  const response = await route.fetch(new Request('http://127.0.0.1/api/session-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'delete', sessionId: 'session-a' }),
  }))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'CONFIRMATION_REQUIRED')
})

test('rejects malformed JSON without touching session services', async () => {
  let route
  const ctx = {
    connection: { fetch: { register(value) { route = value } } },
    get() {
      throw new Error('services must not be resolved for a malformed request')
    },
  }
  apply(ctx)

  const response = await route.fetch(new Request('http://127.0.0.1/api/session-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  }))
  assert.equal(response.status, 400)
  assert.equal((await response.json()).code, 'INVALID_JSON')
})
