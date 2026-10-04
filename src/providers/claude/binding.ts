import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorMessage } from '../../shared/errors';
import { atomicWrite, readOptional, readLink, switchLink, withLock } from '../../shared/files';
import { appendHistory, previousSelection, afterRollback } from '../../shared/history';
import type { SelectionState } from '../../shared/types';
import { LABEL, launchAgent, system } from './launch-agent';

export interface SelectionSnapshot {
  link: string | null;
  plist: string | null;
  env: string | null;
}
export type ClaudeSelectionState = SelectionState<SelectionSnapshot>;
export interface EnvironmentAPI {
  getEnv(): Promise<string | null>;
  setEnv(value: string | null): Promise<void>;
}
interface BindingOptions {
  home?: string;
  platform?: string;
  systemAPI?: EnvironmentAPI;
}
// The symlink selects a version; launchctl and the login agent select that symlink.
// Snapshot all three before a change so rollback can restore them together.

function sameSelection(left: SelectionSnapshot, right: SelectionSnapshot) {
  return left.link === right.link && left.env === right.env && left.plist === right.plist;
}

function createBinding(
  storage: string,
  { home = os.homedir(), platform = process.platform, systemAPI = system }: BindingOptions = {}
) {
  if (platform !== 'darwin') {
    throw new Error(
      'Claude runtime activation currently supports macOS. Codex commands remain available on Linux.'
    );
  }
  const current = path.join(storage, 'current');
  const plist = path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
  const statePath = path.join(storage, 'selection.json');
  const managedPlist = launchAgent(current);

  async function load(): Promise<ClaudeSelectionState | null> {
    const text = await readOptional(statePath);
    return text ? (JSON.parse(text) as ClaudeSelectionState) : null;
  }

  function save(state: ClaudeSelectionState) {
    return atomicWrite(statePath, JSON.stringify(state, null, 2));
  }

  async function snapshot() {
    return {
      link: await readLink(current),
      plist: await readOptional(plist),
      env: await systemAPI.getEnv(),
    };
  }

  async function apply(value: SelectionSnapshot) {
    await switchLink(current, value.link);
    if (value.plist === null) {
      await fs.rm(plist, { force: true });
    } else {
      await atomicWrite(plist, value.plist);
    }
    await systemAPI.setEnv(value.env);
    if ((await systemAPI.getEnv()) !== value.env) {
      throw new Error('The Claude SDK environment change was not retained by launchctl.');
    }
  }

  async function transaction(
    next: SelectionSnapshot,
    nextState: ClaudeSelectionState,
    before: SelectionSnapshot,
    previousState: ClaudeSelectionState
  ) {
    // Journal the recovery point before changing any external state. If recovery
    // also fails, leave the journal intact for a later rollback.
    await save({ ...previousState, pending: before });
    try {
      await apply(next);
      await save({ ...nextState, pending: undefined });
    } catch (error) {
      try {
        await apply(before);
        await save({ ...previousState, pending: undefined });
      } catch (restoreError) {
        throw new Error(
          `${errorMessage(error)} Recovery is pending: ${errorMessage(restoreError)}. Run Claude rollback.`
        );
      }
      throw error;
    }
  }

  function assertOwned(state: ClaudeSelectionState | null, before: SelectionSnapshot) {
    if (!state && (before.link || before.plist)) {
      throw new Error(
        'Claude updater paths already exist without a saved recovery record. Refusing to overwrite them.'
      );
    }
    if (
      state &&
      before.plist !== null &&
      before.plist !== managedPlist &&
      before.plist !== state.original.plist
    ) {
      throw new Error(
        'Claude LaunchAgent was edited outside the updater. Restore those changes before proceeding.'
      );
    }
    if (
      state &&
      before.env !== null &&
      before.env !== current &&
      before.env !== state.original.env
    ) {
      throw new Error(
        'The Claude SDK environment override changed outside the updater. No changes were made.'
      );
    }
  }

  async function readOwnedSelection() {
    const before = await snapshot();
    const state = await load();
    assertOwned(state, before);
    return { before, state };
  }

  return {
    current,
    plist,
    statePath,
    async inspect() {
      return { ...(await snapshot()), state: await load(), current, plistPath: plist };
    },
    async select(root: string) {
      if (!path.isAbsolute(root)) throw new Error('Claude SDK root must be absolute.');
      await fs.access(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
      return withLock(storage, async () => {
        const { before, state: stored } = await readOwnedSelection();
        if (stored?.pending) {
          throw new Error(
            'A previous Claude selection was interrupted. Run Claude rollback first.'
          );
        }
        const state = stored || { original: before, history: [] };
        const next = { link: root, env: current, plist: managedPlist };
        if (sameSelection(before, next)) return;
        await transaction(next, appendHistory(state, before), before, state);
      });
    },
    async rollback() {
      return withLock(storage, async () => {
        const state = await load();
        if (!state) return false;
        const previous = previousSelection(state);
        if (!previous) return false;
        const before = await snapshot();
        assertOwned(state, before);
        await transaction(previous, afterRollback(state), before, state);
        return true;
      });
    },
    async restore() {
      return withLock(storage, async () => {
        const state = await load();
        if (!state) return false;
        const before = await snapshot();
        assertOwned(state, before);
        await transaction(state.original, appendHistory(state, before), before, state);
        return true;
      });
    },
  };
}

export { createBinding };
