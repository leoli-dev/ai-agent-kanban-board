import fs from 'node:fs';
import path from 'node:path';

const SECRET_REF = /\$\{SECRET:([A-Za-z0-9_]+)\}/g;

/**
 * API keys live in data/secrets.json (chmod 600), never in SQLite.
 * Profile env values reference them as ${SECRET:NAME}; unresolved names fall
 * back to process.env so existing shell exports (e.g. DEEPSEEK_API_KEY) work.
 */
export class SecretStore {
  constructor(private filePath: string) {}

  read(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  names(): string[] {
    return Object.keys(this.read());
  }

  set(name: string, value: string): void {
    const all = this.read();
    all[name] = value;
    this.write(all);
  }

  delete(name: string): void {
    const all = this.read();
    delete all[name];
    this.write(all);
  }

  resolveEnv(env: Record<string, string>): Record<string, string> {
    const secrets = this.read();
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      out[key] = value.replace(SECRET_REF, (_, name: string) => {
        const resolved = secrets[name] ?? process.env[name];
        if (resolved === undefined) {
          throw new Error(`Secret "${name}" is not set (secrets.json or environment)`);
        }
        return resolved;
      });
    }
    return out;
  }

  private write(all: Record<string, string>): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(all, null, 2), { mode: 0o600 });
  }
}
