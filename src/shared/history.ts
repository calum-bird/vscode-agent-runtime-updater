import type { SelectionState } from './types';

const HISTORY_LIMIT = 20;

function appendHistory<T>(state: SelectionState<T>, snapshot: T): SelectionState<T> {
  return { ...state, history: [...state.history, snapshot].slice(-HISTORY_LIMIT) };
}

function previousSelection<T>(state: SelectionState<T> | null | undefined): T | undefined {
  return state?.pending || state?.history?.at(-1);
}

function afterRollback<T>(state: SelectionState<T>): SelectionState<T> {
  return {
    ...state,
    pending: undefined,
    history: state.pending ? state.history : state.history.slice(0, -1),
  };
}

export { appendHistory, previousSelection, afterRollback };
