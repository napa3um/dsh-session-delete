# dsh-session-delete

Permanently delete a **DeepSeek Harness (DSH)** session from the Web UI — not just
hide or archive it.

The plugin adds **Delete permanently…** to every session row's `...` menu. A
confirmation dialog names the conversation and explains exactly what will be
removed. There is no undo.

> **This is a destructive plugin.** It runs inside the DSH host process and
> removes files under your DSH data directory. Read the scope below before
> installing it.

## What it deletes

For the selected session:

| Data | What happens |
| --- | --- |
| Session log | Every format generation under `sessions/<project>/<session-id>/` is removed. |
| Subagent descendants | Child sessions with `origin: "subagent"` are deleted recursively. Forks are **not** descendants and are kept. |
| Projection cache | The `session_projcache` record and any `.bak.*` files are removed. |
| Workspace membership | The session is detached from its Workspace; the stale row disappears. |
| Pin / archive state | The session is unpinned and unarchived before detaching. |
| Scheduled tasks | Every schedule task bound to the session (active or inactive) is deleted. |
| Spill files | The local spill backend's `session-<hash>` directory (oversized tool output) is removed. |
| Search index | A composed full-text backend is asked to reconcile once, which drops the deleted session's rows. |

A session that is currently **open** is refused. DSH keeps its Agent and log
handle alive; deleting the file underneath it would corrupt the conversation or
let it reappear. Open another conversation, then delete the old one.

## What it deliberately keeps

These are shared, derived, or out of scope for a per-session delete:

- **Attachments** under `<DSH_HOME>/attachments` are content-addressed and may be
  referenced by other sessions, so this plugin does not touch them.
- **Browser-local ordering / drafts** stored by the sidebar are not host data.
  Stale ids are ignored by the UI after the session list refreshes.
- **External copies** already uploaded to a model provider, exported manually, or
  captured by telemetry are outside the host's local store.

## Requirements

- DSH `>= 0.2.1-rc.3` (Web profile)
- No build step and no runtime dependencies. The client half is a prebuilt
  Module Loader bundle.

## Install

### From the DSH UI

Open **Plugins → Install**, paste the GitHub repository URL, and enable
**Session Delete**. Restart if your profile does not use HMR.

### From the CLI

```sh
dsh plugin add github:Sartherland/dsh-session-delete
```

Then enable the `dsh-session-delete` bundle in the Plugins page and restart if
needed. For a local checkout:

```sh
dsh plugin add link:/absolute/path/to/dsh-session-delete
```

### Manual profile entry

If you manage `~/.dsh/profiles/<profile>/package.json` yourself, add the package
to `dependencies` and its name to `dsh.profile.bundles`:

```json
{
  "dependencies": {
    "dsh-session-delete": "github:Sartherland/dsh-session-delete"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-session-delete"
      ]
    }
  }
}
```

The bundle patch is [`cordis.patch.yml`](cordis.patch.yml) and adds the host row
`session-delete`.

## Use

1. Open the sidebar's session list.
2. Hover a session and click `...`.
3. Choose **Delete permanently…**.
4. Read the confirmation; choose **Delete permanently**.

The action is hidden while the row's menu is unavailable. If the Host refuses
because the session is open, the dialog shows the reason and changes nothing.

## How deletion stays safe

1. **Preflight** — the host resolves the session and every subagent descendant,
   checks that none is live, rejects symlinked session directories, and verifies
   the path is inside the persistence root.
2. **Quarantine** — each session directory is renamed to a hidden sibling. This
   is the crash-safe point: the session disappears from discovery before any
   metadata is rewritten, and a failed rename rolls back the directories it
   already moved.
3. **Metadata cleanup** — workspace membership, pin/archive sets, projection
   cache, schedules, and session-scoped spill files are removed. Failures are
   collected as warnings instead of leaving the log in place.
4. **Purge** — quarantined directories are recursively removed. If the OS still
   holds a file open, the warning names the leftover path so it can be removed
   manually.

The HTTP route is `/api/session-delete`, registered on DSH's authenticated
owner-only Fetch channel. It inherits the browser cookie, Host/Origin fence, and
launch-token admission of the normal `/api` transport — there is no separate
unauthenticated port or secret to configure.

## Development

```sh
npm test       # node --test
npm run check  # syntax-check host + client bundles
```

The host half has no dependencies and the client half is loaded by DSH's Module
Loader (`window.__ModuleLoader__`) with `react` and
`@deepseek-ai/dsh-client-ui-primitives` supplied by the host.

Project layout:

```text
lib/index.js        authenticated Fetch route
lib/delete.js       staged deletion and metadata cleanup
lib/paths.js        JSONL layout path encoding
client/client.js    session-row menu item + confirmation dialog
test/delete.test.js host-side deletion tests
```

## 中文说明

在 DSH Web 侧边栏的会话菜单中加入 **永久删除…**。确认后会删除：

- 会话日志（所有格式版本）；
- 该会话创建的子代理会话（递归），但保留手动 fork 出来的会话；
- 投影缓存及其 `.bak.*` 备份；
- 工作区归属、置顶/归档记录；
- 绑定到该会话的定时任务；
- 本地溢出文件（spill，超出长度限制的工具输出）；
- 如果启用了全文搜索，还会触发一次索引对账，清掉已删除会话的索引行。

当前打开的会话会被拒绝删除；请先切换到其他会话。附件是内容寻址且可能被其他
会话共享，不会删除。

安装：

```sh
dsh plugin add github:Sartherland/dsh-session-delete
```

然后在 **插件** 页面启用并重启（若未启用 HMR）。

## License

[MIT](LICENSE)
