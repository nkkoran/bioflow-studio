# BioFlow Studio — Packaging & Beta Distribution Checklist

## 1. Overview

Target audience: lab members at McGill (internal use, not public release).
Platforms: macOS (Intel + Apple Silicon, universal binary) and Windows 10/11.
Distribution channel: GitHub Releases on the existing repo.

**Scope decision — DNAnexus RAP integration.** Whether RAP support ships in beta v0.1 is a binary decision that drives onboarding-wizard steps, `extraResources` contents, and the pre-flight checklist. Default recommendation: **include RAP** if Phase 1 of `RAP_Implementation_Plan.md` (Python bridge + auth + file browser) is complete; otherwise gate the UI behind a feature flag and exclude `resources/dx-applets/` from the build. Mark this decision before starting §2.1.

This file is a phased checklist (P0 = blocker for beta, P1 = strong wants, P2 = post-beta). Each section is independently executable in a future Claude Code session.

---

## 2. P0 — Blockers for first beta build

### 2.1 Packaging toolchain

`electron-vite` (build) and `electron-builder` (package) are separate tools — builder does not know about vite's output unless told. The `dist` scripts must chain them, and `electron-builder.yml` must point `files` at vite's `out/` directory. Without this, builder packages source files and produces a broken installer.

**Scripts** (in `package.json`):

```json
"dist":     "electron-vite build && electron-builder",
"dist:mac": "electron-vite build && electron-builder --mac",
"dist:win": "electron-vite build && electron-builder --win"
```

**New `electron-builder.yml`:**

```yaml
appId: com.koran.bioflowstudio       # no hyphens — Windows toolchains dislike them
productName: BioFlow Studio          # must match package.json "name" + index.html <title>
directories:
  buildResources: build
  output: release
files:
  - out/**
  - package.json
  - "!src/**"
  - "!electron/**"
  - "!**/.vscode/**"
asar: true
asarUnpack:
  - "**/node_modules/ssh2/**"
  - "**/node_modules/cpu-features/**"
extraResources:
  - from: resources/python-bridge
    to: python-bridge
  - from: resources/dx-applets       # only if RAP is in-scope for beta
    to: dx-applets
mac:
  target:
    - target: dmg
      arch: [universal]              # universal binary: ~2× size, single download, single update feed entry
nsis:
  oneClick: false
  perMachine: false                  # user-level install, no UAC prompt
  allowToChangeInstallationDirectory: true
```

**Decisions baked in:**
- **Universal macOS binary.** One download link in README, one entry in `latest-mac.yml`, simpler support. Revisit for public release if size becomes an issue.
- **Per-user NSIS install on Windows.** Lab machines often lock down admin rights; per-machine install would trigger UAC.

**Native module rebuild:** `npx @electron/rebuild` after dependency bumps. (Note: the package was renamed from `electron-rebuild`; the old name 404s.)

**Verify post-build:** `ssh2` and `cpu-features` load from the unpacked path; `productName` (yml), `name` (package.json), and `<title>` (index.html) are consistent.

### 2.2 App icons & branding

- Generate `.icns` (mac) and `.ico` (Windows) from a 1024×1024 source PNG.
- Place in `build/icon.{icns,ico,png}`.
- Set `appId: com.koran.bioflowstudio` (reverse-DNS, no hyphen).

### 2.3 Cross-platform fixes

- **macOS-only keychain branch** at [electron/ssh/SshManager.ts:127](electron/ssh/SshManager.ts:127) — `ssh-add --apple-use-keychain` will silently fail on Windows. Wrap in `process.platform === 'darwin'`; on Windows fall back to `ssh-add` without the flag, or no-op if no agent is reachable.
- **Windows path-with-spaces audit.** `app.getPath('userData')` on Windows commonly resolves to `C:\Users\First Last\AppData\Roaming\BioFlow Studio\…`. Anywhere a path is interpolated into a shell string it must be quoted; anywhere a path is passed to `spawn`/`execFile` it must be a discrete `args` array element, never concatenated. Specifically audit:
  - `PythonEnvBootstrap` (RAP plan §1.3) — venv path passed to `python -m venv` and `pip install`.
  - `DnxBridgeManager` subprocess spawn — bridge.py path and venv python path.
  - Any future temp- or log-file path that crosses a shell boundary.
- Test SFTP `resolveHome()` and existing path joins on Windows (Git Bash and cmd.exe environments).
- **Native-module runtime check on clean Windows.** `cpu-features` (transitive via `ssh2`) is a native addon linked against the Visual C++ runtime. On a clean Windows machine without VS or the VC++ redistributable, it can fail to load with no clear error. Verify on a clean VM. If it fails, bundle the VC++ redistributable via `electron-builder.nsis.include` or a `preInstallScript`.

### 2.4 Security hardening

