# ⚡ Tap-Duel Arena

**Real-time 1v1 tug-of-war on Solana. Every tap is a gasless transaction on a MagicBlock Ephemeral Rollup.**

Submission for **Solana Blitz V6** (theme: Mobile). Two players go head-to-head pulling a rope —
each tap moves it, first to their side wins. Because the game state lives in an **Ephemeral Rollup**,
taps land in ~10ms, cost nothing, and never trigger a wallet popup (session keys). The final result is
**committed back to the Solana base layer** and shown with a live explorer link.

- 📱 **Mobile-first PWA** — installable, touch-native, portrait.
- ⚡ **Ephemeral Rollups** — the Duel account is delegated into an ER; taps execute there gasless.
- 🔑 **Session keys** — zero wallet popups mid-game.
- 🎲 **VRF boost** — a provably-fair random power-up multiplier (on-chain VRF; simulated in demo mode).
- ✅ **Settles to L1** — `commit_and_undelegate` writes the final state to Solana devnet.
- 🛡️ **Resilient RPC** — live duel state is read through [`solana-resilience-kit`](https://www.npmjs.com/package/solana-resilience-kit): health-aware multi-RPC failover (Magic Router primary, devnet/QuickNode backups), shown live in the HUD.

---

## Repository layout

```
tap-duel-arena/
├── programs/tap-duel/        # Anchor program (Rust) — the ER integration
│   └── src/lib.rs            # create_duel · join_duel · delegate_duel · tap · settle
├── app/                      # Mobile-web PWA (Vite + React + TypeScript)
│   └── src/
│       ├── lib/demo.ts       # instant local simulation (runs with no wallet/deploy)
│       ├── lib/onchain.ts    # real ER client: Magic Router + sendMagicTransaction + session keys
│       ├── lib/resilience.ts # solana-resilience-kit: multi-RPC failover read path + Duel decoder
│       ├── lib/session.ts    # session-key management
│       └── App.tsx           # game UI
├── Anchor.toml
└── README.md
```

---

## Quick start — demo mode (no wallet, no deploy)

The app ships with a fully playable local simulation so you can see the feel instantly (and it's what
the demo video opens with):

```bash
cd app
npm install
npm run dev            # open the printed URL on your phone or in a mobile viewport
```

You are the host; an AI challenger joins and the duel plays out, ending with a simulated
"Committing to Solana…" step. Great for iterating on feel — no Solana required.

---

## Full setup — on-chain mode (Solana devnet + Ephemeral Rollups)

### 1. Prerequisites
- Rust + Solana CLI + Anchor (`avm install 0.31.1 && avm use 0.31.1`)
- A funded devnet wallet: `solana airdrop 2 --url devnet`

### 2. Build & deploy the program
```bash
anchor keys sync                       # writes the real program ID into lib.rs + Anchor.toml
anchor build
anchor deploy --provider.cluster devnet
```

### 3. Wire the client to the deployed program
```bash
cp target/idl/tap_duel.json app/src/idl/tap_duel.json   # replace the placeholder IDL
cd app
cp .env.example .env.local                              # set VITE_PROGRAM_ID to your deployed ID
npm run dev
```

### 4. Play a real match
- Player A taps **Host a Duel** and shares the **duel code** (their public key).
- Player B pastes the code and taps **Join**.
- The host auto-delegates the Duel PDA into the ER; both players tap in real time (gasless).
- On a win, the host's client fires `settle` → the final state commits to Solana L1 and the win
  screen shows a **Solana Explorer** link to the settlement transaction.

> ER endpoints used: Magic Router `https://devnet-router.magicblock.app` (auto-routes ER vs L1) and
> Solana devnet `https://api.devnet.solana.com`.

---

## How the Ephemeral Rollup integration works

The lifecycle (see `programs/tap-duel/src/lib.rs`):

1. **`create_duel` / `join_duel`** (base layer) — set up the `Duel` PDA and register each player's
   session key.
2. **`delegate_duel`** (base layer) — `#[delegate]` macro delegates the `Duel` PDA into the ER.
3. **`tap`** (ER, gasless) — signed by a **session key**, moves the rope; the host pulls negative, the
   challenger positive. Many of these fire per second at ~10ms latency, zero fees.
4. **`settle`** (ER) — `#[commit]` + `commit_and_undelegate_accounts` writes the final rope + winner
   back to Solana L1 and returns account ownership to the base layer.

The client sends taps via `sendMagicTransaction`, which routes them to the ER because the touched
account is delegated. Reads go through the Magic Router too, so the UI sees live ER state.

### Session keys (why there are no popups)
Each player registers an ephemeral session pubkey at create/join time. Taps are signed by that
in-app session key instead of the wallet. Because the ER is gasless, the session key needs no SOL —
so a tap-heavy mobile game has **zero wallet prompts** after the initial setup. The program enforces
that taps are signed by a registered session key. (Production apps can swap this for MagicBlock's
session-keys program; same trust model.)

---

## Resilient RPC layer (solana-resilience-kit)

Live game reads don't hit a single RPC. `app/src/lib/resilience.ts` builds a `ResilientRpcPool`
(from [`solana-resilience-kit`](https://www.npmjs.com/package/solana-resilience-kit), on `@solana/kit`)
over the Magic Router (primary — so reads see live ER state) plus public devnet and an optional
QuickNode endpoint as health-aware failover backups. The duel account is fetched and decoded through
this pool every poll, and the HUD shows the active endpoint + failover count. To demo it, point
`VITE_ROUTER_RPC` at a dead URL — the pool fails over and the match keeps reading. Set an optional
extra backup with `VITE_QUICKNODE_RPC`.

## Submission checklist (Solana Blitz V6)

- [x] Delegates an account into an Ephemeral Rollup and executes transactions there (**eligibility**)
- [x] Mobile-first (installable PWA)
- [x] Commits state back to the Solana base layer (explorer link on the win screen)
- [ ] Public GitHub repo
- [ ] Demo video / live link
- [ ] Submit via the "Submission: Solana Blitz v6" event on the MagicBlock Luma calendar

---

## Notes & honest edges
- **Placeholder program ID** (`Due1TapArena…`) — `anchor keys sync` replaces it. Update
  `VITE_PROGRAM_ID` to match.
- **Placeholder IDL** in `app/src/idl/tap_duel.json` — replace with the one `anchor build` generates.
- The `delegate_duel` client call relies on Anchor 0.31 auto-resolving the injected delegation PDAs
  from the generated IDL. If it complains, mirror the accounts from the official
  [counter example](https://github.com/magicblock-labs/magicblock-engine-examples).
- **VRF** is simulated client-side in this build; wiring MagicBlock VRF for the boost roll is the
  first stretch upgrade (see the Roll Dice example).
- For a frictionless demo, players use in-app burner keypairs funded from the devnet faucet; the
  Mobile Wallet Adapter path (Phantom/Solflare/Backpack) is the "real wallet" upgrade.
