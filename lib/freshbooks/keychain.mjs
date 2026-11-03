import { spawnSync } from 'node:child_process';

export const SERVICE = 'workbench-freshbooks-timetracking';
export const CLIENT_SECRET = 'client_secret';
export const REFRESH_TOKEN = 'refresh_token';
export const ACCESS_TOKEN = 'access_token';

const NOT_FOUND = 44;

export function systemKeychain({ bin = process.env.WBFT_SECURITY || 'security', service = SERVICE } = {}) {
  const get = (account) => {
    const result = spawnSync(bin, ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`keychain: cannot run ${bin}: ${result.error.message}`);
    if (result.status === NOT_FOUND) return null;
    if (result.status !== 0) throw new Error(`keychain: reading ${account} failed with exit ${result.status}`);
    return result.stdout.replace(/\n$/, '');
  };

  const set = (account, value) => {
    if (typeof value !== 'string' || value === '') throw new Error(`keychain: refusing to save an empty ${account}`);
    const hex = Buffer.from(value, 'utf8').toString('hex');
    const result = spawnSync(bin, ['-i'], {
      input: `add-generic-password -U -s ${service} -a ${account} -X ${hex}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    if (result.error) throw new Error(`keychain: cannot run ${bin}: ${result.error.message}`);
    if (result.status !== 0 || get(account) !== value) throw new Error(`keychain: saving ${account} failed`);
  };

  return { get, set };
}
