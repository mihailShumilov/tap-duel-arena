// Session keys — the mobile UX superpower.
//
// A player approves once; the app then holds a lightweight "session" keypair that signs every tap on
// the Ephemeral Rollup. Because the ER is gasless, this session key needs no SOL, so taps never
// trigger a wallet popup — the game feels like a native Web2 app while staying fully on-chain.
//
// Here the session key is generated and stored locally. In production you'd register it via
// MagicBlock's session-keys program (scoped + time-limited); the on-chain program already checks that
// taps are signed by the registered session pubkey, so the trust model is the same.

import { Keypair } from "@solana/web3.js";

const WALLET_KEY = "tapduel.wallet";
const SESSION_KEY = "tapduel.session";

function load(storageKey: string): Keypair {
  const stored = localStorage.getItem(storageKey);
  if (stored) {
    try {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(stored)));
    } catch {
      /* fall through and regenerate */
    }
  }
  const kp = Keypair.generate();
  localStorage.setItem(storageKey, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/**
 * The player's identity keypair. For a frictionless demo this is a burner funded from the devnet
 * faucet; swap for Mobile Wallet Adapter (Phantom/Solflare/Backpack) for "real" wallet connect.
 */
export function getWallet(): Keypair {
  return load(WALLET_KEY);
}

/** The ephemeral session key that signs gasless taps on the ER (no popups). */
export function getSessionKey(): Keypair {
  return load(SESSION_KEY);
}

export function resetIdentity() {
  localStorage.removeItem(WALLET_KEY);
  localStorage.removeItem(SESSION_KEY);
}
