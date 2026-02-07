import {
  createDefaultRpcTransport,
  createRpc,
  createSolanaRpcApi,
  DEFAULT_RPC_CONFIG,
  address
} from "@solana/kit";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const FALLBACK_RPC_URL =
  process.env.SOLANA_RPC_FALLBACK_URL ?? "https://api.mainnet-beta.solana.com";

export const KAMINO_MAINNET_MARKET = address("7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF");
export const KAMINO_RECENT_SLOT_MS = 400;

let rpcCache: ReturnType<typeof createRpc> | null = null;
let rpcFallbackCache: ReturnType<typeof createRpc> | null = null;

export const getKaminoRpc = (useFallback = false) => {
  if (useFallback) {
    if (!rpcFallbackCache) {
      const api = createSolanaRpcApi({
        ...DEFAULT_RPC_CONFIG,
        defaultCommitment: "confirmed"
      });
      const transport = createDefaultRpcTransport({ url: FALLBACK_RPC_URL });
      rpcFallbackCache = createRpc({ api, transport });
    }
    return rpcFallbackCache;
  }
  if (!rpcCache) {
    const api = createSolanaRpcApi({
      ...DEFAULT_RPC_CONFIG,
      defaultCommitment: "confirmed"
    });
    const transport = createDefaultRpcTransport({ url: RPC_URL });
    rpcCache = createRpc({ api, transport });
  }
  return rpcCache;
};

export const toKaminoAddress = (value: string) => address(value);
