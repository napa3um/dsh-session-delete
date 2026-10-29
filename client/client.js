window.__ModuleLoader__.load({
  id: 'dsh-session-delete',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = react.createElement

    const NS = 'dsh-session-delete'
    const API_PATH = 'api/session-delete'

    const en = {
      'menu.delete': 'Delete permanently…',
      'dialog.title': 'Delete session permanently?',
      'dialog.body': 'This deletes “{title}” and cannot be undone.',
      'dialog.subagents': 'This also deletes {n} subagent conversation(s) started by this session.',
      'dialog.warning': 'The conversation log, projection cache, workspace membership, pin/archive state, scheduled reminders, and session-scoped spill files are removed.',
      'dialog.note': 'Attachments shared with other sessions are kept. A search index rebuilds itself on its next search.',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete permanently',
      'dialog.pending': 'Deleting…',
      'dialog.close': 'Close',
      'dialog.errorTitle': 'Could not delete the session',
      'success.title': 'Session deleted',
      'success.body': 'Permanently deleted {n} session(s).',
      'success.partial': 'Deleted, but some cleanup steps reported warnings. See the host log for details.',
      'close': 'Close',
    }

    const zh = {
      'menu.delete': '永久删除…',
      'dialog.title': '永久删除会话？',
      'dialog.body': '将永久删除「{title}」，此操作无法撤销。',
      'dialog.subagents': '还会删除该会话创建的 {n} 个子代理会话。',
      'dialog.warning': '会话日志、投影缓存、工作区分组、置顶/归档状态、绑定到该会话的定时任务，以及该会话的溢出文件都会被删除。',
      'dialog.note': '与其他会话共享的附件会保留；搜索索引会在下次搜索时自动重建。',
      'dialog.cancel': '取消',
      'dialog.confirm': '永久删除',
      'dialog.pending': '正在删除…',
      'dialog.close': '关闭',
      'dialog.errorTitle': '无法删除会话',
      'success.title': '会话已删除',
      'success.body': '已永久删除 {n} 个会话。',
      'success.partial': '已删除，但部分清理步骤报告了警告，详情见宿主日志。',
      'close': '关闭',
    }

    /** Minimal observable store; the slot hook contract only needs these two methods. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot() {
          return value
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) {
            try {
              listener()
            } catch (error) {
              console.warn('[dsh-session-delete] listener failed:', error)
            }
          }
        },
      }
    }

    /**
     * Count subagent descendants in the client catalog. This is a display hint
     * only; the Host recomputes the authoritative tree before deleting.
     */
    function countSubagents(byId, rootId) {
      const children = new Map()
      for (const row of Object.values(byId)) {
        if (row?.origin !== 'subagent' || typeof row.parentId !== 'string') continue
        const list = children.get(row.parentId) ?? []
        list.push(row)
        children.set(row.parentId, list)
      }
      const seen = new Set([rootId])
      const queue = [rootId]
      let count = 0
      for (let index = 0; index < queue.length; index += 1) {
        for (const child of children.get(queue[index]) ?? []) {
          if (seen.has(child.id)) continue
          seen.add(child.id)
          queue.push(child.id)
          count += 1
        }
      }
      return count
    }

    /**
     * Menu row: one destructive action after the built-in Copy Session ID row.
     * @param {object} props - slot props plus the injected request callback.
     */
    function DeleteMenuItem({ sessionId, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState()
      return h(
        primitives.MenuItemButton,
        {
          separatorBefore: true,
          onSelect: () => {
            setMenuOpen(false)
            requestDelete(sessionId)
          },
        },
        t('menu.delete'),
      )
    }

    /**
     * Overlay entry: nothing while no request is pending, otherwise one dialog
     * per request keyed by the Session.
     */
    function DeleteDialog({ useRequest, deleteSession, settleDelete, t }) {
      const request = useRequest((value) => value)
      if (request === null) return null
      return h(DeleteForm, {
        key: request.sessionId,
        request,
        deleteSession,
        settleDelete,
        t,
      })
    }

    function DeleteForm({ request, deleteSession, settleDelete, t }) {
      const [busy, setBusy] = react.useState(false)
      const [error, setError] = react.useState(null)
      const [result, setResult] = react.useState(null)

      const close = () => {
        if (busy) return
        settleDelete()
      }

      const confirm = () => {
        setBusy(true)
        setError(null)
        deleteSession(request.sessionId)
          .then((value) => {
            setResult(value)
          })
          .catch((reason) => {
            setError(reason instanceof Error ? reason.message : String(reason))
          })
          .finally(() => {
            setBusy(false)
          })
      }

      if (result !== null) {
        const warnings = Array.isArray(result.warnings) ? result.warnings : []
        return h(primitives.Modal, {
          open: true,
          onClose: close,
          closeLabel: t('close'),
          title: t('success.title'),
          description: t('success.body', { n: result.deleted?.length ?? 1 }),
          footer: h(
            primitives.Button,
            { variant: 'outline', onClick: close },
            t('dialog.close'),
          ),
          children: warnings.length > 0
            ? h('div', { role: 'status' }, t('success.partial'))
            : null,
        })
      }

      return h(primitives.Modal, {
        open: true,
        onClose: close,
        closeLabel: t('dialog.close'),
        title: t('dialog.title'),
        description: t('dialog.body', { title: request.displayTitle }),
        footer: h(
          react.Fragment,
          null,
          h(
            primitives.Button,
            { variant: 'outline', disabled: busy, onClick: close },
            t('dialog.cancel'),
          ),
          h(
            primitives.Button,
            {
              variant: 'outline',
              disabled: busy,
              onClick: confirm,
              style: { color: 'var(--dsh-color-danger, #d84a4a)' },
            },
            busy ? t('dialog.pending') : t('dialog.confirm'),
          ),
        ),
        children: [
          h('p', { key: 'warning' }, t('dialog.warning')),
          request.subagentCount > 0
            ? h('p', { key: 'subagents' }, t('dialog.subagents', { n: request.subagentCount }))
            : null,
          h('p', { key: 'note', style: { opacity: 0.75 } }, t('dialog.note')),
          error === null
            ? null
            : h('div', { key: 'error', role: 'alert', style: { color: 'var(--dsh-color-danger, #d84a4a)' } }, error),
        ],
      })
    }

    /** @param {string} sessionId - target Session. */
    async function postDelete(sessionId) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'delete', sessionId, confirm: true }),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        // The status line below remains the fallback diagnostic.
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.message ?? `Session deletion failed with HTTP ${response.status}.`)
      }
      return payload
    }

    exports.name = 'dsh-session-delete'
    exports.inject = ['slots', 'sessions', 'locale']

    exports.apply = function apply(ctx) {
      ctx.effect(
        () => ctx.locale.register(NS, { en, zh }),
        'dsh-session-delete: dictionaries',
      )

      const deleteRequest = createStore(null)

      const requestDelete = (sessionId) => {
        const snapshot = ctx.sessions.list.getSnapshot()
        const row = snapshot?.byId?.[sessionId]
        deleteRequest.set({
          sessionId,
          displayTitle: row?.displayTitle ?? sessionId,
          subagentCount: countSubagents(snapshot?.byId ?? {}, sessionId),
        })
      }

      const deleteSession = async (sessionId) => {
        const payload = await postDelete(sessionId)
        const deleted = Array.isArray(payload.deleted) ? payload.deleted : []
        for (const item of deleted) {
          if (typeof item?.id !== 'string') continue
          try {
            ctx.sessions.handleSessionRemoved?.(item.id)
          } catch (error) {
            console.warn('[dsh-session-delete] client catalog removal failed:', error)
          }
        }
        try {
          await ctx.sessions.refresh()
        } catch (error) {
          // The Host deletion already committed; a failed list refresh must
          // not be reported as a failed deletion.
          console.warn('[dsh-session-delete] session list refresh failed:', error)
        }
        return payload
      }

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
        ctx.slots.register(
          {
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-delete.permanent',
            order: 500,
            locale: NS,
            inject: () => ({ requestDelete }),
          },
          DeleteMenuItem,
        ),
      )

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register(
          {
            name: 'shell.overlay',
            id: 'session-delete.confirm',
            locale: NS,
            inject: () => ({
              hooks: { request: deleteRequest },
              deleteSession,
              settleDelete: () => deleteRequest.set(null),
            }),
          },
          DeleteDialog,
        ),
      )
    }

    return module.exports
  },
})
