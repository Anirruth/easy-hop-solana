export type ProtocolId = "solend" | "kamino";

export type VaultCategory = "lending";

export type VaultMetric = {
  id: string;
  protocolId: ProtocolId;
  protocolName: string;
  poolName: string;
  vaultName: string;
  category: VaultCategory;
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

export type VaultHistoryPoint = {
  timestamp: string;
  apyTotal: number;
  tvlUsd: number;
};

export type MoveRequest = {
  fromVaultId: string;
  toVaultId: string;
  amount: number;
  walletAddress: string;
  slippagePct?: number;
  priorityFeeMode?: "auto" | "low" | "off";
  debugFee?: boolean;
};

export type MoveResponse = {
  requestId: string;
  message: string;
  fromVaultId: string;
  toVaultId: string;
  amount: number;
};

export type VaultPosition = {
  vaultId: string;
  depositedAmount: number;
  availableAmount: number;
};
