import { Connection } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const FALLBACK_RPC_URL =
  process.env.SOLANA_RPC_FALLBACK_URL ?? "https://api.mainnet-beta.solana.com";

export const createRpcConnection = (url: string) =>
  new Connection(url, {
    commitment: "confirmed",
    disableRetryOnRateLimit: true
  });

export const getPrimaryConnection = () => createRpcConnection(RPC_URL);

export const getFallbackConnection = () =>
  FALLBACK_RPC_URL && FALLBACK_RPC_URL !== RPC_URL
    ? createRpcConnection(FALLBACK_RPC_URL)
    : null;
