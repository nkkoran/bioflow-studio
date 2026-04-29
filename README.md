# BioFlow Studio

BioFlow Studio is an Electron + React desktop app for building and running bioinformatics pipelines on Slurm clusters over SSH. It is currently packaged for internal McGill lab beta testing.

## Install

Download the latest beta from GitHub Releases.

- macOS: download the `.dmg`, drag BioFlow Studio to Applications, then launch it.
- Windows: download the NSIS `.exe` installer and install for your user account.

The first launch opens a setup wizard for run folders, Slurm account, and SSH connection checks.

## First-Launch Workarounds

The beta is unsigned.

Apple Silicon macOS may report that the app is damaged:

```bash
xattr -cr "/Applications/BioFlow Studio.app"
```

Intel macOS may require: right-click BioFlow Studio, choose Open, then Open again in the dialog.

Windows SmartScreen may require: More info, then Run anyway. This can happen again after auto-update installs until full code signing is added.

## Help

Use the Help menu for the walkthrough and workflow guides. For support, use GitHub Issues or the lab Slack.
