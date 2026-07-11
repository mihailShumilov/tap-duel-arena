#!/usr/bin/env bash
# One-command devnet deploy for Tap-Duel Arena.
# Run on a machine with Rust + Solana CLI + Anchor 0.31.1 and network access.
# Uses the bundled throwaway devnet keypairs so the program ID stays BmDc7… (matches the client).
set -euo pipefail
cd "$(dirname "$0")"

PAYER=./deploy-keypair.json      # funded devnet payer (~5 SOL)
PROGKP=./program-keypair.json    # program keypair → keeps program ID = BmDc7…

command -v anchor >/dev/null || { echo "❌ anchor not found. Install: avm install 0.31.1 && avm use 0.31.1"; exit 1; }
command -v solana >/dev/null || { echo "❌ solana CLI not found."; exit 1; }

solana config set --url https://api.devnet.solana.com --keypair "$PAYER" >/dev/null
echo "Payer:   $(solana address -k "$PAYER")"
echo "Balance: $(solana balance -k "$PAYER")"

# Keep the program ID stable so the already-built client points at the right program.
mkdir -p target/deploy
cp "$PROGKP" target/deploy/tap_duel-keypair.json

echo "==> anchor build (downloads platform-tools on first run)…"
anchor build

echo "==> anchor deploy → devnet…"
anchor deploy --provider.cluster devnet --provider.wallet "$PAYER"

# Wire the freshly generated IDL into the client.
cp target/idl/tap_duel.json app/src/idl/tap_duel.json

PID=$(solana address -k target/deploy/tap_duel-keypair.json)
echo ""
echo "✅ Deployed program: $PID"
echo "   Explorer: https://explorer.solana.com/address/$PID?cluster=devnet"
echo ""
echo "Next: run the client against it —"
echo "   cd app && cp .env.example .env.local && npm install && npm run dev"
echo "(.env.local already has VITE_MODE=onchain and the right program ID)"
