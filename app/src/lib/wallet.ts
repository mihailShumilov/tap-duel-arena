// Wallet layer. Prefers an injected Solana wallet (Phantom / Solflare / Backpack via window.solana);
// falls back to a local burner keypair so the app still works with no extension. The connected wallet
// signs the base-layer txs (create/join/delegate). Gameplay taps are signed by the session key
// (see session.ts) so there are no wallet popups mid-match.

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { getWallet as getBurner } from "./session";

export interface AppWallet {
  publicKey: PublicKey;
  label: string; // "Phantom", "Solflare", "Burner", …
  kind: "injected" | "burner";
  signTransaction(tx: Transaction): Promise<Transaction>;
  signAllTransactions(txs: Transaction[]): Promise<Transaction[]>;
  // Present only for the burner (used to auto-sign without a popup where needed).
  payer?: Keypair;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function injectedProvider(): any | null {
  const w = window as any;
  if (w.phantom?.solana?.isPhantom) return w.phantom.solana;
  if (w.solana?.isPhantom) return w.solana;
  if (w.solflare?.isSolflare) return w.solflare;
  if (w.backpack) return w.backpack;
  if (w.solana) return w.solana; // generic injected provider
  return null;
}

export function hasInjectedWallet(): boolean {
  return injectedProvider() !== null;
}

/** Connect an injected wallet (prompts the extension). Throws if none / user rejects. */
export async function connectInjected(): Promise<AppWallet> {
  const provider = injectedProvider();
  if (!provider) throw new Error("No Solana wallet extension found");
  const res = await provider.connect();
  const pkStr =
    res?.publicKey?.toString?.() || provider.publicKey?.toString?.();
  if (!pkStr) throw new Error("Wallet did not return a public key");
  const label = provider.isPhantom
    ? "Phantom"
    : provider.isSolflare
    ? "Solflare"
    : "Wallet";
  return {
    publicKey: new PublicKey(pkStr),
    label,
    kind: "injected",
    signTransaction: (tx) => provider.signTransaction(tx),
    signAllTransactions: (txs) =>
      provider.signAllTransactions
        ? provider.signAllTransactions(txs)
        : Promise.all(txs.map((t: Transaction) => provider.signTransaction(t))),
  };
}

/** The always-available burner wallet (no popup). */
export function burnerWallet(): AppWallet {
  const kp = getBurner();
  return {
    publicKey: kp.publicKey,
    label: "Burner",
    kind: "burner",
    payer: kp,
    signTransaction: async (tx) => {
      tx.partialSign(kp);
      return tx;
    },
    signAllTransactions: async (txs) => {
      txs.forEach((t) => t.partialSign(kp));
      return txs;
    },
  };
}

export async function getBalanceSol(
  connection: Connection,
  pk: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(pk, "confirmed");
  return lamports / LAMPORTS_PER_SOL;
}

/** Best-effort devnet airdrop (often rate-limited). Returns the signature or throws. */
export async function tryAirdrop(
  connection: Connection,
  pk: PublicKey,
  sol = 1
): Promise<string> {
  const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}
