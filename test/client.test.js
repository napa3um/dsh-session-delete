import assert from 'node:assert/strict'
import test from 'node:test'

test('client bundle registers the row action and overlay against the slot ledger', async () => {
  let definition
  const registrations = []
  const injections = []

  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }

  const react = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    Fragment: Symbol('Fragment'),
  }
  const primitives = {
    MenuItemButton: () => null,
    Modal: () => null,
    Button: () => null,
  }
  const require = (specifier) => {
    if (specifier === 'react') return react
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected external: ${specifier}`)
  }

  await import('../client/client.js')

  assert.equal(definition.id, 'dsh-session-delete')
  const exports = definition.factory(require)
  assert.equal(exports.name, 'dsh-session-delete')
  assert.deepEqual(exports.inject, ['slots', 'sessions', 'locale'])

  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          'session-root': { id: 'session-root', displayTitle: 'Root chat' },
          'session-child': { id: 'session-child', displayTitle: 'Child', origin: 'subagent', parentId: 'session-root' },
          'session-grandchild': { id: 'session-grandchild', displayTitle: 'Grandchild', origin: 'subagent', parentId: 'session-child' },
          'session-fork': { id: 'session-fork', displayTitle: 'Fork', parentId: 'session-root' },
        },
      }),
    },
    handleSessionRemoved: () => {},
    refresh: async () => {},
  }

  const ctx = {
    sessions,
    effect: (callback) => callback(),
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (name, callback) => {
        injections.push(name)
        return callback()
      },
      register: (meta, component) => {
        registrations.push({ meta, component })
        return () => {}
      },
    },
  }

  exports.apply(ctx)

  assert.deepEqual(injections, ['sidebar.workspaces.session.menu.item', 'shell.overlay'])
  assert.equal(registrations[0].meta.name, 'sidebar.workspaces.session.menu.item')
  assert.equal(registrations[0].meta.id, 'session-delete.permanent')
  assert.equal(registrations[0].meta.order, 500)
  assert.equal(registrations[1].meta.name, 'shell.overlay')

  const menuInject = registrations[0].meta.inject()
  menuInject.requestDelete('session-root')

  const overlayInject = registrations[1].meta.inject()
  const request = overlayInject.hooks.request.getSnapshot()
  assert.equal(request.sessionId, 'session-root')
  assert.equal(request.displayTitle, 'Root chat')
  assert.equal(request.subagentCount, 2, 'forks and their children are not subagent descendants')
})
