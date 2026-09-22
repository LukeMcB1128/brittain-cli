'use strict';

// Where API keys live (PLAN.md §3).
//
//   macOS   the login Keychain, through /usr/bin/security
//   Linux   the Secret Service, through secret-tool, when it is on PATH
//   else    credentials.json at 0600 (src/lib/secrets.js), with a plain
//           warning that it is unencrypted
//
// A secret is never put in a process argument: anything in argv is readable by
// every user on the machine through `ps`. `security -i` reads its command from
// stdin and secret-tool reads the secret from stdin, so the value only ever
// crosses a pipe.
//
// Environment variables override whatever is stored, so CI and scripts never
// need the keychain at all.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createSecretStore } = require('../lib/secrets');

const SERVICE = 'brittain-cli';

const ENV_OVERRIDES = Object.freeze({
  brittainApiKey: 'BRITTAIN_API_KEY',
  openaiApiKey: 'OPENAI_API_KEY',
});

function defaultRun(command, args, input) {
  const result = spawnSync(command, args, {
    input: input === undefined ? undefined : String(input),
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return { status: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error };
}

function onPath(binary, env) {
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

// Inside `security -i`, arguments are parsed with shell-like quoting.
function quoteForSecurity(value) {
  return '"' + String(value).replace(/[\\"]/g, (ch) => '\\' + ch) + '"';
}

// A key is one line. A newline would end the `security -i` command early and
// has no business in a credential anyway.
function cleanSecret(value) {
  return String(value || '').replace(/[\r\n]/g, '').trim();
}

function macKeychain(run) {
  const SECURITY = '/usr/bin/security';
  return {
    backend: 'macOS Keychain',
    get(name) {
      const result = run(SECURITY, ['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      return result.status === 0 ? result.stdout.replace(/\n$/, '') : '';
    },
    set(name, value) {
      const command = `add-generic-password -U -s ${quoteForSecurity(SERVICE)} -a ${quoteForSecurity(name)} -w ${quoteForSecurity(value)}\n`;
      const result = run(SECURITY, ['-i'], command);
      // `security -i` reports a failed subcommand on stderr but can still exit 0.
      return result.status === 0 && !/error|fail/i.test(result.stderr);
    },
    remove(name) {
      run(SECURITY, ['delete-generic-password', '-s', SERVICE, '-a', name]);
    },
  };
}

function secretServiceKeychain(run) {
  return {
    backend: 'Secret Service',
    get(name) {
      const result = run('secret-tool', ['lookup', 'service', SERVICE, 'account', name]);
      return result.status === 0 ? result.stdout.replace(/\n$/, '') : '';
    },
    set(name, value) {
      const result = run('secret-tool', ['store', `--label=${SERVICE} ${name}`, 'service', SERVICE, 'account', name], value);
      return result.status === 0;
    },
    remove(name) {
      run('secret-tool', ['clear', 'service', SERVICE, 'account', name]);
    },
  };
}

function detectKeychain({ platform = process.platform, env = process.env, run = defaultRun } = {}) {
  if (env.BRITTAIN_NO_KEYCHAIN) return null;
  if (platform === 'darwin' && fs.existsSync('/usr/bin/security')) return macKeychain(run);
  if (platform === 'linux' && onPath('secret-tool', env)) return secretServiceKeychain(run);
  return null;
}

// The Host's secrets: { get, set, has, remove } plus describe/backend for
// display. `keychain` may be passed explicitly (tests); `null` forces the file
// store.
function createSecrets({ dataDir, env = process.env, keychain, platform, run } = {}) {
  const store = keychain === undefined ? detectKeychain({ platform, env, run }) : keychain;
  const file = createSecretStore({ userDataDir: () => dataDir });

  function envValue(name) {
    const variable = ENV_OVERRIDES[name];
    return variable ? cleanSecret(env[variable]) : '';
  }

  function stored(name) {
    if (store) {
      const value = store.get(name);
      if (value) return value;
    }
    // Keys saved before a keychain was available still work.
    return file.get(name);
  }

  return {
    backend: () => (store ? store.backend : 'file'),

    get(name) {
      return envValue(name) || stored(name);
    },

    has(name) {
      return !!this.get(name);
    },

    set(name, value) {
      const text = cleanSecret(value);
      if (!text) {
        this.remove(name);
        return { ok: true, encrypted: !!store };
      }
      if (store && store.set(name, text)) {
        // A copy left behind in the file store would outlive the keychain one.
        file.remove(name);
        return { ok: true, encrypted: true, backend: store.backend };
      }
      file.set(name, text);
      return {
        ok: true,
        encrypted: false,
        backend: 'file',
        warning: `No keychain is available, so the key was saved unencrypted in ${path.join(dataDir, 'credentials.json')} (readable only by you).`,
      };
    },

    remove(name) {
      if (store) store.remove(name);
      file.remove(name);
    },

    // Never returns the key itself.
    describe(name) {
      const fromEnv = !!envValue(name);
      const value = this.get(name);
      return {
        set: !!value,
        source: fromEnv ? `$${ENV_OVERRIDES[name]}` : value ? (store && store.get(name) ? store.backend : 'file') : '',
        hint: value ? `${value.slice(0, 4)}…${value.slice(-4)}` : '',
      };
    },
  };
}

module.exports = {
  ENV_OVERRIDES,
  SERVICE,
  createSecrets,
  detectKeychain,
  quoteForSecurity,
};
