// Resilience layer — powered by solana-resilience-kit (built on @solana/kit / web3.js v2).
//
// The live duel state is read through a ResilientRpcPool: a health-aware, multi-RPC failover
// transport. The Magic Router is the primary endpoint (so reads see live Ephemeral Rollup state);
// public devnet (and an optional QuickNode endpoint) are backups. If the primary RPC degrades or
// 429s mid-match, the kit fails over automatically and the game keeps reading — the demo can show
// this by pointing the primary at a dead URL and watching play continue. Failover/health events are
// surfaced to the UI HUD so the resilience is visible, not just claimed.

import { address, createDefaultRpcTransport } from "@solana/kit";
import { LifecycleEmitter, ResilientRpcPool } from "solana-resilience-kit";

export interface RpcStatus {
  active: string;
  healthy: boolean;
  failovers: number;
  endpoints: { name: string; healthy: boolean }[];
}

export interface DecodedDuel {
  host: Uint8Array;
  challenger: Uint8Array;
  hostSession: Uint8Array;
  challengerSession: Uint8Array;
  winner: Uint8Array;
  rope: number;
  target: number;
  tapCount: number;
  status: number;
}

export interface Resilience {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: any;
  status: RpcStatus;
  events: LifecycleEmitter;
}

export function createResilience(
  endpoints: { name: string; url: string }[]
): Resilience {
  const events = new LifecycleEmitter();
  const pool = new ResilientRpcPool({
    endpoints: endpoints.map((e) => ({
      name: e.name,
      transport: createDefaultRpcTransport({ url: e.url }),
    })),
    events,
    freshnessAware: true,
  });

  const status: RpcStatus = {
    active: endpoints[0]?.name ?? "-",
    healthy: true,
    failovers: 0,
    endpoints: endpoints.map((e) => ({ name: e.name, healthy: true })),
  };

  events.on("connection:failover", (p) => {
    status.active = p.to;
    status.failovers += 1;
  });
  events.on("connection:health", (p) => {
    const ep = status.endpoints.find((x) => x.name === p.endpoint);
    if (ep) ep.healthy = p.healthy;
    status.healthy = status.endpoints.some((x) => x.healthy);
  });

  return { rpc: pool.rpc(), status, events };
}

/** Fetch + decode the on-chain Duel account through the resilient pool. */
export async function fetchDuel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc: any,
  pdaBase58: string
): Promise<DecodedDuel | null> {
  const res = await rpc
    .getAccountInfo(address(pdaBase58), {
      encoding: "base64",
      commitment: "confirmed",
    })
    .send();
  const value = res?.value;
  if (!value) return null;
  const raw = value.data;
  const b64: string = Array.isArray(raw) ? raw[0] : String(raw);
  return decodeDuel(base64ToBytes(b64));
}

// Anchor account layout for `Duel`: 8-byte discriminator, then 5 pubkeys, i32 rope, i32 target,
// u64 tap_count, u8 status, u8 bump (all little-endian).
function decodeDuel(b: Uint8Array): DecodedDuel {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 8;
  const pk = () => {
    const s = b.slice(o, o + 32);
    o += 32;
    return s;
  };
  const host = pk();
  const challenger = pk();
  const hostSession = pk();
  const challengerSession = pk();
  const winner = pk();
  const rope = dv.getInt32(o, true);
  o += 4;
  const target = dv.getInt32(o, true);
  o += 4;
  const tapLo = dv.getUint32(o, true);
  const tapHi = dv.getUint32(o + 4, true);
  o += 8;
  const tapCount = tapHi * 2 ** 32 + tapLo;
  const status = b[o];
  return {
    host,
    challenger,
    hostSession,
    challengerSession,
    winner,
    rope,
    target,
    tapCount,
    status,
  };
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
