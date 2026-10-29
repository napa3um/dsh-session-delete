# Security

`dsh-session-delete` performs irreversible filesystem deletion inside the DSH
host process. Treat it like any other host plugin: install only from a source
you trust, and review the code before enabling it.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository (Security → Advisories)
rather than a public issue. Include the DSH version, plugin version, and a
minimal reproduction. Do not include real session logs or credentials.

## Relevant design properties

- The HTTP endpoint is registered on DSH's authenticated owner-only Fetch
  channel (`/api/session-delete`); it does not open a second listener.
- The route requires `{ "action": "delete", "confirm": true }` and a non-empty
  session id.
- Session directories are resolved from the persistence backend, checked against
  the encoded id and persistence root, and refused when they are symlinks.
- Live sessions are refused before any file is moved.
- Deletes are serialized per session id within one host process.
