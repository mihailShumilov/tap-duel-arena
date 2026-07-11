import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DemoEngine } from "./lib/demo";
import { DuelEngine, DuelState, DEFAULT_TARGET } from "./lib/engine";
import { MODE } from "./lib/config";

// The on-chain engine is imported lazily so demo mode never pulls in web3/anchor at startup.
async function makeEngine(
  role: "host" | "challenger",
  duelCode?: string
): Promise<DuelEngine> {
  if (MODE === "onchain") {
    const { OnchainEngine } = await import("./lib/onchain");
    return new OnchainEngine(role, duelCode);
  }
  return new DemoEngine();
}

export default function App() {
  const [engine, setEngine] = useState<DuelEngine | null>(null);
  const [state, setState] = useState<DuelState | null>(null);
  const [booting, setBooting] = useState(false);

  useEffect(() => {
    if (!engine) return;
    const unsub = engine.subscribe(setState);
    return () => {
      unsub();
    };
  }, [engine]);

  const startDemo = useCallback(async () => {
    setBooting(true);
    const e = await makeEngine("host");
    setEngine(e);
    await e.createDuel(DEFAULT_TARGET);
    setBooting(false);
  }, []);

  const startHost = useCallback(async () => {
    setBooting(true);
    const e = await makeEngine("host");
    setEngine(e);
    await e.createDuel(DEFAULT_TARGET);
    setBooting(false);
  }, []);

  const startJoin = useCallback(async (code: string) => {
    setBooting(true);
    const e = await makeEngine("challenger", code.trim());
    setEngine(e);
    await e.joinDuel();
    setBooting(false);
  }, []);

  const reset = useCallback(() => {
    engine?.dispose();
    setEngine(null);
    setState(null);
  }, [engine]);

  if (!engine || !state) {
    return (
      <Home
        onStart={startDemo}
        onHost={startHost}
        onJoin={startJoin}
        booting={booting}
      />
    );
  }
  return <Game engine={engine} state={state} onReset={reset} />;
}

function Home({
  onStart,
  onHost,
  onJoin,
  booting,
}: {
  onStart: () => void;
  onHost: () => void;
  onJoin: (code: string) => void;
  booting: boolean;
}) {
  const [code, setCode] = useState("");
  const onchain = MODE === "onchain";
  return (
    <div className="screen home">
      <div className="glow" />
      <div className="brand">
        <div className="logo">⚡</div>
        <h1>
          Tap-Duel <span>Arena</span>
        </h1>
        <p className="tagline">
          Real-time 1v1 tug-of-war on Solana.
          <br />
          Every tap is a gasless transaction on a MagicBlock Ephemeral Rollup.
        </p>
      </div>

      <div className="pills">
        <span className="pill">~10ms taps</span>
        <span className="pill">0 fees</span>
        <span className="pill">0 wallet popups</span>
      </div>

      {!onchain ? (
        <button className="cta" onClick={onStart} disabled={booting}>
          {booting ? "Setting up…" : "Start a Duel"}
        </button>
      ) : (
        <div className="lobby">
          <button className="cta" onClick={onHost} disabled={booting}>
            {booting ? "Setting up…" : "Host a Duel"}
          </button>
          <div className="join-row">
            <input
              className="code-input"
              placeholder="Paste duel code to join"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              className="cta small"
              onClick={() => onJoin(code)}
              disabled={booting || code.trim().length < 32}
            >
              Join
            </button>
          </div>
        </div>
      )}

      <p className="mode-note">
        Mode: <b>{MODE}</b>
        {MODE === "demo"
          ? " — local simulation, no wallet needed"
          : " — live on Solana devnet via Ephemeral Rollups"}
      </p>
    </div>
  );
}

