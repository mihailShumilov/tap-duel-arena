// Runtime configuration. Flip VITE_MODE to "onchain" (and deploy the program) to run against real
// Ephemeral Rollups. Defaults to "demo" so `npm run dev` works instantly with no wallet or deploy.

export const MODE: "demo" | "onchain" =
  (import.meta.env.VITE_MODE as "demo" | "onchain") || "demo";

// Solana + MagicBlock endpoints. Devnet is free and is what the hackathon demo should target.
export const RPC = {
  // The Magic Router auto-routes each tx to the ER (delegated accounts) or the base layer.
  router:
    import.meta.env.VITE_ROUTER_RPC || "https://devnet-router.magicblock.app",
  // Base-layer devnet (used for create/join/delegate and for explorer links).
  base: import.meta.env.VITE_BASE_RPC || "https://api.devnet.solana.com",
  // Optional extra failover endpoint for the resilience pool (e.g. a QuickNode devnet URL).
  quicknode: import.meta.env.VITE_QUICKNODE_RPC || "",
};

// Program ID — replace after `anchor keys sync` / deploy. Also update declare_id! in the program.
export const PROGRAM_ID =
  import.meta.env.VITE_PROGRAM_ID ||
  "BmDc7HBxBt5bZLFz6UJ24mdHYr7DQfFw7eSnpo3HamQ6";

export function explorerTx(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}

export function explorerAddress(addr: string): string {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}
