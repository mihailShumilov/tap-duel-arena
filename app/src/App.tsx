import { useCallback, useEffect, useState } from "react";
import { DemoEngine } from "./lib/demo";
import { DuelEngine, DuelState, DEFAULT_TARGET } from "./lib/engine";
import { MODE } from "./lib/config";
import type { AppWallet } from "./lib/wallet";

export default function App() {
  const [engine, setEngine] = useState<DuelEngine | null>(null);
  const [state, setState] = useState<DuelState | null>(null);
  const [booting, setBooting] = useState(false);
  const [wallet, setWallet] = useState<AppWallet | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!engine) return;
    const unsub = engine.subscribe(setState);
    return () => unsub();
  }, [engine]);

  const startDemo = useCallback(async () => {
    setBooting(true);
    const e = new DemoEngine();
    setEngine(e);
    await e.createDuel(DEFAULT_TARGET);
    setBooting(false);
  }, []);

  const connectWallet = useCallback(async (kind: "injected" | "burner") => {
    setErr(null);
    try {
      const w = await import("./lib/wallet");
      setWallet(kind === "injected" ? await w.connectInjected() : w.burnerWallet());
    } catch (e: any) {
      setErr(e?.message || "Could not connect wallet");
    }
  }, []);

  const quickMatch = useCallback(async () => {
    if (!wallet) return;
    setBooting(true);
    setErr(null);
    try {
      const { OnchainEngine } = await import("./lib/onchain");
      const e = new OnchainEngine(wallet);
      setEngine(e);
      await e.quickMatch();
    } catch (e: any) {
      setErr(e?.message || "Match failed — check your devnet balance");
    }
    setBooting(false);
  }, [wallet]);

  const reset = useCallback(() => {
    engine?.dispose();
    setEngine(null);
    setState(null);
  }, [engine]);

  if (!engine || !state) {
    return (
      <Home
        booting={booting}
        wallet={wallet}
        err={err}
        onStartDemo={startDemo}
        onConnect={connectWallet}
        onQuickMatch={quickMatch}
      />
    );
  }
  return <Game engine={engine} state={state} onReset={reset} />;
}

function Home({
  booting,
  wallet,
  err,
  onStartDemo,
  onConnect,
  onQuickMatch,
}: {
  booting: boolean;
  wallet: AppWallet | null;
  err: string | null;
  onStartDemo: () => void;
  onConnect: (kind: "injected" | "burner") => void;
  onQuickMatch: () => void;
}) {
  const onchain = MODE === "onchain";
  const [hasInjected, setHasInjected] = useState(false);
  useEffect(() => {
    if (!onchain) return;
    import("./lib/wallet").then((w) => setHasInjected(w.hasInjectedWallet()));
  }, [onchain]);

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
        <button className="cta" onClick={onStartDemo} disabled={booting}>
          {booting ? "Setting up…" : "Start a Duel"}
        </button>
      ) : (
        <div className="lobby">
          {!wallet ? (
            <>
              {hasInjected && (
                <button className="cta" onClick={() => onConnect("injected")}>
                  Connect Wallet
                </button>
              )}
              <button
                className={hasInjected ? "cta small" : "cta"}
                onClick={() => onConnect("burner")}
              >
                {hasInjected ? "Use a burner wallet" : "Create burner wallet"}
              </button>
              {!hasInjected && (
                <p className="mode-note">
                  No wallet extension detected — a local devnet burner will be used.
                </p>
              )}
            </>
          ) : (
            <>
              <WalletChip wallet={wallet} />
              <button className="cta" onClick={onQuickMatch} disabled={booting}>
                {booting ? "Matching…" : "⚔️ Quick Match"}
              </button>
              <p className="mode-note">
                Auto-joins the nearest open duel — or opens yours and waits.
              </p>
            </>
          )}
          {err && <p className="wallet-err">{err}</p>}
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

function WalletChip({ wallet }: { wallet: AppWallet }) {
  const [bal, setBal] = useState<number | null>(null);
  const addr = wallet.publicKey.toBase58();
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [{ getBalanceSol }, web3, { RPC }] = await Promise.all([
          import("./lib/wallet"),
          import("@solana/web3.js"),
          import("./lib/config"),
        ]);
        const c = new web3.Connection(RPC.base, "confirmed");
        const b = await getBalanceSol(c, wallet.publicKey);
        if (live) setBal(b);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      live = false;
    };
  }, [wallet]);
  return (
    <div className="wallet-chip">
      <span className="dot ok" />
      <b>{wallet.label}</b>
      <span className="wc-addr">
        {addr.slice(0, 4)}…{addr.slice(-4)}
      </span>
      <span className="wc-bal">
        {bal === null ? "…" : `${bal.toFixed(3)} SOL`}
      </span>
      {bal === 0 && (
        <a
          className="wc-faucet"
          href="https://faucet.solana.com"
          target="_blank"
          rel="noreferrer"
        >
          fund
        </a>
      )}
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

      {state.wallet && (
        <div className="rpc-bar">
          <span className="dot ok" />
          Wallet: <b>{state.wallet.label}</b>
          <span className="rpc-sep">
            {state.wallet.address.slice(0, 4)}…{state.wallet.address.slice(-4)}
          </span>
          {state.wallet.balanceSol !== null && (
            <span className="rpc-sep">· {state.wallet.balanceSol.toFixed(3)} SOL</span>
          )}
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

        {state.phase === "waiting" && <div className="spinner small" />}
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

      {state.phase === "error" && (
        <div className="overlay">
          <div className="card">
            <h2 className="lose">Couldn't start the match</h2>
            <p>{state.note}</p>
            <button className="cta small" onClick={onReset}>
              Back
            </button>
          </div>
        </div>
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

function haptic(ms: number) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* not supported */
  }
}
