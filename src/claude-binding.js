'use strict';

// The Claude loader supports an environment override, but this VS Code build has
// no setting that forwards it. A user LaunchAgent persists the variable at login.
// The variable always points to `current`; subsequent upgrades atomically switch
// that symlink and need only an Agent Host restart.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { ENV } = require('./claude-runtime');
const { withLock } = require('./runtime');
const LABEL = 'local.calumbird.vscode-claude-sdk';

const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function launchAgent(current) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${LABEL}</string>\n<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>${ENV}</string><string>${xml(current)}</string></array>\n<key>RunAtLoad</key><true/>\n</dict></plist>\n`;
}
async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function readOptional(file) {
  try { return await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function readLink(file) {
  try {
    if (!(await fs.lstat(file)).isSymbolicLink()) throw new Error(`Expected a managed symlink at ${file}; refusing to replace other content.`);
    return await fs.readlink(file);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function switchLink(file, target) {
  await readLink(file);
  if (target === null) { await fs.rm(file, { force: true }); return; }
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.symlink(target, temp, 'dir'); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
const system = {
  async getEnv() {
    try { return (await exec('/bin/launchctl', ['getenv', ENV], { timeout: 10_000 })).stdout.trim() || null; }
    catch (error) { if (error.code === 1) return null; throw error; }
  },
  async setEnv(value) { await exec('/bin/launchctl', value === null ? ['unsetenv', ENV] : ['setenv', ENV, value], { timeout: 10_000 }); },
};

function createBinding(storage, { home = os.homedir(), platform = process.platform, systemAPI = system } = {}) {
  if (platform !== 'darwin') throw new Error('Claude runtime activation currently supports macOS. Codex commands remain available on Linux.');
  const current = path.join(storage, 'current');
  const plist = path.join(home, 'Library/LaunchAgents', `${LABEL}.plist`);
  const statePath = path.join(storage, 'selection.json');
  const load = async () => { const text = await readOptional(statePath); return text ? JSON.parse(text) : null; };
  const save = state => atomicWrite(statePath, JSON.stringify(state, null, 2));
  const snapshot = async () => ({ link: await readLink(current), plist: await readOptional(plist), env: await systemAPI.getEnv() });
  async function apply(value) {
    await switchLink(current, value.link);
    if (value.plist === null) await fs.rm(plist, { force: true });
    else await atomicWrite(plist, value.plist);
    await systemAPI.setEnv(value.env);
    if (await systemAPI.getEnv() !== value.env) throw new Error('The Claude SDK environment change was not retained by launchctl.');
  }
  async function transaction(next, nextState, before, previousState) {
    await save({ ...previousState, pending: before });
    try {
      await apply(next);
      await save({ ...nextState, pending: undefined });
    } catch (error) {
      try { await apply(before); await save({ ...previousState, pending: undefined }); }
      catch (restoreError) { throw new Error(`${error.message} Recovery is pending: ${restoreError.message}. Run Claude rollback.`); }
      throw error;
    }
  }
  async function assertOwned(state, before) {
    if (!state && (before.link || before.plist)) throw new Error('Claude updater paths already exist without a saved recovery record. Refusing to overwrite them.');
    if (state && before.plist !== null && before.plist !== launchAgent(current) && before.plist !== state.original.plist) {
      throw new Error('Claude LaunchAgent was edited outside the updater. Restore those changes before proceeding.');
    }
    if (state && before.env !== null && before.env !== current && before.env !== state.original.env) {
      throw new Error('The Claude SDK environment override changed outside the updater. No changes were made.');
    }
  }
  return {
    current, plist, statePath,
    async inspect() { return { ...await snapshot(), state: await load(), current, plistPath: plist }; },
    async select(root) {
      if (!path.isAbsolute(root)) throw new Error('Claude SDK root must be absolute.');
      await fs.access(path.join(root, 'node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'));
      return withLock(storage, async () => {
        const before = await snapshot(), stored = await load();
        await assertOwned(stored, before);
        if (stored?.pending) throw new Error('A previous Claude selection was interrupted. Run Claude rollback first.');
        const state = stored || { original: before, history: [] };
        const next = { link: root, env: current, plist: launchAgent(current) };
        if (before.link === next.link && before.env === next.env && before.plist === next.plist) return;
        await transaction(next, { ...state, history: [...state.history, before].slice(-20) }, before, state);
      });
    },
    async rollback() {
      return withLock(storage, async () => {
        const state = await load();
        const previous = state?.pending || state?.history.at(-1);
        if (!previous) return false;
        const before = await snapshot();
        await assertOwned(state, before);
        await transaction(previous, { ...state, history: state.pending ? state.history : state.history.slice(0, -1) }, before, state);
        return true;
      });
    },
    async restore() {
      return withLock(storage, async () => {
        const state = await load();
        if (!state) return false;
        const before = await snapshot();
        await assertOwned(state, before);
        await transaction(state.original, { ...state, history: [...state.history, before].slice(-20) }, before, state);
        return true;
      });
    },
  };
}
module.exports = { createBinding, launchAgent, switchLink, ENV };
