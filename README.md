# Solo Adventure Engine

A small server that turns a **ChatGPT Custom GPT** into a solo Dungeon Master for 5th-edition-style fantasy adventures.

ChatGPT does the storytelling. This server does what ChatGPT is bad at:

- **Fair dice.** Every roll uses a cryptographic random number generator and shows each die. No made-up "you rolled a 20!".
- **Rules math.** Ability modifiers, proficiency, skills, saves, AC vs. attack rolls, crits, death saves, temp HP, rests, XP and levelling.
- **Memory between chats.** Your character sheet, inventory, gold, quests, NPCs, combat state, DM secrets and an adventure journal are saved, so you can start a new chat next week and carry on.
- **Combat tracking.** Initiative order, enemy HP, conditions, turns and XP awards.

```
You  ⇄  ChatGPT (your Custom GPT = the DM)  ⇄  Solo Adventure Engine (this server)
```

---

## Setup (about 15 minutes)

You need: a paid ChatGPT plan that can create GPTs (Plus, Pro, Team…), and somewhere to host this server with a public `https://` URL.

### 1. Deploy the server

Pick one. Each option stores campaigns in a file on a persistent disk.

**Option A: Render (easiest, about $7/month)**
1. Push this repo to your GitHub (it's already there if you're reading this on GitHub).
2. On [render.com](https://render.com): **New → Blueprint** → choose this repo. `render.yaml` sets everything up, including a disk and a random `API_KEY`.
3. When it's live, open the service's **Environment** tab and copy the `API_KEY` value. Your URL looks like `https://solo-adventure-engine-xxxx.onrender.com`.

**Option B: Railway / Fly.io / any Docker host**
1. Deploy using the included `Dockerfile`.
2. Attach a persistent volume mounted at `/data`.
3. Set the environment variable `API_KEY` to a long random string. You can make one with `openssl rand -hex 32`.

**Option C: run it on your Android phone (free)**

ChatGPT's servers call your game server, so even on a phone it needs a public address. The script below creates one for free with a Cloudflare tunnel.

1. Install **Termux** from [F-Droid](https://f-droid.org/packages/com.termux/). The Play Store version is outdated.
2. Open Termux and run (first time only):
   ```bash
   pkg update && pkg install nodejs git cloudflared
   git clone https://github.com/robertsc2049-bit/d-d.git
   cd d-d && git checkout ccr-6e1515b1-jcomii
   ```
   If the repo is private, git asks for a username and password. Use your GitHub username and a [personal access token](https://github.com/settings/tokens) as the password.
3. Every time you want to play:
   ```bash
   cd d-d && bash scripts/termux-start.sh
   ```
   It prints the **Action import URL** and **API key** to paste into ChatGPT (step 2 below). The key stays the same between runs.
4. Keep Termux open while you play. In Android Settings → Apps → Termux → Battery, choose **Unrestricted** so Android doesn't kill it.

Your campaigns are saved on the phone in `d-d/data/`. The free tunnel gets a **new address each time you start it**. When the script says the address changed, open your GPT → Configure → Actions → **Import from URL** with the new link and click **Update**. (A free ngrok account gives one fixed address if you'd rather avoid this.)

**Option D: run it on your own computer (for trying it out)**
```bash
npm install
API_KEY=pick-a-long-secret npm start
```
ChatGPT can't reach `localhost`, so you also need a tunnel such as `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`. Use the `https://` address it prints.

Check it works: open `https://YOUR-URL/health`. It should show `{"ok":true}`.

> Optional: set `PUBLIC_URL=https://YOUR-URL` if the spec in the next step shows the wrong address.

### 2. Create the Custom GPT

1. In ChatGPT go to **Explore GPTs → Create → Configure**.
2. **Name:** e.g. "Solo Dungeon Master". **Description:** "Runs solo fantasy adventures with real dice and a saved campaign."
3. **Instructions:** paste the whole contents of [`gpt/instructions.md`](gpt/instructions.md).
4. **Conversation starters** (suggestions):
   - `Continue my campaign`
   - `Start a new adventure — surprise me`
   - `Help me create a character`
   - `Show my character sheet and quests`
5. **Capabilities:** turning on *Image Generation* is fun for scene art. *Web Search* isn't needed.
6. **Actions → Create new action:**
   - Click **Import from URL** and enter `https://YOUR-URL/openapi.json`.
   - **Authentication → API Key → Auth Type: Bearer**, and paste your `API_KEY`.
   - **Privacy policy:** `https://YOUR-URL/privacy`
7. Click **Create** and choose who can see the GPT. **Only me** is recommended.

### 3. Play

Open your GPT and say *"Start a new adventure"*. The first time it calls the server, ChatGPT asks for permission. Choose **Always allow** so it doesn't ask before every dice roll. (Deleting a campaign still asks for confirmation.)

---

## What the GPT can do (Actions)

| Area | Actions |
|---|---|
| Campaigns | `listCampaigns`, `createCampaign`, `getCampaign`, `updateCampaign`, `deleteCampaign` |
| Character | `createCharacter`, `updateCharacter`, `changeHp`, `rest`, `awardXp`, `levelUp`, `manageInventory` |
| Dice & checks | `rollDice` (any expression: `1d20+5`, `8d6`, `4d6kh3`, advantage), `makeCheck` (skills, saves, attacks, initiative, death saves) |
| Story memory | `addQuest`, `updateQuest`, `addNpc`, `updateNpc`, `addJournalEntry`, `getJournal` |
| Combat | `startCombat`, `getCombat`, `combatAttack`, `adjustCombatant`, `nextTurn`, `endCombat` |

That's 26 actions, under ChatGPT's limit of 30. The full spec is served at `/openapi.json`.

## Tips for a good solo game

- Say **"recap"** at the start of a session to get a "previously on…" summary.
- Ask the DM to **"write a journal entry"** before you close a chat. The instructions tell it to do this regularly, but it never hurts to ask.
- If the fights feel too hard or too easy, just say so. The GPT is told to balance encounters for one hero and can add an NPC ally to help.
- You can ask out-of-character questions any time, e.g. *"What's my stealth bonus?"* or *"What quests am I on?"*.

## Development

```bash
npm install
npm test          # dice, rules and a full API play-through
npm run dev       # restart on file changes
```

| Env var | Default | Purpose |
|---|---|---|
| `API_KEY` | *(none: open access, with a warning)* | Bearer token ChatGPT must send |
| `PORT` | `3000` | HTTP port |
| `DATA_FILE` | `./data/campaigns.json` | Where campaigns are saved |
| `PUBLIC_URL` | derived from the request | Server URL written into `/openapi.json` |

Code layout: `src/dice.js` (dice parser), `src/rules.js` (5e tables), `src/game.js` (character, rest, combat logic), `src/app.js` (HTTP routes), `src/openapi.js` (the spec ChatGPT imports).

Rules numbers come from the 5e System Reference Document 5.1, used under CC-BY-4.0. This project is not affiliated with or endorsed by Wizards of the Coast.