- Run `npm audit`; resolve high/critical findings.
- **Production CSP — set from main process, not `<meta>`.** Drop `'unsafe-inline'` from `script-src` (renderer is bundled, no inline scripts needed). Keep `style-src 'unsafe-inline'` (Tailwind injects styles). Drop `ws://localhost:*` in production.
  Implementation: set CSP in [electron/main/index.ts](electron/main/index.ts) via `session.defaultSession.webRequest.onHeadersReceived` and remove the `<meta http-equiv="Content-Security-Policy">` tag from [index.html](index.html). This works even if `index.html` is tampered with, and lets us branch on `app.isPackaged` to keep the dev policy permissive (Vite HMR over `ws://localhost:*`) while production gets the tightened policy. A Vite HTML-transform plugin is the alternative but offers no security advantage and adds build complexity.
- **Re-enable renderer sandbox.** [electron/main/index.ts:74](electron/main/index.ts:74) currently has `sandbox: false` with no documented reason. Renderer code under `src/` does not import `electron`, `fs`, `child_process`, or other Node APIs (verified). Flip to `sandbox: true` and verify nothing breaks. If something does break, fix that thing rather than re-disabling sandbox. This is a real security improvement.
- Verify `BrowserWindow`: `contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`.
- Audit the preload IPC surface ([electron/preload/index.ts](electron/preload/index.ts)) for handlers that take renderer-supplied paths and feed them to `exec` rather than `execFile`. Confirm the `JobTracker.shellInt()` validation pattern is applied to every shell-bound argument. Pay extra attention to RAP additions if shipped in beta.
- Add `will-navigate` and `setWindowOpenHandler` guards in main; route external links through `shell.openExternal` after URL allowlist check.
- **Threat model:** lab members are trusted. Primary risks are credential leakage (SSH keys, TOTP codes, DNX tokens via `safeStorage`) and malformed cluster responses.

### 2.5 First-run / onboarding wizard

New component `src/components/onboarding/WelcomeWizard.tsx`. Triggered when `settingsStore.onboardingComplete` is false.

Steps:
1. Welcome / what is BioFlow Studio.
2. Pick local folders via `api.dialog.openDirectory`: scripts output, run output, log folder. Persist into existing `settings:paths:*` keys ([SettingsDialog.tsx](src/components/settings/SettingsDialog.tsx)).
3. Pick default Slurm account (text input + "where do I find this?" help link).
4. Add SSH connection (reuse existing connection dialog).
5. **Test connection** — inline button that runs the existing test-connection logic from `SettingsDialog`. On success advance. Provide a **Skip for now** escape hatch. Without this step, misconfigurations only surface later, deep in the canvas, with no clear cause.
6. (If RAP in beta) DNAnexus auth step — call `api.dnx.login` and verify a project list returns. Same Skip semantics.
7. Done — set `onboardingComplete: true`.

Reuse `useSettingsStore`; do not introduce a parallel persistence layer.

### 2.6 README + minimal user install doc

Top-level `README.md`:
- What BioFlow Studio is, who it's for.
- Install: download from Releases, drag to Applications (mac) / run installer (Windows).
- First launch: the wizard walks you through it.
- Where to get help (GitHub Issues / lab Slack).

Document the OS-specific first-launch workarounds:

- **macOS Apple Silicon "damaged app":**
  ```
  xattr -cr "/Applications/BioFlow Studio.app"
  ```
  The app is unsigned for beta. Apple Silicon enforces notarization; this clears the quarantine attribute. Single copy-pastable command.
- **macOS Intel Gatekeeper:** right-click the app → Open → Open in the dialog. One-time only.
- **Windows SmartScreen:** "More info → Run anyway" on first launch *and* on every auto-update install until full code-signing is added.

---

## 3. P1 — Strong wants before broad rollout

### 3.1 Auto-update

Add `electron-updater`. **Update feed strategy** (pick one — do not embed a GitHub token in the binary):

- **Option A (recommended):** keep the repo private but make the **GitHub Release public** (per-release visibility setting). `electron-updater` reads the public release feed with no auth.
- **Option B:** publish `latest-mac.yml` / `latest.yml` + artifacts to a static HTTPS endpoint (S3, GitHub Pages, university web space). `electron-updater` only needs a `feedURL`.
- **Do not** ship a `GH_TOKEN` baked into the app — `strings` on the binary extracts it instantly.

**Version pinning:** `electron-updater` and `electron-builder` co-version. Mixing major versions produces cryptic YAML parse errors at update-check time. Verify with `npm info electron-builder version` and pin both to the same major in `package.json`.

Wire `autoUpdater.checkForUpdatesAndNotify()` after onboarding completes. Add a "Check for updates" menu item.

**macOS signing posture for beta:** ship **unsigned**. Both Intel and Apple Silicon users will see Gatekeeper warnings; both rely on the README workarounds. Ad-hoc signing (`codesign -s -`) does *not* reduce Gatekeeper friction (still flagged as unidentified developer); its only effect is making arm64 binaries launchable without `xattr`. Full Developer ID signing + notarization is deferred to public release.

