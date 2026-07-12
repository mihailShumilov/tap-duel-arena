// Node globals that @solana/web3.js + @coral-xyz/anchor expect in the browser. Must run before any
// Solana code loads (PublicKey.toBuffer(), BN encoding, etc. reference `Buffer`).
import { Buffer } from "buffer";
if (!(globalThis as any).Buffer) (globalThis as any).Buffer = Buffer;
if (!(globalThis as any).global) (globalThis as any).global = globalThis;

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
