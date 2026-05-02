# OpenSSH ControlPersist Transport for BioFlow

## Summary
Build SSH persistence as an opt-in per-connection transport that lets BioFlow use OpenSSH `ControlPersist` sockets for non-interactive app operations: job submission/polling, remote exec, file browsing, uploads/downloads, and pipeline runtime file writes. Keep the current `ssh2` transport as the default and as the in-app terminal path for v1.

## Key Changes
- Add a connection setting: `transport: 'ssh2' | 'openssh-controlpersist'`, defaulting to `ssh2`; expose it in the connection dialog as “Use OpenSSH ControlPersist for BioFlow operations”.
- Require or create a BioFlow-managed OpenSSH alias/config for persisted connections, using `ControlMaster auto`, `ControlPath ~/.ssh/controlmasters/%C`, `ControlPersist <hours>h`, and the existing keepalive setting.
- Add an OpenSSH transport in main process:
  - On connect, run `ssh -O check <alias>`; if no master exists, start one with `ssh -MNf <alias>`.
  - On disconnect, run `ssh -O exit <alias>`.
  - Use the same IPC surface as today; renderer calls like `ssh.exec` and `sftp.ls` do not change.
- Implement a macOS/Linux GUI askpass bridge:
  - Main starts a temporary loopback askpass endpoint and temp helper script.
  - OpenSSH receives `SSH_ASKPASS`, `SSH_ASKPASS_REQUIRE=force`, and a short-lived token.
  - Prompts route through the existing BioFlow MFA/password dialog.
  - Stored password is used only when `rememberPassword` is enabled; MFA codes are never stored.
- Route persisted non-interactive operations through OpenSSH:
  - `exec`: spawn `ssh <alias> -- <command>` and capture stdout/stderr/exit code.
  - File ops: keep the current `window.api.sftp.*` API, but back it with OpenSSH command/stream operations for persisted connections.
  - Upload/download progress: stream bytes through `ssh` commands and keep existing progress events.
  - Keep existing `ssh2` SFTP/session behavior for non-persisted connections.
- Keep the in-app terminal on `ssh2` for this first pass; persisted connections can still use the generated external `ssh <alias>` terminal path. No `node-pty` dependency in v1.
- Do not silently fall back from an opted-in OpenSSH connection to `ssh2`; show a clear error with guidance to disable OpenSSH persistence if the socket cannot be established.

## Public Interfaces
- Extend `ConnectionConfig`, preload types, validator schema, saved connection data, and `listConnections()` results with `transport`.
- Keep existing `ssh:*` and `sftp:*` IPC method names and renderer-facing return shapes.
- Add debug/status messages that identify whether a connection is using `ssh2` or `openssh-controlpersist`.

## Test Plan
- Unit test OpenSSH arg/config generation, deterministic alias/control settings, and path quoting.
- Unit test askpass prompt classification: remembered password allowed, MFA never stored, timeout/cancel behavior.
- Mock child-process tests for connect/check/start/exit lifecycle and exec stdout/stderr/exit-code handling.
- File operation tests for `ls`, `stat`, `read/head`, `write`, `mkdir`, `rename`, `delete`, upload/download progress, and cache invalidation under the OpenSSH backend.
- Manual QA on macOS/Linux:
  - Existing master socket is reused.
  - No master socket starts via GUI askpass.
  - Password remember opt-in works for password prompt but MFA still prompts.
  - File browser, split detection, run submit, Slurm polling, log view, and SCP/local transfer work over the OpenSSH transport.
  - App reload hydrates persisted connection status; disconnect closes the master socket.

## Assumptions
- First implementation guarantees macOS/Linux; Windows keeps `ssh2` fallback until a PowerShell-compatible askpass bridge is planned.
- OpenSSH persistence is opt-in per connection.
- BioFlow does not store MFA/TOTP codes.
- In-app terminal persistence is deferred; no native PTY dependency is added in this pass.
