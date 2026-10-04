# VS Code Agent Runtime Updater

Update the Codex and Claude Code runtimes used by VS Code’s **built-in Agents panel**, without waiting for a VS Code release.

The extension downloads official packages, verifies their checksums, tests startup, and lets you roll back. Startup and daily checks notify you when an update is available; updates only install when you run the command.

## Install

Requires VS Code **1.140 or newer** and `tar` on your PATH. Codex supports macOS and Linux (arm64/x64); Claude currently supports macOS only. Tested on macOS arm64 with VS Code 1.140.

Build the extension with Node.js 22.12 or newer:

```sh
git clone https://github.com/calum-bird/vscode-agent-runtime-updater.git
cd vscode-agent-runtime-updater
npm ci --ignore-scripts
npm run package
code --install-extension agent-runtime-updater-0.2.0.vsix
```

You can also install the generated VSIX through **Extensions: Install from VSIX…** in VS Code.

## Update your runtimes

Open the Command Palette (`Cmd+Shift+P` on macOS) and run:

- **Codex Agent Updater: Update to Latest Stable**
- **Claude Agent Updater: Update to Latest Stable**

Once your active chats finish, run the provider’s **Restart Local Agent Host** command. This restarts the shared host across VS Code windows.

**Claude’s first activation requires fully quitting VS Code and reopening it from the Dock or Finder.** Later updates normally need only an agent host restart.

Both providers also offer **Check for Updates**, **Show Status**, and **Roll Back Previous Update**. Logs appear under **Output → Agent Runtime Updater**.

To disable automatic checks, turn off `codexAgentUpdater.checkOnStartup` or `claudeAgentUpdater.checkOnStartup` in Settings.

## How it works

Validated runtimes are stored separately in the extension’s global storage; previous versions remain available for rollback. Codex uses VS Code’s SDK-root setting. Claude uses a macOS login-session environment override, a stable symlink, and a user LaunchAgent that reapplies the override at login.

These are experimental VS Code integration points, so future VS Code or runtime releases may require changes. Use the default local VS Code profile. The extension manages the local built-in Agents host; standalone terminal tools, separate sidebar extensions, and remote hosts have their own runtimes. Model access still depends on your account and provider.

## Restore or uninstall

Run **Codex Agent Updater: Restore Original SDK Setting** and **Claude Agent Updater: Restore Original SDK Environment** for the providers you updated. Fully quit and reopen VS Code before uninstalling the extension.

## Development

```sh
npm test
npm run package
```

Licensed under [MIT](LICENSE).
