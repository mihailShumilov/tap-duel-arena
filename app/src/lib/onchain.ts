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
import { getSessionKey } from "./session";
import { AppWallet, getBalanceSol } from "./wallet";
import {
  DEFAULT_TARGET,
  DuelEngine,
  DuelState,
  MAX_TAP_POWER,
  Side,
} from "./engine";

// Duel account: 8 disc + 5 pubkeys + i32 + i32 + u64 + u8 + u8 = 186 bytes; status byte at 184.
const DUEL_ACCOUNT_SIZE = 186;
const STATUS_OFFSET = 184;
const HOST_OFFSET = 8;

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
  private wallet: AppWallet;
  private walletPk: PublicKey;
  private session = getSessionKey();
  private role: Side = "host";
  private programId = new PublicKey(PROGRAM_ID);
  private hostKey!: PublicKey; // whose PDA this duel lives under (set during quickMatch)
  private currentDuel!: PublicKey; // the duel PDA we're currently polling (can switch on yield)
  private rescanBusy = false;
  private pollTimer: number | null = null;
  private tapTimestamps: number[] = [];

  constructor(appWallet: AppWallet) {
    this.wallet = appWallet;
    this.walletPk = appWallet.publicKey;

    // The router is a normal Connection to the Magic Router endpoint; sendMagicTransaction inspects
    // each tx and dispatches it to the ER (delegated accounts) or the base layer automatically.
    this.router = new Connection(RPC.router, "confirmed");
    this.base = new Connection(RPC.base, "confirmed");

    // The connected wallet (Phantom or burner) signs the base-layer create/join/delegate txs.
    const provider = new AnchorProvider(this.base, appWallet as any, {
      commitment: "confirmed",
    });
    this.program = new Program(idl as any, provider);
    const readProvider = new AnchorProvider(this.router, appWallet as any, {
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

    this.state = {
      phase: "idle",
      rope: 0,
      target: DEFAULT_TARGET,
      tapCount: 0,
      mySide: "host",
      winner: null,
      tapsPerSec: 0,
      settleSignature: null,
      explorerUrl: null,
      mode: "onchain",
      note: null,
      rpc: {
        active: this.resilience.status.active,
        healthy: this.resilience.status.healthy,
        failovers: this.resilience.status.failovers,
      },
      wallet: {
        address: this.walletPk.toBase58(),
        label: appWallet.label,
        balanceSol: null,
      },
    };
    void this.refreshBalance();
  }

  private async refreshBalance() {
    try {
      const balanceSol = await getBalanceSol(this.base, this.walletPk);
      this.emit({
        wallet: {
          address: this.walletPk.toBase58(),
          label: this.wallet.label,
          balanceSol,
        },
      });
    } catch {
      /* ignore */
    }
  }

  /** All open-duel host pubkeys (status = WaitingForChallenger) currently on the base layer. */
  private async findOpenHosts(): Promise<PublicKey[]> {
    const accts = await this.base.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: DUEL_ACCOUNT_SIZE },
        // status byte == 0 (WaitingForChallenger); base58 of a single 0x00 byte is "1".
        { memcmp: { offset: STATUS_OFFSET, bytes: "1" } },
      ],
    });
    return accts.map(
      ({ account }) =>
        new PublicKey(account.data.subarray(HOST_OFFSET, HOST_OFFSET + 32))
    );
  }

  // Deterministic pick so every client converges on the SAME open duel to join.
  private static smallest(keys: PublicKey[]): PublicKey | null {
    if (!keys.length) return null;
    return keys.reduce((a, b) => (a.toBase58() < b.toBase58() ? a : b));
  }

  /** Auto-match: join the smallest open duel, or open one and wait for a challenger. */
  async quickMatch() {
    // Guard: an unfunded wallet can't pay the base-layer create/join fee — say so clearly.
    let bal = 0;
    try {
      bal = await getBalanceSol(this.base, this.walletPk);
    } catch {
      /* ignore */
    }
    if (bal < 0.01) {
      this.emit({
        phase: "error",
        note: `Wallet has ${bal.toFixed(4)} SOL — a host needs devnet SOL for create + delegate. Fund ~0.05 SOL at faucet.solana.com and tap Quick Match again.`,
      });
      return;
    }

    this.emit({ phase: "waiting", note: "Looking for an open duel…" });
    let others: PublicKey[] = [];
    try {
      const hosts = await this.findOpenHosts();
      others = hosts.filter((h) => !h.equals(this.walletPk));
    } catch {
      /* getProgramAccounts hiccup — fall through to hosting */
    }
    const target = OnchainEngine.smallest(others);
    try {
      if (target) {
        this.role = "challenger";
        this.hostKey = target;
        this.emit({ mySide: "challenger", note: "Found an open duel — joining…" });
        await this.joinDuel();
      } else {
        this.role = "host";
        this.hostKey = this.walletPk;
        this.emit({
          mySide: "host",
          note: "No open duels — opening yours, waiting for a rival…",
        });
        await this.createDuel(DEFAULT_TARGET);
      }
    } catch (e: any) {
      // Surface the real reason instead of hanging on "waiting" forever.
      this.emit({
        phase: "error",
        note: friendlyError(e),
      });
      throw e;
    }
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
    const duel = duelPda(this.walletPk, this.programId);
    await (this.program as any).methods
      .createDuel(new BN(target), this.session.publicKey)
      .accounts({ host: this.walletPk, duel })
      .rpc();
    this.emit({
      phase: "waiting",
      target,
      note: "You're open — waiting for a rival to quick-match…",
    });
    this.startPolling(duel);
  }

  async joinDuel() {
    const duel = duelPda(this.hostKey, this.programId);
    await (this.program as any).methods
      .joinDuel(this.session.publicKey)
      .accounts({ challenger: this.walletPk, duel })
      .rpc();
    this.emit({ note: "Joined — delegating to the rollup…" });
    // The host is responsible for delegating; the challenger just waits for phase → active.
    this.startPolling(duel);
  }

  /** Delegate the Duel PDA into the ER. Host-only; one base-layer tx. */
  async delegate() {
    this.emit({ phase: "delegating", note: "Delegating to Ephemeral Rollup…" });
    const duel = duelPda(this.walletPk, this.programId);
    // Anchor 0.31 auto-resolves the seeded delegation PDAs (buffer/record/metadata) and system
    // program from the IDL. owner_program is this program; delegation_program is provided by the
    // ER SDK. If resolution complains, mirror the accounts from the counter example's delegate call.
    await (this.program as any).methods
      .delegateDuel()
      .accounts({ host: this.walletPk, duel })
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
    this.currentDuel = duel;
    if (this.pollTimer) return;
    let settleTriggered = false;
    let tick = 0;
    this.pollTimer = window.setInterval(async () => {
      tick++;

      // Rescan-and-yield: a waiting host periodically re-checks for other open duels. If one exists
      // with a smaller pubkey, this client yields (becomes the challenger and joins it) so two
      // players who each opened a duel converge on a single match instead of both waiting forever.
      if (
        this.role === "host" &&
        this.state.phase === "waiting" &&
        !this.delegated &&
        !this.rescanBusy &&
        tick % 12 === 0
      ) {
        this.rescanBusy = true;
        try {
          const smallest = OnchainEngine.smallest(await this.findOpenHosts());
          if (smallest && !smallest.equals(this.walletPk)) {
            this.role = "challenger";
            this.hostKey = smallest;
            this.emit({ mySide: "challenger", note: "Matched — joining…" });
            await this.joinDuel(); // re-points polling to their duel
          }
        } catch {
          /* ignore */
        }
        this.rescanBusy = false;
      }

      try {
        // Read the live Duel account through the resilient failover pool (Magic Router primary,
        // devnet/QuickNode backups). This is the solana-resilience-kit read path.
        const acc = await fetchDuel(this.resilience.rpc, this.currentDuel.toBase58());
        if (!acc) return; // account not created yet — keep polling

        const cutoff = performance.now() - 1000;
        this.tapTimestamps = this.tapTimestamps.filter((t) => t > cutoff);

        let phase = this.state.phase;
        let winner: Side | null = this.state.winner;

        // Host auto-delegates the moment the challenger joins, then taps go live on the ER.
        if (acc.status === 1 && !this.delegated && this.role === "host") {
          this.delegated = true;
          void this.delegate();
        }
        if (acc.status === 1 && phase === "waiting" && this.role === "challenger")
          phase = "active";
        if (acc.status === 2) {
          winner = bytesEqual(acc.winner, this.hostKey.toBytes())
            ? "host"
            : "challenger";
          if (!settleTriggered && this.role === "host") {
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

function friendlyError(e: any): string {
  const msg = String(e?.message || e || "Unknown error");
  if (/insufficient|0x1\b|debit an account|not enough lamports/i.test(msg))
    return "Not enough devnet SOL — fund your wallet at faucet.solana.com and tap Quick Match again.";
  if (/User rejected|rejected the request|denied|declined/i.test(msg))
    return "Wallet request was rejected — approve it to create/join the duel.";
  if (/blockhash|block height exceeded|expired|Timed out|timeout/i.test(msg))
    return "Network hiccup (blockhash expired). Tap Quick Match again.";
  if (/already in use|already been processed|custom program error: 0x0/i.test(msg))
    return "This wallet already has a duel from a previous round. Reload the page (or use a fresh wallet) to play again.";
  return "Couldn't start the match: " + msg.slice(0, 180);
}
