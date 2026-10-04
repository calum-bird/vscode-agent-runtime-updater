import type * as vscode from 'vscode';

export type VSCode = typeof vscode;
export type CommandAction = () => unknown | PromiseLike<unknown>;
export type CommandGuard = (action: CommandAction) => PromiseLike<unknown> | unknown;

export interface CommandServices {
  output: vscode.LogOutputChannel;
  guarded: CommandGuard;
  restart: CommandAction;
}

export interface UpdateChecker {
  check(silent?: boolean): Promise<void>;
}
