import { errorCode } from '../../shared/errors';
import { exec } from '../../shared/process';
import type { EnvironmentAPI } from './binding';
import { ENV } from './constants';

const LABEL = 'local.calumbird.vscode-claude-sdk';
const LAUNCHCTL_TIMEOUT = 10_000;

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function launchAgent(current: string): string {
  // Keep the serialized format stable: ownership checks compare this exact text.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/launchctl</string><string>setenv</string><string>${ENV}</string><string>${escapeXml(current)}</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
}

const system: EnvironmentAPI = {
  async getEnv() {
    try {
      const { stdout } = await exec('/bin/launchctl', ['getenv', ENV], {
        timeout: LAUNCHCTL_TIMEOUT,
      });
      return stdout.trim() || null;
    } catch (error) {
      if (errorCode(error) === 1) return null;
      throw error;
    }
  },
  async setEnv(value) {
    const args = value === null ? ['unsetenv', ENV] : ['setenv', ENV, value];
    await exec('/bin/launchctl', args, { timeout: LAUNCHCTL_TIMEOUT });
  },
};

export { LABEL, launchAgent, system };
