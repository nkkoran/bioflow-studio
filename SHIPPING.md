# Shipping BioFlow Studio v0.1.0-beta to your lab

A step-by-step walkthrough for getting builds into lab members' hands this week.

---

## Pre-flight (do once)

### 1. Install build deps

```bash
npm install
```

If native modules complain after Electron upgrades:
```bash
npx @electron/rebuild
```

### 2. Verify the app runs in dev

```bash
npm run dev
```

You should see the canvas, sidebar, and the welcome wizard. **If you see a dark screen**, check the dev tools console — the dark-screen launch bug from the prior session was a CSP misconfiguration that has been fixed (the dev CSP now allows Vite's React Fast Refresh preamble).

### 3. Verify typecheck and tests pass

```bash
npm run typecheck && npm test
```

Both should be green. If anything fails, fix it before packaging.

---

## Step 1 — App icons (already done)

`build/icon.icns`, `build/icon.ico`, `build/icon.png` are in place. If you want to swap in a new logo later: produce a 1024×1024 PNG, then regenerate the platform variants:

```bash
# macOS
mkdir icon.iconset && sips -z 16 16   icon.png --out icon.iconset/icon_16x16.png \
  && sips -z 32 32   icon.png --out icon.iconset/icon_16x16@2x.png \
  && sips -z 32 32   icon.png --out icon.iconset/icon_32x32.png \
  && sips -z 64 64   icon.png --out icon.iconset/icon_32x32@2x.png \
  && sips -z 128 128 icon.png --out icon.iconset/icon_128x128.png \
  && sips -z 256 256 icon.png --out icon.iconset/icon_128x128@2x.png \
  && sips -z 256 256 icon.png --out icon.iconset/icon_256x256.png \
  && sips -z 512 512 icon.png --out icon.iconset/icon_256x256@2x.png \
  && sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png \
  && cp icon.png icon.iconset/icon_512x512@2x.png \
  && iconutil -c icns icon.iconset -o build/icon.icns
# Windows .ico can be generated with ImageMagick: magick convert icon.png -define icon:auto-resize=256,128,64,48,32,16 build/icon.ico
```

---

## Step 2 — Build installers

### macOS (universal — Intel + Apple Silicon, one DMG)

```bash
npm run dist:mac
```
Output: `release/BioFlow Studio-0.1.0-universal.dmg`

### Windows (x64 NSIS, per-user, no UAC)

If you have a Windows machine: `npm run dist:win`.
If you don't, the simplest path is to build via GitHub Actions (see Step 4) — building Windows installers from macOS via electron-builder works but is fragile around native modules.

---

## Step 3 — Smoke-test the DMG locally

1. Open `release/BioFlow Studio-0.1.0-universal.dmg`, drag the app to Applications.
2. **First launch on Apple Silicon will be flagged "damaged"** because the app is unsigned and arm64 enforces notarization. Run:
   ```bash
   xattr -cr "/Applications/BioFlow Studio.app"
   ```
3. **First launch on Intel** will show "unidentified developer" — right-click the app → Open → Open in the dialog. One-time only.
4. Verify: welcome wizard appears, canvas loads, file > new pipeline works, you can SSH to Rorqual, you can drop a file onto the canvas.

If anything is broken in production that isn't in dev, it's almost always one of:
- A path that worked from `app.getAppPath()` in dev but needs `process.resourcesPath` in production.
- A native module that wasn't asar-unpacked.
- A CSP issue (dev allows `'unsafe-inline'`/`'unsafe-eval'`; production does not).

---

## Step 4 — Publish to GitHub Releases

The `electron-builder.yml` is already configured to publish to GitHub.

### One-time setup
1. Make sure your repo (`nkkoran/BioStudio` or whichever) exists on GitHub.
2. Create a personal access token with `repo` scope: https://github.com/settings/tokens
3. Set it locally so `electron-builder` can upload:
   ```bash
   export GH_TOKEN=ghp_yourtokenhere
   ```
4. Decide repo visibility:
   - **Public repo** (simplest): nothing more to do. Lab members can download from the Releases page; auto-update works without auth.
   - **Private repo with public releases**: in GitHub repo settings, you can keep code private but mark the *release* itself public on each release. `electron-updater` reads the public release feed with no token. Safer than baking a token into the binary.

### Each release

Bump `version` in `package.json` (start with `0.1.0-beta.1`), then:

```bash
git tag v0.1.0-beta.1 && git push origin v0.1.0-beta.1
GH_TOKEN=ghp_… npm run dist:mac -- --publish always
# (and from a Windows machine or via Actions:)
GH_TOKEN=ghp_… npm run dist:win -- --publish always
```

This uploads the DMG, EXE, and the `latest-mac.yml` / `latest.yml` update feed files to the release. You then mark the GitHub Release as "published" (not draft) and write quick release notes.

### Optional but recommended: GitHub Actions

Add `.github/workflows/release.yml` so pushing a `v*` tag triggers a Mac + Windows build automatically. A minimal version:

```yaml
name: Release
on:
  push:
    tags: ['v*']
jobs:
  build:
    strategy:
      matrix:
        os: [macos-14, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

---

## Step 5 — Auto-updates

Already wired:
- `electron-updater` is in deps and called from `app.whenReady()` and from the Help → Check for Updates menu.
- Production reads the GitHub release feed; dev does not check.
- Users see a "An update is available, restart to install" notification.

**One gotcha for the first beta:** the auto-update check needs *something to update from*. Publish `v0.1.0-beta.0` first as a tiny "primer" release, then publish `v0.1.0-beta.1` — the updater will see the diff and trigger.

**Windows SmartScreen:** unsigned NSIS installers trigger "Windows protected your PC" on first launch *and on every auto-update install*. Acceptable for a small lab; document the click-through ("More info → Run anyway") in the email.

---

## Step 6 — Tell your lab

Send something like:

> Hi all — beta of BioFlow Studio is up. Download here: <https://github.com/USER/REPO/releases/latest>
>
> **macOS:** open the DMG, drag the app to Applications. On Apple Silicon the app may say "damaged" — open Terminal and run `xattr -cr "/Applications/BioFlow Studio.app"`. On Intel, right-click the app → Open. Both are one-time.
>
> **Windows:** download the .exe, run it. Windows SmartScreen will say "Windows protected your PC" — click "More info → Run anyway".
>
> First launch walks you through picking folders, your Slurm account, and an SSH connection. Once that's done, drag a file onto the canvas to start.
>
> Found a bug? Help menu → Export Bug Report, send me the file.

---

## What got fixed in this audit

**Critical**
- **Dark-screen launch:** dev CSP was `script-src 'self'`, which blocked `@vitejs/plugin-react`'s inline preamble. Now dev allows `'unsafe-inline' 'unsafe-eval'` while production stays strict (`'self'` only). Fix at [electron/main/index.ts:22-46](electron/main/index.ts:22).
- **Missing `dx-applets` in extraResources:** RAP was gated by devMode but the bundled applet directory was excluded from packaging, so unlocking devMode in production would fail to find the applet. Added.

**Verified working**
- `sandbox: true` on the renderer (real security improvement vs. previous `sandbox: false` default).
- CSP via `onHeadersReceived` in main, env-conditional on `app.isPackaged`.
- `will-navigate` and `setWindowOpenHandler` route external links through `shell.openExternal` after URL allowlist.
- Unsigned macOS posture (no ad-hoc signing — wouldn't help with Gatekeeper anyway).
- Per-user NSIS on Windows (no UAC prompt).
- `electron-updater` and `electron-builder` from same major version family.
- `extraResources` for `python-bridge` (ships even when devMode locked, harmless).

**Devmode gate audit (RAP behind PIN 7755)**
- Settings dialog hides the DNAnexus section when locked; "Developer Options" row reveals a PIN modal. Verified at [src/components/settings/SettingsDialog.tsx:95-105](src/components/settings/SettingsDialog.tsx:95).
- `dnxStore.login()`, `refreshProjects()`, `transferToCluster()` all throw "DNAnexus RAP is under development." when devMode is false. Verified at [src/stores/dnxStore.ts:171,190,214](src/stores/dnxStore.ts:171).
- `RemoteFileBrowser` hides the DNX tab when locked. Verified at [src/components/file-browser/RemoteFileBrowser.tsx:313](src/components/file-browser/RemoteFileBrowser.tsx:313).
- `WelcomeWizard` skips the DNAnexus step when locked. Verified at [src/components/onboarding/WelcomeWizard.tsx:28](src/components/onboarding/WelcomeWizard.tsx:28).
- `devMode` is in-memory only (not persisted) — relocks on restart, as required.

**Other implementation notes worth knowing**
- The `WelcomeWizard` "Folders" step writes the picked absolute path into a setting whose default is a relative subfolder name (`scripts`, `outputs`, `logs`). It works in practice (the path goes wherever the user picked) but the semantic mismatch will become confusing once you add per-pipeline overrides. Worth a follow-up cleanup but not a launch blocker.
- The `crashReporter` is started with `uploadToServer: false` — local-only, just useful for capturing native-side crashes if a lab member sends you their userData directory.

---

## How to test the new features (for your own QA before sending it out)

| Feature | How to test |
|---|---|
| **Dev gate (PIN 7755)** | Open Settings → no DNAnexus section visible. Click "Developer Options" → enter `7755` → DNAnexus section appears. Restart app → DNAnexus section gone again, must re-enter PIN. |
| **MergeFilesNode** | Drag two TSV files onto the canvas. Drop a Merge node, connect both files into it. In the inspector, the column-assignment panel should show shared vs. divergent columns and let you pick inner/outer/left. |
| **Folder drag-in → axis split** | Drag a folder containing `chr1.vcf.gz`, `chr2.vcf.gz`, … onto the canvas. A FileNode appears with `split.axis = 'file'` and one item per filename. Connect to a tool — the tool runs as a Slurm array. |
| **Custom node builder** | Sidebar → "+ New Custom Node". Fill in a name, command template like `awk '{{param:expr}}' {{input}} > {{output}}`, save. The custom node appears under Library → Custom and can be added to the canvas like a built-in tool. |
| **Help buttons** | Look for the small `?` icon next to the inspector header, settings section headers, parameter rows, axis-split controls, merge column panel, and onboarding wizard step titles. Click → small inline popover with explanation. |
| **Onboarding wizard** | Wipe `~/Library/Application Support/BioFlow Studio/` (or whatever electron-store is using) to reset `onboardingComplete`, relaunch. Wizard appears, walks through Welcome → Folders → Slurm → SSH → Test → (DNAnexus if dev) → Done. The "Test connection" step actually runs `hostname && squeue --version` and surfaces failures. |
| **Auto-update** | Publish `v0.1.0-beta.0`, install it, then publish `v0.1.0-beta.1`. Help → Check for Updates should detect and prompt to install. |
| **Theme switcher** | Settings → General → Theme dropdown (Dark / Light / Simple). Persists across restarts via `settings:theme` key. |
| **Bug report** | Help → Export Bug Report. Produces a JSON file with redacted state useful for debugging without leaking credentials. |

---

## What is *not* shipping in this beta (deliberately)

- **Code signing / notarization.** Documented workarounds in the email above. Defer until going public.
- **DNAnexus RAP UI.** Locked behind devMode, only you and other developers (with the PIN) see it.
- **Linux build.** Add `target: AppImage` to `electron-builder.yml` if a lab member runs Linux; otherwise leave it out.

---

## If something goes wrong post-release

- **Bad release uploaded:** delete the GitHub release, but **do not delete the tag** if any user has already auto-updated to it — they're stranded. Cut a `beta.N+1` instead.
- **Hotfix pipeline:** every change goes through the same `tag → dist → publish` flow above. Auto-update picks it up within a few minutes of `electron-updater`'s next check.
- **A user is wedged on a bad version:** they can manually download the latest DMG/EXE from the Releases page and reinstall over the top.
