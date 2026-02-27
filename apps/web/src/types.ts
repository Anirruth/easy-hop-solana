export type ProtocolId = "solend" | "kamino";

export type VaultMetric = {
  id: string;
  protocolId: ProtocolId;
  protocolName: string;
  poolName: string;
  vaultName: string;
  category: "lending";
  assetSymbol: string;
  assetMint: string;
  assetDecimals: number;
  sharesMint?: string;
  vaultUrl: string;
  apyTotal: number;
  apyBase: number;
  apyRewards: number;
  tvlUsd: number;
  liquidityUsd: number;
  borrowedUsd: number;
  utilization: number;
  updatedAt: string;
};

export type MovePayload = {
  fromVaultId: string;
  toVaultId: string;
  amount: number;
  walletAddress: string;
  slippagePct?: number;
  priorityFeeMode?: "auto" | "low" | "off";
};

export type VaultPosition = {
  vaultId: string;
  depositedAmount: number;
  availableAmount: number;
};