**Windows signing posture for beta:** unsigned NSIS installers trigger SmartScreen "Windows protected your PC" on first launch *and on every auto-update install*. Acceptable for a small lab; document the click-through. EV cert deferred to public release.

### 3.2 In-app walkthrough / tutorial

Guided tour after onboarding: "Build your first pipeline" — drag a FileNode, drag a PLINK tool, connect, configure, run. Replayable from Help menu.

Library choice: `react-joyride` is the obvious pick, but verify it works under the tightened production CSP from §2.4 — many tour libraries inject inline `<style>` tags (we allow `style-src 'unsafe-inline'`, so that's fine) but if any inject inline `<script>` they will fail (we forbid that). If `react-joyride` doesn't pass, prefer a small custom tour over weakening CSP.

### 3.3 Analysis guides (GWAS, etc.)

New `docs/` directory with markdown guides:
- `docs/gwas-quickstart.md`
- `docs/bcftools-workflow.md`
- `docs/ukb-extract-quickstart.md` (only if RAP in beta)

Link from in-app Help menu via `shell.openExternal`. Each guide: prerequisites (data format), step-by-step pipeline construction, expected outputs, common errors.

### 3.4 Theme system

- Add `theme: 'dark' | 'light' | 'simple'` to `uiStore`.
- Refactor hardcoded color classes (`bg-[#0f1419]`, etc.) to Tailwind theme tokens / CSS custom properties. Tailwind 4's `@theme` directive in global CSS is the cleanest path.
- "Simple mode" reduces palette items and hides advanced inspector tabs — define scope tightly to avoid scope creep.
- Persist choice in settings store.

---

## 4. P2 — Polish / post-beta

- Crash reporting (`crashReporter` to local file, or Sentry if telemetry is acceptable).
- In-app bug report (verify [src/lib/bugReport.ts](src/lib/bugReport.ts) is wired and produces actionable reports).
- Telemetry opt-in for usage stats.
- Localization scaffolding (probably not needed).
- Full code-signing + notarization (Apple Developer ID, Windows EV cert) — only if going public.

---

## 5. Distribution

- Publish builds as GitHub Releases on the existing repo. Tag `v0.1.0-beta.1`.
- **Publish a `v0.1.0-beta.0` dry-run release first** so the auto-update pre-flight check (§6) has something to update *to*. Without a prior release on the feed, `checkForUpdates` succeeds vacuously and tells you nothing.
- Share install instructions via lab Slack/email; link to the Release page.
- Collect feedback in GitHub Issues (template) or a shared doc.

---

## 6. Pre-flight checklist (final gate)

- [ ] `npm run dist` produces a universal `.dmg` (mac) and `.exe` (Windows NSIS, per-user)
- [ ] Both installers launch on a clean machine without dev tools installed
- [ ] First-run wizard appears and completes; **connection-test step actually surfaces a misconfig**
- [ ] Can connect to Rorqual with MFA
- [ ] Can run a trivial PLINK pipeline end-to-end
- [ ] (If RAP in beta) DNX login works, file browser lists projects, a smoke-test UKB extract succeeds, and `resources/python-bridge/bridge.py` is found at runtime via `process.resourcesPath`
- [ ] `xattr -cr` workaround verified on a real Apple Silicon machine
- [ ] Windows install completes without a UAC prompt (per-user NSIS)
- [ ] Auto-update check succeeds against the `v0.1.0-beta.0` dry-run release
- [ ] (If RAP in beta) `safeStorage.isEncryptionAvailable()` returns `true` on macOS and Windows test machines (DPAPI can fail on domain-joined Windows)
- [ ] `npm audit` clean at high/critical
- [ ] Renderer `sandbox: true` shipped without breakage
- [ ] README has correct download links and OS-specific first-launch workarounds

---

## Critical files this work will touch

- `package.json` — electron-builder dep, dist scripts
- `electron-builder.yml` (new)
- `build/icon.{icns,ico,png}` (new)
- [electron/main/index.ts](electron/main/index.ts) — CSP via `onHeadersReceived`, auto-updater hooks, navigation guards, **flip `sandbox: true`**
- [electron/ssh/SshManager.ts](electron/ssh/SshManager.ts) — platform-conditional keychain
- [index.html](index.html) — remove `<meta>` CSP (now set in main)
- [src/stores/settingsStore.ts](src/stores/settingsStore.ts) — `onboardingComplete` flag
- [src/stores/uiStore.ts](src/stores/uiStore.ts) — `theme`
- `src/components/onboarding/WelcomeWizard.tsx` (new)
- `README.md` (new)
- `docs/gwas-quickstart.md`, `docs/bcftools-workflow.md`, `docs/ukb-extract-quickstart.md` (new, P1)
