# Solo Adventure Engine

A solo fantasy tabletop RPG where **ChatGPT is your Dungeon Master** and this small server keeps it honest:

- **Fair dice.** Every roll uses a cryptographic random generator and shows each die.
- **Rules math.** Modifiers, proficiency, skills, saves, attacks against AC, crits, death saves, rests, XP and levelling (5e 2014 SRD rules).
- **Saved campaigns.** Character sheet, inventory, gold, spell slots, quests, NPCs, combat state, secret DM notes and a journal live in a database. Play on your PC, continue on your phone.
- **Solo balance.** Every fight gets a danger check for a single hero before round 1.

```
You (PC or phone)  ⇄  ChatGPT (the DM, via a plugin)  ⇄  Supabase Edge Function (this repo)  ⇄  Postgres
```

## How it's hosted

- **Supabase Edge Function** `solo-dnd`: always on, with one permanent URL. Nothing runs on your own devices.
- **Supabase Postgres:** tables `campaigns` and `app_config`. Row level security is on with no policies, and public API roles have no privileges, so only the function (using its built-in service key) can read or write them.
- **Hidden from the public.** The only working address is `.../mcp/<secret key>`. Every other path, and any wrong key, returns a bare `404 Not found` with `noindex` headers. There is no web page and nothing to discover.

## Connect ChatGPT (one time)

1. Get your MCP URL:
   `https://<project-ref>.supabase.co/functions/v1/solo-dnd/mcp/<access key>`
   The access key is in Supabase → **Table Editor** → `app_config` → row `access_key`. Treat the whole URL like a password.
2. In ChatGPT open **chatgpt.com/plugins** → **+** → **Add custom MCP server**.
   - **Connection:** Server URL, then paste the MCP URL.
   - **Authentication:** No authentication (the key is in the URL).
   - Tick **I understand and want to continue**, then click **Create**.
3. In any chat, on PC or phone: **+** → enable **Solo Adventure Engine**, then say *"Read the DM guide, then start a new adventure."*

The server gives ChatGPT its DM guide through the `getDmGuide` tool, so there's nothing else to paste.

### Change the secret key

If the URL ever leaks, run this in the Supabase SQL editor, then update the URL in ChatGPT:

```sql
update public.app_config
set value = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
where key = 'access_key';
```

The function caches the key until it restarts, so the old URL can keep working for a while. Redeploy the function to switch to the new key immediately.

## Tools ChatGPT gets

| Area | Tools |
|---|---|
| Setup | `getDmGuide`, `listCampaigns`, `createCampaign`, `getCampaign`, `updateCampaign`, `deleteCampaign` |
| Character | `createCharacter`, `updateCharacter`, `changeHp`, `rest`, `awardXp`, `levelUp`, `manageInventory` |
| Dice | `rollDice` (`1d20+5`, `8d6`, `4d6kh3`, advantage), `makeCheck` (skills, saves, attacks, initiative, death saves) |
| Story | `addQuest`, `updateQuest`, `addNpc`, `updateNpc`, `addJournalEntry`, `getJournal` |
| Combat | `startCombat` (with balance check), `getCombat`, `combatAttack`, `adjustCombatant`, `nextTurn`, `endCombat` |

## Development

```bash
npm install          # test dependency only (MCP client used in tests)
npm test             # engine, tools, storage and a real MCP client against the handler
npm run build:guide  # after editing dm-guide.md
```

Layout:

| Path | What |
|---|---|
| `dm-guide.md` | The Dungeon Master instructions (bundled into the function by `npm run build:guide`) |
| `supabase/functions/solo-dnd/index.ts` | Edge Function entry point |
| `supabase/functions/solo-dnd/core/handler.js` | MCP over HTTP (stateless JSON), routing, hiding |
| `supabase/functions/solo-dnd/core/tools.js` | Tool definitions and handlers |
| `supabase/functions/solo-dnd/core/game.js`, `rules.js`, `dice.js` | Rules engine |
| `supabase/functions/solo-dnd/core/store.js` | Postgres storage via Supabase REST (plus in-memory store for tests) |
| `supabase/migrations/` | Database schema |

The core is plain JavaScript that runs on both Deno (Supabase) and Node (tests).

Deploy with the Supabase CLI: `supabase functions deploy solo-dnd --no-verify-jwt` (the function does its own auth with the secret key).

Rules numbers come from the 5e System Reference Document 5.1 (CC-BY-4.0). This project is not affiliated with or endorsed by Wizards of the Coast.