function Game({
  engine,
  state,
  onReset,
}: {
  engine: DuelEngine;
  state: DuelState;
  onReset: () => void;
}) {
  const [boostCharge, setBoostCharge] = useState(0); // 0..100
  const boostReady = boostCharge >= 100;

  // Charge the VRF boost meter over time.
  useEffect(() => {
    if (state.phase !== "active") return;
    const t = setInterval(() => {
      setBoostCharge((c) => Math.min(100, c + 4));
    }, 200);
    return () => clearInterval(t);
  }, [state.phase]);

  const doTap = useCallback(() => {
    if (state.phase !== "active") return;
    void engine.tap(1);
    haptic(8);
  }, [engine, state.phase]);

  const doBoost = useCallback(() => {
    if (!boostReady || state.phase !== "active") return;
    // A VRF "boost": a random multiplier 3–5. On-chain this comes from MagicBlock VRF; in demo it's
    // rolled locally. Either way it's a single high-power tap.
    const power = 3 + Math.floor(Math.random() * 3);
    void engine.tap(power);
    setBoostCharge(0);
    haptic(30);
  }, [engine, boostReady, state.phase]);

  // rope position as -1..1 for the visualization
  const t = Math.max(-1, Math.min(1, state.rope / (state.target || 1)));
  const flagLeft = 50 + t * 42; // percent

  const won = state.winner === state.mySide;

  return (
    <div className="screen game">
      <header className="hud">
        <div className="hud-item">
          <span className="hud-label">taps/sec</span>
          <span className="hud-value">{state.tapsPerSec}</span>
        </div>
        <div className="hud-item">
          <span className="hud-label">total taps</span>
          <span className="hud-value">{state.tapCount}</span>
        </div>
        <div className="hud-item">
          <span className="hud-label">fees</span>
          <span className="hud-value good">$0.00</span>
        </div>
      </header>

      {state.rpc && (
        <div className={`rpc-bar ${state.rpc.healthy ? "" : "down"}`}>
          <span className={`dot ${state.rpc.healthy ? "ok" : "bad"}`} />
          RPC: <b>{state.rpc.active}</b>
          <span className="rpc-sep">·</span>
          {state.rpc.healthy ? "failover armed" : "degraded"}
          {state.rpc.failovers > 0 && (
            <span className="rpc-sep">· {state.rpc.failovers} failover(s)</span>
          )}
          <span className="rpc-kit">solana-resilience-kit</span>
        </div>
      )}

      <div className="arena">
        <div className="side-label you">YOU</div>
        <div className="side-label them">RIVAL</div>

        <div className="rope-track">
          <div className="center-line" />
          <div
            className="flag"
            style={{ left: `${flagLeft}%` }}
            data-lead={t < -0.02 ? "you" : t > 0.02 ? "them" : "even"}
          >
            🚩
          </div>
        </div>

        <div className="score">
          <span>{Math.max(0, Math.round(-t * 100))}%</span>
          <span className="vs">tug</span>
          <span>{Math.max(0, Math.round(t * 100))}%</span>
        </div>

        {state.note && <div className="note">{state.note}</div>}

        {state.phase === "waiting" &&
          typeof (engine as any).duelCode === "function" && (
            <DuelCode code={(engine as any).duelCode()} />
          )}
      </div>

      <div className="controls">
        <button
          className={`boost ${boostReady ? "ready" : ""}`}
          onClick={doBoost}
          disabled={!boostReady || state.phase !== "active"}
        >
          <span className="boost-fill" style={{ width: `${boostCharge}%` }} />
          <span className="boost-text">
            {boostReady ? "⚡ VRF BOOST" : `charging ${boostCharge}%`}
          </span>
        </button>

        <button
          className="tap-btn"
          onPointerDown={doTap}
          disabled={state.phase !== "active"}
        >
          TAP
        </button>
      </div>

      {(state.phase === "settling" || state.phase === "settled") && (
        <Overlay
          state={state}
          won={won}
          onReset={onReset}
        />
      )}
    </div>
  );
}

function Overlay({
  state,
  won,
  onReset,
}: {
  state: DuelState;
  won: boolean;
  onReset: () => void;
}) {
  const settling = state.phase === "settling";
  return (
    <div className="overlay">
      <div className="card">
        {settling ? (
          <>
            <div className="spinner" />
            <h2>Committing to Solana…</h2>
            <p>Writing the final rope state to the base layer and undelegating.</p>
          </>
        ) : (
          <>
            <h2 className={won ? "win" : "lose"}>
              {won ? "🏆 You win!" : "Rival wins"}
            </h2>
            <p>Final state settled on Solana L1.</p>
            {state.explorerUrl ? (
              <a
                className="explorer"
                href={state.explorerUrl}
                target="_blank"
                rel="noreferrer"
              >
                View settlement on Solana Explorer ↗
              </a>
            ) : (
              <p className="muted">
                (demo mode — deploy the program to get a real explorer link)
              </p>
            )}
            <button className="cta small" onClick={onReset}>
              Play again
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function DuelCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="duel-code">
      <span className="dc-label">Share this duel code:</span>
      <code className="dc-value">{code}</code>
      <button
        className="dc-copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked */
          }
        }}
      >
        {copied ? "Copied ✓" : "Copy"}
      </button>
    </div>
  );
}

function haptic(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
}
