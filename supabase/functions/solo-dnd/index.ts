// Supabase Edge Function entry point for the Solo Adventure Engine.
// Deployed with JWT verification OFF: this function does its own auth via the secret key in the URL.
import { createHandler } from './core/handler.js';
import { SupabaseStore } from './core/store.js';
import { GitHub } from './core/mirror.js';

function serviceKey(): string | undefined {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  // Newer projects may expose secret keys as JSON: {"default": "sb_secret_..."}.
  const secrets = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (secrets) {
    try {
      const parsed = JSON.parse(secrets);
      return typeof parsed === 'string' ? parsed : Object.values(parsed)[0] as string;
    } catch {
      return secrets;
    }
  }
  return undefined;
}

const store = new SupabaseStore({ url: Deno.env.get('SUPABASE_URL')!, serviceKey: serviceKey()! });
const githubToken = Deno.env.get('GITHUB_TOKEN');
const github = githubToken ? new GitHub({ token: githubToken }) : null;
const handle = createHandler({
  store,
  github,
  getAccessKey: () => store.getAccessKey(),
  log: (line: string) => console.log(line),
});

Deno.serve(handle);
