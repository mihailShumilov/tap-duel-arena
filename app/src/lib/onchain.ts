// On-chain engine: the real thing. Runs the duel against a deployed Anchor program, delegating the
// Duel PDA into a MagicBlock Ephemeral Rollup and sending gasless, session-key-signed taps through
// the Magic Router. Enable by setting VITE_MODE=onchain (and deploying the program + copying the
// generated IDL to src/idl/tap_duel.json).
//
// Flow: createDuel (base) → joinDuel (base) → delegateDuel (base) → tap × N (ER, gasless) →
//       settle = commit_and_undelegate (ER) → final state on Solana L1.
//
// Two-player matchmaking is by "duel code" = the host's public key (base58). The host shares it; the
// challenger pastes it in to derive the same Duel PDA and join.

import { AnchorProvider, BN, Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
// From @magicblock-labs/ephemeral-rollups-sdk (v0.2.x). The router is a plain web3.js Connection
// pointed at the Magic Router endpoint; sendMagicTransaction routes each tx to the ER or base layer.
import { sendMagicTransaction } from "@magicblock-labs/ephemeral-rollups-sdk";

import idl from "../idl/tap_duel.json";
import {
  Resilience,
  bytesEqual,
  createResilience,
  fetchDuel,
} from "./resilience";
import { PROGRAM_ID, RPC, explorerAddress, explorerTx } from "./config";
import { getSessionKey, getWallet } from "./session";
import {
  DEFAULT_TARGET,
  DuelEngine,
  DuelState,
  MAX_TAP_POWER,
  Side,
} from "./engine";

const DUEL_SEED = new TextEncoder().encode("duel");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProgram = Program<any>;

function duelPda(host: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DUEL_SEED, host.toBuffer()],
    programId
  )[0];
}

export class OnchainEngine implements DuelEngine {
  private state: DuelState;
  private subs = new Set<(s: DuelState) => void>();
  private program: AnyProgram; // base-layer provider (create/join/delegate)
  private readProgram: AnyProgram; // router provider (reads — proxies to ER when delegated)
  private router: Connection;
  private base: Connection;
  private resilience: Resilience; // solana-resilience-kit: multi-RPC failover for live reads
  private delegated = false;
  private wallet = getWallet();
  private session = getSessionKey();
  private programId = new PublicKey(PROGRAM_ID);
  private hostKey: PublicKey; // whose PDA this duel lives under
  private pollTimer: number | null = null;
  private tapTimestamps: number[] = [];

  constructor(role: "host" | "challenger", duelCode?: string) {
    // The router is a normal Connection to the Magic Router endpoint; sendMagicTransaction inspects
    // each tx and dispatches it to the ER (delegated accounts) or the base layer automatically.
    this.router = new Connection(RPC.router, "confirmed");
    this.base = new Connection(RPC.base, "confirmed");

    // Anchor's browser build doesn't ship NodeWallet, so wrap the keypair in the minimal wallet
    // interface AnchorProvider needs (used only for base-layer create/join/delegate txs).
    const wallet = {
      publicKey: this.wallet.publicKey,
      signTransaction: async (tx: Transaction) => {
        tx.partialSign(this.wallet);
        return tx;
      },
      signAllTransactions: async (txs: Transaction[]) => {
        txs.forEach((t) => t.partialSign(this.wallet));
        return txs;
      },
      payer: this.wallet,
    };
    const provider = new AnchorProvider(this.base, wallet as any, {
      commitment: "confirmed",
    });
    this.program = new Program(idl as any, provider);
    // Reads go through the router: it serves base-layer state before delegation and live ER state
    // after, so the same fetch works across the whole lifecycle.
    const readProvider = new AnchorProvider(this.router, wallet as any, {
      commitment: "confirmed",
    });
    this.readProgram = new Program(idl as any, readProvider);

    // Resilient read path (solana-resilience-kit): Magic Router primary so we see live ER state,
    // with public devnet — and QuickNode if configured — as health-aware failover backups.
    this.resilience = createResilience(
      [
        { name: "magic-router", url: RPC.router },
        { name: "devnet", url: RPC.base },
        RPC.quicknode ? { name: "quicknode", url: RPC.quicknode } : null,
      ].filter(Boolean) as { name: string; url: string }[]
    );

    this.hostKey =
      role === "host"
        ? this.wallet.publicKey
        : new PublicKey(duelCode as string);

    this.state = {
      phase: "idle",
      rope: 0,
      target: DEFAULT_TARGET,
      tapCount: 0,
      mySide: role,
      winner: null,
      tapsPerSec: 0,
      settleSignature: null,
      explorerUrl: null,
      mode: "onchain",
      note: `You: ${this.wallet.publicKey.toBase58().slice(0, 4)}…`,
      rpc: {
        active: this.resilience.status.active,
        healthy: this.resilience.status.healthy,
        failovers: this.resilience.status.failovers,
      },
    };
  }

  getState() {
    return this.state;
  }

  subscribe(cb: (s: DuelState) => void) {
    this.subs.add(cb);
    cb(this.state);
    return () => this.subs.delete(cb);
  }

