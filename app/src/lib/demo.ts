// Demo engine: a fully local simulation of a duel so the PWA is playable the instant you run it —
// no wallet, no deploy, no network. You are the host (pulling the rope negative); an AI challenger
// joins and pulls it positive. Everything the real engine does — join, taps, a win, a "commit to
// Solana" step — is mirrored here so the UI code is identical in both modes. Great for the demo
// video and for iterating on feel before the on-chain program is deployed.

import {
  DEFAULT_TARGET,
  DuelEngine,
  DuelState,
  MAX_TAP_POWER,
  Side,
} from "./engine";

export class DemoEngine implements DuelEngine {
  private state: DuelState;
  private subs = new Set<(s: DuelState) => void>();
  private aiTimer: number | null = null;
  private hudTimer: number | null = null;
  private tapTimestamps: number[] = [];

  constructor() {
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
      mode: "demo",
      note: null,
      rpc: { active: "demo-sim", healthy: true, failovers: 0 },
      wallet: null,
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

  async createDuel(target: number) {
    this.emit({
      phase: "waiting",
      target,
      rope: 0,
      tapCount: 0,
      winner: null,
      note: "Waiting for an opponent…",
    });
    // An AI challenger "finds" the match shortly after.
    window.setTimeout(() => void this.joinDuel(), 1200);
  }

  async joinDuel() {
    if (this.state.phase !== "waiting") return;
    this.emit({ phase: "active", note: "Opponent joined — go!" });
    this.startAi();
    this.startHud();
  }

  async tap(power: number) {
    if (this.state.phase !== "active") return;
    this.applyPull("host", power);
  }

  private applyPull(side: Side, power: number) {
    const p = Math.max(1, Math.min(MAX_TAP_POWER, power));
    const rope = this.state.rope + (side === "host" ? -p : p);
    const now = performance.now();
    this.tapTimestamps.push(now);

    let phase = this.state.phase;
    let winner: Side | null = this.state.winner;
    if (rope <= -this.state.target) {
      phase = "settling";
      winner = "host";
    } else if (rope >= this.state.target) {
      phase = "settling";
      winner = "challenger";
    }

    this.emit({ rope, tapCount: this.state.tapCount + 1, phase, winner });
    if (winner) this.finish();
  }

  private startAi() {
    const step = () => {
      if (this.state.phase !== "active") return;
      // AI taps with a little randomness in cadence and occasional boosts, so matches feel alive
      // and are winnable but not trivial.
      const power = Math.random() < 0.15 ? 2 + Math.floor(Math.random() * 3) : 1;
      this.applyPull("challenger", power);
      const delay = 140 + Math.random() * 220;
      this.aiTimer = window.setTimeout(step, delay);
    };
    this.aiTimer = window.setTimeout(step, 400);
  }

  private startHud() {
    this.hudTimer = window.setInterval(() => {
      const cutoff = performance.now() - 1000;
      this.tapTimestamps = this.tapTimestamps.filter((t) => t > cutoff);
      this.emit({ tapsPerSec: this.tapTimestamps.length });
    }, 250);
  }

  private async finish() {
    this.clearTimers();
    // Simulate the commit-to-Solana step so the win screen flow matches on-chain mode.
    await sleep(900);
    const fakeSig = "DemoCommit" + Math.random().toString(36).slice(2, 14);
    this.emit({
      phase: "settled",
      settleSignature: fakeSig,
      explorerUrl: null, // no real tx in demo mode
      note: "Committed (demo)",
    });
  }

  private clearTimers() {
    if (this.aiTimer) window.clearTimeout(this.aiTimer);
    if (this.hudTimer) window.clearInterval(this.hudTimer);
    this.aiTimer = null;
    this.hudTimer = null;
  }

  async settle() {
    // In demo mode settle is automatic on win; this is a no-op safety net.
  }

  dispose() {
    this.clearTimers();
    this.subs.clear();
  }
}

function sleep(ms: number) {
  return new Promise((r) => window.setTimeout(r, ms));
}
