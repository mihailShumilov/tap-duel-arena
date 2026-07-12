// Shared types + the engine contract both the demo simulation and the real on-chain client implement.
// The UI only ever talks to this interface, so switching between "instant demo" and "real Solana"
// is a one-line config change and the game screen never has to know which is running.

export type Side = "host" | "challenger";

export type DuelPhase =
  | "idle" // nothing created yet
  | "waiting" // duel created, waiting for the challenger to join
  | "delegating" // delegating the Duel PDA into the Ephemeral Rollup
  | "active" // taps are live on the ER
  | "settling" // committing final state to Solana L1
  | "settled"; // committed + undelegated; explorer link available

export interface DuelState {
  phase: DuelPhase;
  rope: number; // <0 = host is winning, >0 = challenger is winning
  target: number; // rope units needed to win
  tapCount: number; // total taps this match (both sides)
  mySide: Side;
  winner: Side | null;
  tapsPerSec: number; // live HUD metric — makes the ER's throughput visible
  settleSignature: string | null; // base-layer signature after settle()
  explorerUrl: string | null;
  mode: "demo" | "onchain";
  note: string | null; // optional status line (e.g. "opponent joined")
  // Live RPC resilience status (solana-resilience-kit) — active endpoint + failover count.
  rpc: { active: string; healthy: boolean; failovers: number } | null;
  // Connected wallet (onchain mode).
  wallet: { address: string; label: string; balanceSol: number | null } | null;
}

export interface DuelEngine {
  getState(): DuelState;
  subscribe(cb: (s: DuelState) => void): () => void;
  /** Host creates a duel with a win target. */
  createDuel(target: number): Promise<void>;
  /** Challenger joins the open duel (demo: an AI opponent joins automatically). */
  joinDuel(): Promise<void>;
  /** Onchain: auto-match — join the nearest open duel, or open one and wait. */
  quickMatch?(): Promise<void>;
  /** One tap. power 1 = normal, up to 5 with a VRF boost. Gasless on the ER. */
  tap(power: number): Promise<void>;
  /** Commit the final state to Solana L1 and undelegate. */
  settle(): Promise<void>;
  dispose(): void;
}

export const DEFAULT_TARGET = 60;
export const MAX_TAP_POWER = 5;
