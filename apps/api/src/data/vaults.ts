import { VaultMetric } from "../types.js";

const now = new Date().toISOString();

export const vaults: VaultMetric[] = [
  {
    id: "solend-usdc-main",
    protocolId: "solend",
    protocolName: "Solend",
    poolName: "Main Pool",
    vaultName: "USDC Reserve",
    category: "lending",
    assetSymbol: "USDC",
    assetMint: "EPjFWdd5AufqSSqeM2q9D2v8ZV95yZQxtJvK9ZkqS1U",
    assetDecimals: 6,
    vaultUrl: "https://solend.fi/dashboard?pool=main",
    apyTotal: 5.42,
    apyBase: 4.98,
    apyRewards: 0.44,
    tvlUsd: 212_450_000,
    liquidityUsd: 48_120_000,
    borrowedUsd: 164_330_000,
    utilization: 0.77,
    updatedAt: now
  },
  {
    id: "solend-sol-main",
    protocolId: "solend",
    protocolName: "Solend",
    poolName: "Main Pool",
    vaultName: "SOL Reserve",
    category: "lending",
    assetSymbol: "SOL",
    assetMint: "So11111111111111111111111111111111111111112",
    assetDecimals: 9,
    vaultUrl: "https://solend.fi/dashboard?pool=main",
    apyTotal: 3.18,
    apyBase: 3.18,
    apyRewards: 0,
    tvlUsd: 98_320_000,
    liquidityUsd: 21_670_000,
    borrowedUsd: 76_650_000,
    utilization: 0.74,
    updatedAt: now
  },
  {
    id: "kamino-usdc-main",
    protocolId: "kamino",
    protocolName: "Kamino Lend",
    poolName: "Core Market",
    vaultName: "USDC Reserve",
    category: "lending",
    assetSymbol: "USDC",
    assetMint: "EPjFWdd5AufqSSqeM2q9D2v8ZV95yZQxtJvK9ZkqS1U",
    assetDecimals: 6,
    vaultUrl: "https://app.kamino.finance/lending",
    apyTotal: 6.05,
    apyBase: 5.2,
    apyRewards: 0.85,
    tvlUsd: 143_900_000,
    liquidityUsd: 32_410_000,
    borrowedUsd: 111_490_000,
    utilization: 0.71,
    updatedAt: now
  },
  {
    id: "kamino-sol-main",
    protocolId: "kamino",
    protocolName: "Kamino Lend",
    poolName: "Core Market",
    vaultName: "SOL Reserve",
    category: "lending",
    assetSymbol: "SOL",
    assetMint: "So11111111111111111111111111111111111111112",
    assetDecimals: 9,
    vaultUrl: "https://app.kamino.finance/lending",
    apyTotal: 3.42,
    apyBase: 3.12,
    apyRewards: 0.3,
    tvlUsd: 82_200_000,
    liquidityUsd: 18_900_000,
    borrowedUsd: 63_300_000,
    utilization: 0.77,
    updatedAt: now
  }
];

export const protocols = [
  {
    id: "solend",
    name: "Solend",
    category: "lending"
  },
  {
    id: "kamino",
    name: "Kamino Lend",
    category: "lending"
  }
];
