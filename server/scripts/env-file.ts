import fs from 'node:fs';
import path from 'node:path';
import { ENV_PATH } from '../src/config.ts';

/** Set NAME=value in the repo-root .env, replacing an existing line or appending one. */
export function upsertEnv(name: string, value: string): void {
  const text = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, 'm');
  const next = re.test(text) ? text.replace(re, line) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  fs.writeFileSync(ENV_PATH, next);
}

/** Paths given on the command line are relative to where `npm run` was invoked, not to server/. */
export const fromInvocationDir = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

/** The https URL of the ngrok tunnel pointing at our port, from ngrok's local API. */
export async function ngrokPublicUrl(port: number): Promise<string | null> {
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(2000) });
    const json = (await res.json()) as { tunnels?: { public_url: string; config?: { addr?: string } }[] };
    const tunnel = (json.tunnels ?? []).find((t) => t.public_url.startsWith('https://') && String(t.config?.addr ?? '').endsWith(`:${port}`));
    return tunnel?.public_url ?? null;
  } catch {
    return null;
  }
}

export function die(message: string): never {
  console.error(message);
  process.exit(1);
}