  private emit(patch: Partial<DuelState>) {
    this.state = { ...this.state, ...patch };
    this.subs.forEach((cb) => cb(this.state));
  }

  /** The host's pubkey — share this string so a challenger can join. */
  duelCode(): string {
    return this.hostKey.toBase58();
  }

  async createDuel(target: number) {
    const duel = duelPda(this.wallet.publicKey, this.programId);
    await (this.program as any).methods
      .createDuel(new BN(target), this.session.publicKey)
      .accounts({ host: this.wallet.publicKey, duel })
      .rpc();
    this.emit({ phase: "waiting", target, note: "Share your duel code to invite an opponent" });
    this.startPolling(duel);
  }

  async joinDuel() {
    const duel = duelPda(this.hostKey, this.programId);
    await (this.program as any).methods
      .joinDuel(this.session.publicKey)
      .accounts({ challenger: this.wallet.publicKey, duel })
      .rpc();
    this.emit({ note: "Joined — delegating to the rollup…" });
    // The host is responsible for delegating; the challenger just waits for phase → active.
    this.startPolling(duel);
  }

  /** Delegate the Duel PDA into the ER. Host-only; one base-layer tx. */
  async delegate() {
    this.emit({ phase: "delegating", note: "Delegating to Ephemeral Rollup…" });
    const duel = duelPda(this.wallet.publicKey, this.programId);
    // Anchor 0.31 auto-resolves the seeded delegation PDAs (buffer/record/metadata) and system
    // program from the IDL. owner_program is this program; delegation_program is provided by the
    // ER SDK. If resolution complains, mirror the accounts from the counter example's delegate call.
    await (this.program as any).methods
      .delegateDuel()
      .accounts({ host: this.wallet.publicKey, duel })
      .rpc();
    this.emit({ phase: "active", note: "Live on the rollup — tap!" });
  }

  async tap(power: number) {
    if (this.state.phase !== "active") return;
    const duel = duelPda(this.hostKey, this.programId);
    const ix = await (this.program as any).methods
      .tap(Math.max(1, Math.min(MAX_TAP_POWER, power)))
      .accounts({ sessionSigner: this.session.publicKey, duel })
      .instruction();
    const tx = new Transaction().add(ix);
    // Gasless on the ER, signed by the session key → no wallet popup.
    await sendMagicTransaction(this.router, tx, [this.session]);
    this.tapTimestamps.push(performance.now());
  }

  async settle() {
    this.emit({ phase: "settling", note: "Committing to Solana…" });
    const duel = duelPda(this.hostKey, this.programId);
    const ix = await (this.program as any).methods
      .settle()
      .accounts({ sessionSigner: this.session.publicKey, duel })
      .instruction();
    const tx = new Transaction().add(ix);
    const sig = await sendMagicTransaction(this.router, tx, [this.session]);
    this.emit({
      phase: "settled",
      settleSignature: sig,
      explorerUrl: explorerTx(sig),
      note: "Settled to L1",
    });
  }

  private startPolling(duel: PublicKey) {
    if (this.pollTimer) return;
    let settleTriggered = false;
    const duelB58 = duel.toBase58();
    const hostBytes = this.hostKey.toBytes();
    this.pollTimer = window.setInterval(async () => {
      try {
        // Read the live Duel account through the resilient failover pool (Magic Router primary,
        // devnet/QuickNode backups). This is the solana-resilience-kit read path.
        const acc = await fetchDuel(this.resilience.rpc, duelB58);
        if (!acc) return; // account not created yet — keep polling

        const cutoff = performance.now() - 1000;
        this.tapTimestamps = this.tapTimestamps.filter((t) => t > cutoff);

        let phase = this.state.phase;
        let winner: Side | null = this.state.winner;

        // Host auto-delegates the moment the challenger joins, then taps go live on the ER.
        if (acc.status === 1 && !this.delegated && this.state.mySide === "host") {
          this.delegated = true;
          void this.delegate();
        }
        if (
          acc.status === 1 &&
          phase === "waiting" &&
          this.state.mySide === "challenger"
        )
          phase = "active";
        if (acc.status === 2) {
          winner = bytesEqual(acc.winner, hostBytes) ? "host" : "challenger";
          if (!settleTriggered && this.state.mySide === "host") {
            settleTriggered = true;
            void this.settle();
          }
        }

        const s = this.resilience.status;
        this.emit({
          rope: acc.rope,
          tapCount: acc.tapCount,
          target: acc.target,
          tapsPerSec: this.tapTimestamps.length,
          phase,
          winner,
          rpc: { active: s.active, healthy: s.healthy, failovers: s.failovers },
        });
      } catch {
        /* transient RPC/ER error — the pool fails over; keep polling */
      }
    }, 120);
  }

  hostAddressUrl(): string {
    return explorerAddress(duelPda(this.hostKey, this.programId).toBase58());
  }

  dispose() {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.subs.clear();
  }
}

export function newSessionKeypair(): Keypair {
  return getSessionKey();
}
