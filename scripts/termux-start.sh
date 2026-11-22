#!/usr/bin/env bash
# One-command launcher for Android (Termux): starts a public tunnel and the game server,
# then prints the URL and API key to paste into your Custom GPT's Action.
#
#   bash scripts/termux-start.sh
#
# Stop with Ctrl+C (Termux keyboard: CTRL then c).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"
mkdir -p data

missing=()
command -v node >/dev/null || missing+=(nodejs)
command -v cloudflared >/dev/null || missing+=(cloudflared)
if [ ${#missing[@]} -gt 0 ]; then
  echo "Missing: ${missing[*]}"
  echo "Install with:  pkg install ${missing[*]}"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first run only)..."
  npm install --omit=dev --no-audit --no-fund
fi

# Create the API key once and reuse it, so ChatGPT's saved key keeps working.
KEY_FILE=data/api-key.txt
if [ ! -s "$KEY_FILE" ]; then
  node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > "$KEY_FILE"
fi
API_KEY="$(cat "$KEY_FILE")"

# Keep Android from sleeping Termux while the game is running.
command -v termux-wake-lock >/dev/null && termux-wake-lock || true

TUNNEL_PID=""
SERVER_PID=""
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "Stopping..."
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
  command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true
}
trap cleanup EXIT INT TERM

echo "Starting tunnel..."
: > data/tunnel.log
cloudflared tunnel --no-autoupdate --url "http://localhost:$PORT" > data/tunnel.log 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 60); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/tunnel.log | head -n1 || true)"
  [ -n "$URL" ] && break
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then break; fi
  sleep 1
done
if [ -z "$URL" ]; then
  echo "Could not start the tunnel. Check your internet connection. Log:"
  tail -n 20 data/tunnel.log
  exit 1
fi
echo "$URL" > data/tunnel-url.txt

echo "Starting game server..."
API_KEY="$API_KEY" PUBLIC_URL="$URL" PORT="$PORT" node src/index.js > data/server.log 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 30); do
  if node -e "fetch('http://localhost:$PORT/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server failed to start. Log:"
    tail -n 20 data/server.log
    exit 1
  fi
  sleep 1
done

PREV_URL_FILE=data/last-imported-url.txt
cat <<EOF

=====================================================
  Your solo adventure server is running!

  Action import URL (ChatGPT -> your GPT -> Actions):
    $URL/openapi.json

  API key (Authentication: API Key, type Bearer):
    $API_KEY

  Privacy policy URL:
    $URL/privacy
=====================================================
EOF
if [ -f "$PREV_URL_FILE" ] && [ "$(cat "$PREV_URL_FILE")" != "$URL" ]; then
  echo "  NOTE: the address changed since last time. In your GPT's Action,"
  echo "  click Import from URL again with the new link above, then Update."
fi
echo "$URL" > "$PREV_URL_FILE"
echo
echo "  Keep Termux open. Press Ctrl+C to stop."
echo

# Exit (and clean up) if either process dies.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do sleep 5; done
echo "A process stopped unexpectedly. Last log lines:"
tail -n 5 data/server.log data/tunnel.log
exit 1
