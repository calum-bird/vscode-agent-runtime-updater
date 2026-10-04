import type { ExtensionContext } from 'vscode';
import { appendHistory, previousSelection, afterRollback } from '../../shared/history';
import type { SelectionState } from '../../shared/types';
import { createSdkSetting } from '../../vscode/settings';
import type { VSCode } from '../../vscode/types';
import { SDK_SETTING } from './constants';

export interface SettingSnapshot {
  present: boolean;
  value?: string;
}
export type CodexSelectionState = SelectionState<SettingSnapshot>;

function createBinding(vscode: VSCode, context: ExtensionContext) {
  const setting = createSdkSetting(vscode, context.globalStorageUri.fsPath, SDK_SETTING);
  const state = () => context.globalState.get<CodexSelectionState>('management');
  const save = (value: CodexSelectionState) => context.globalState.update('management', value);

  async function select(root: string | undefined, recordHistory = true) {
    const value = setting.inspect()?.globalValue;
    const before = { present: value !== undefined, value };
    const previousState = state() || { original: before, history: [] };
    // Keep the existing recovery record format so installed users retain history.
    await save({ ...previousState, pending: before });
    await setting.write(root);
    const nextState = recordHistory ? appendHistory(previousState, before) : previousState;
    await save({ ...nextState, pending: undefined });
  }

  async function rollback() {
    const previousState = state();
    if (!previousState) return false;
    const previous = previousSelection(previousState);
    if (!previous) return false;
    await select(previous.present ? previous.value : undefined, false);
    await save(afterRollback(previousState));
    return true;
  }

  async function restore() {
    const previousState = state();
    if (!previousState) return false;
    const { original } = previousState;
    await select(original.present ? original.value : undefined);
    return true;
  }

  return { read: setting.read, inspect: setting.inspect, state, select, rollback, restore };
}

export { createBinding };
