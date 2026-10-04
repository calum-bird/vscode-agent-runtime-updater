# Agent Runtime Updater (Codex & Claude)

Update the Codex and Claude Code runtimes used by VS Code’s **built-in Agents panel**, without waiting for a VS Code release.

The extension downloads official packages, verifies their checksums, tests startup, and lets you roll back. Startup and daily checks notify you when an update is available; updates only install when you run the command.

## Quick start

Open the Command Palette (`Cmd+Shift+P` on macOS) and run:

- **Codex Agent Updater: Update to Latest Stable**
- **Claude Agent Updater: Update to Latest Stable**

Once your active chats finish, run the provider’s **Restart Local Agent Host** command. This restarts the shared host across VS Code windows.

**Claude’s first activation requires fully quitting VS Code and reopening it from the Dock or Finder.** Later updates normally need only an agent host restart.

Both providers also offer **Check for Updates**, **Show Status**, and **Roll Back Previous Update**. Logs appear under **Output → Agent Runtime Updater**.

To disable automatic checks, turn off `codexAgentUpdater.checkOnStartup` or `claudeAgentUpdater.checkOnStartup` in Settings.

## Compatibility

Requires VS Code **1.140 or newer** and `tar` on your PATH. Codex supports macOS and Linux (arm64/x64); Claude currently supports macOS only. Tested on macOS arm64 with VS Code 1.140.

Use the default local VS Code profile. The extension manages the local built-in Agents host; standalone terminal tools, separate sidebar extensions, and remote hosts have their own runtimes. Model access still depends on your account and provider.

## How it works

Validated runtimes are stored separately in the extension’s global storage; previous versions remain available for rollback. Codex uses VS Code’s SDK-root setting. Claude uses a macOS login-session environment override, a stable symlink, and a user LaunchAgent that reapplies the override at login.

These are experimental VS Code integration points, so future VS Code or runtime releases may require changes.

## Restore or uninstall

Run **Codex Agent Updater: Restore Original SDK Setting** and **Claude Agent Updater: Restore Original SDK Environment** for the providers you updated. Fully quit and reopen VS Code before uninstalling the extension.

## Build and install

To build the extension from source, use Bun and Node.js 22.12 or newer (for the Node test runner):

```sh
git clone https://github.com/calum-bird/vscode-agent-runtime-updater.git
cd vscode-agent-runtime-updater
bun install --frozen-lockfile --ignore-scripts
bun run format:check
bun run typecheck
bun run test
bun run build
code --install-extension agent-runtime-updater-0.2.0.vsix
```

You can also install the generated VSIX through **Extensions: Install from VSIX…** in VS Code. Bun and Node.js are only needed to build and test the extension.

## Finding your way around the code

Start with [extension activation](src/extension.ts), which creates the output channel, registers both providers, and schedules update checks.

| Location                                 | Responsibility                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Codex provider](src/providers/codex/)   | Codex commands, SDK setting selection, package layout, and app-server probe                                    |
| [Claude provider](src/providers/claude/) | Claude commands, saved selection, LaunchAgent, package layout, and SDK probe                                   |
| [Shared helpers](src/shared/)            | Registry downloads, checksums, archive validation, locks, temporary files, installation, versions, and history |
| [VS Code integration](src/vscode/)       | Settings document edits, command registration, notifications, restart, storage discovery, and scheduled checks |
| [Tests](test/)                           | Provider behavior, shared helpers, activation, settings preservation, and command scheduling                   |
| [Terminal tools](tools/)                 | Prepare runtimes independently of extension activation                                                         |

Both provider folders follow the same reading order: `commands.ts` describes user actions, `runtime.ts` downloads and checks runtimes, `binding.ts` records and changes the selected runtime, and `probe.ts` exercises startup. Claude's `launch-agent.ts` contains its macOS environment integration.

An update first installs into a temporary directory. The [shared installer](src/shared/installation.ts) publishes it only after the provider's health check succeeds. The provider binding then selects it and saves recovery history. Installing and selecting are separate operations so a failed download or health check cannot change the active selection.

Codex recovery records remain in VS Code global state; Claude recovery records remain in its storage directory. The refactor preserves those record formats, storage paths, command IDs, and the LaunchAgent label and contents.

All source, tests, and terminal tools are TypeScript. [The TypeScript configuration](tsconfig.json) enables strict checking, including unused declarations, and compiles everything to CommonJS JavaScript under `dist/`. The extension entry point is `dist/src/extension.js`; the VSIX includes the compiled source and source maps, while tests and terminal tools remain development-only.

Run `bun run format` to format source, tests, tools, and project configuration, and `bun run typecheck` to check types without emitting files. `bun run compile` generates JavaScript. `bun run test` compiles first and runs the unit and activation smoke tests using Node. `bun run build` compiles and packages the VSIX automatically.

After compilation, the optional terminal tools are `node dist/tools/prepare.js /absolute/storage` and `node dist/tools/prepare-claude.js /absolute/claude-storage [--select]`. The two VS Code integration runners are compiled under `dist/test/` and require a prepared test window and real runtimes; they are separate from the unit suite.

Licensed under [MIT](LICENSE).
