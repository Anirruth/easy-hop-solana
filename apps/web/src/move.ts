import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { WalletProvider } from "./wallet";
import { VaultMetric } from "./types";

const RPC_URL =
  import.meta.env.VITE_SOLANA_RPC_URL ??
  "https://api.mainnet-beta.solana.com";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

function wrapNetworkError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === "Failed to fetch" || (err instanceof TypeError && msg.includes("fetch"))) {
    throw new Error(`Cannot reach the API at ${API_BASE}. Start it with: cd apps/api && npm run dev`);
  }
  throw err;
}

const readApiError = async (response: Response, fallback: string) => {
  const text = await response.text();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error;
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message;
  } catch {
    // Non-JSON response body.
  }
  return text;
};

type BuiltTransaction = {
  base64: string;
  version: "legacy" | "v0";
  label: string;
};

export type AccountSetupPreview = {
  missingAccounts: Array<{
    mint: string;
    ata: string;
    tokenProgramId: string;
    rentLamports: number;
    kind: "asset" | "shares";
  }>;
  totalRentLamports: number;
  totalRentSol: number;
};

export type FeeDiagnostics = {
  signatureFeeLamports: number;
  priorityFeeLamports: number;
  totalLamports: number;
  transactions: Array<{
    label: string;
    version: "legacy" | "v0";
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: number;
    estimatedPriorityFeeLamports?: number;
    signatureFeeLamports?: number;
    estimatedNetworkFeeLamports?: number;
  }>;
};

export type SolFundQuote = {
  canProceed: boolean;
  reason?: "missing_accounts" | "insufficient_requested_sol";
  requestedLamports: number;
  requestedSol: number;
  swapInputLamports?: number;
  swapInputSol?: number;
  estimatedOutAmount?: number;
  estimatedOutSymbol?: string;
  txPlan?: Array<{ label: string; version: "legacy" | "v0" }>;
  estimatedSetupLamports?: number;
  estimatedSetupAssociatedRentLamports?: number;
  estimatedSetupSystemLamports?: number;
  estimatedSignatureFeeLamports?: number;
  estimatedPriorityFeeLamports?: number;
  estimatedNetworkFeeLamports?: number;
  estimatedTotalDebitLamports?: number;
  estimatedTotalDebitSol?: number;
  missingAccountsCount?: number;
  rentLamports?: number;
  rentSol?: number;
};

export type TransactionProgressEvent = {
  label: string;
  status: "signing" | "sending" | "confirmed" | "failed";
  signature?: string;
  error?: string;
};

export type FundProgressEvent = {
  step: "swap" | "deposit";
  status: "signing" | "sending" | "confirmed" | "failed";
  signature?: string;
  error?: string;
};

const isForbiddenRpc = (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("403") || msg.toLowerCase().includes("forbidden");
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const waitForSignatureConfirmation = async (
  connection: Connection,
  signature: string,
  timeoutMs = 120_000
) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const statuses = await connection.getSignatureStatuses([signature], {
        searchTransactionHistory: true
      });
      const status = statuses.value[0];
      if (status) {
        if (status.err) {
          throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
        }
        if (
          status.confirmationStatus === "confirmed" ||
          status.confirmationStatus === "finalized"
        ) {
          return;
        }
      }
    } catch {
      // Keep polling on transient RPC errors.
    }
    await sleep(1200);
  }

  // Last check before surfacing timeout.
  const statuses = await connection.getSignatureStatuses([signature], {
    searchTransactionHistory: true
  });
  const status = statuses.value[0];
  if (status?.err) {
    throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
  }
  if (
    status &&
    (status.confirmationStatus === "confirmed" ||
      status.confirmationStatus === "finalized")
  ) {
    return;
  }

  throw new Error(
    `Transaction broadcast but not yet confirmed. Check signature ${signature} on Solana Explorer.`
  );
};

const relaySignedTransaction = async (
  base64: string,
  version: "legacy" | "v0"
): Promise<string | undefined> => {
  const response = await fetch(`${API_BASE}/transactions/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, version })
  });
  if (!response.ok) {
    throw new Error(await readApiError(response, "Failed to relay transaction."));
  }
  try {
    const json = (await response.json()) as { data?: { signature?: string } };
    return json.data?.signature;
  } catch {
    return undefined;
  }
};

const sendSignedTransaction = async (
  connection: Connection,
  signed: Transaction | VersionedTransaction,
  version: "legacy" | "v0"
): Promise<string | undefined> => {
  try {
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });
    await waitForSignatureConfirmation(connection, signature);
    return signature;
  } catch (err) {
    if (isForbiddenRpc(err)) {
      const base64 = Buffer.from(signed.serialize()).toString("base64");
      return relaySignedTransaction(base64, version);
    }
    throw err;
  }
};

const deserializeBuiltTransaction = (entry: BuiltTransaction) => {
  const buffer = Buffer.from(entry.base64, "base64");
  return entry.version === "v0"
    ? VersionedTransaction.deserialize(buffer)
    : Transaction.from(buffer);
};

const applyLatestBlockhash = async (
  connection: Connection,
  provider: WalletProvider,
  txs: Array<Transaction | VersionedTransaction>
) => {
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  txs.forEach((tx) => {
    if (tx instanceof Transaction) {
      tx.recentBlockhash = blockhash;
      tx.feePayer = provider.publicKey!;
      return;
    }
    (tx.message as { recentBlockhash?: string }).recentBlockhash = blockhash;
  });
};

const executeBuiltTransactions = async (
  provider: WalletProvider,
  entries: BuiltTransaction[],
  onProgress?: (event: TransactionProgressEvent) => void,
  options: { batchSign?: boolean } = {}
) => {
  const batchSign = options.batchSign ?? true;
  const connection = new Connection(RPC_URL, "confirmed");
  const txs = entries.map(deserializeBuiltTransaction);

  entries.forEach((entry) => onProgress?.({ label: entry.label, status: "signing" }));

  if (batchSign && provider.signAllTransactions) {
    await applyLatestBlockhash(connection, provider, txs);
    const signed = (await provider.signAllTransactions(
      txs as Array<Transaction | VersionedTransaction>
    )) as Array<Transaction | VersionedTransaction>;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const tx = signed[index];
      onProgress?.({ label: entry.label, status: "sending" });
      try {
        const signature = await sendSignedTransaction(connection, tx, entry.version);
        onProgress?.({ label: entry.label, status: "confirmed", signature });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        onProgress?.({ label: entry.label, status: "failed", error: message });
        throw err;
      }
    }
    return;
  }

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const tx = txs[index];
    await applyLatestBlockhash(connection, provider, [tx]);
    const signed = await provider.signTransaction(tx);
    onProgress?.({ label: entry.label, status: "sending" });
    try {
      const signature = await sendSignedTransaction(connection, signed, entry.version);
      onProgress?.({ label: entry.label, status: "confirmed", signature });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onProgress?.({ label: entry.label, status: "failed", error: message });
      throw err;
    }
  }
};

export const moveFunds = async (
  provider: WalletProvider,
  fromVault: VaultMetric,
  toVault: VaultMetric,
  amount: number,
  slippagePct?: number,
  priorityFeeMode?: "auto" | "low" | "off",
  debugFee?: boolean,
  onProgress?: (event: TransactionProgressEvent) => void
) => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromVaultId: fromVault.id,
        toVaultId: toVault.id,
        amount,
        walletAddress: provider.publicKey!.toBase58(),
        slippagePct,
        priorityFeeMode,
        debugFee
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to build move transactions."));
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[]; feeDiagnostics?: FeeDiagnostics };
  };
  if (!json.data.transactions.length) {
    throw new Error("No transactions were built for this move.");
  }
  await executeBuiltTransactions(provider, json.data.transactions, onProgress);
  return json.data.feeDiagnostics ?? null;
};

export const depositFunds = async (
  provider: WalletProvider,
  vault: VaultMetric,
  amount: number,
  slippagePct?: number,
  priorityFeeMode?: "auto" | "low" | "off",
  debugFee?: boolean
) => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/deposit/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        amount,
        walletAddress: provider.publicKey!.toBase58(),
        slippagePct,
        priorityFeeMode,
        debugFee
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to build deposit transactions."));
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[]; feeDiagnostics?: FeeDiagnostics };
  };
  if (!json.data.transactions.length) {
    throw new Error("No transactions were built for this deposit.");
  }
  await executeBuiltTransactions(provider, json.data.transactions);
  return json.data.feeDiagnostics ?? null;
};

export const depositFundsFromSol = async (
  provider: WalletProvider,
  vault: VaultMetric,
  amountSol: number,
  slippagePct?: number,
  priorityFeeMode?: "auto" | "low" | "off",
  debugFee?: boolean,
  onProgress?: (event: FundProgressEvent) => void
) => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/deposit/sol/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        amountSol,
        walletAddress: provider.publicKey!.toBase58(),
        slippagePct,
        priorityFeeMode,
        debugFee
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to build SOL deposit transactions."));
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[]; feeDiagnostics?: FeeDiagnostics };
  };
  if (!json.data.transactions.length) {
    throw new Error("No transactions were built for this SOL deposit.");
  }
  await executeBuiltTransactions(provider, json.data.transactions, (event) => {
    const label = event.label.toLowerCase();
    const step = label.includes("swap")
      ? "swap"
      : label.includes("deposit")
        ? "deposit"
        : null;
    if (!step) return;
    onProgress?.({
      step,
      status: event.status,
      signature: event.signature,
      error: event.error
    });
  }, { batchSign: false });
  return json.data.feeDiagnostics ?? null;
};

export const previewSolFundQuote = async (
  provider: WalletProvider,
  vault: VaultMetric,
  amountSol: number,
  slippagePct?: number,
  priorityFeeMode?: "auto" | "low" | "off"
): Promise<SolFundQuote> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/deposit/sol/quote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        amountSol,
        walletAddress: provider.publicKey!.toBase58(),
        slippagePct,
        priorityFeeMode
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to quote SOL deposit."));
  }

  const json = (await response.json()) as {
    data: SolFundQuote;
  };
  return json.data;
};

export const withdrawFunds = async (
  provider: WalletProvider,
  vault: VaultMetric,
  amount: number,
  destination: "asset" | "sol",
  slippagePct?: number,
  priorityFeeMode?: "auto" | "low" | "off",
  debugFee?: boolean,
  onProgress?: (event: TransactionProgressEvent) => void
) => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/withdraw/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        amount,
        destination,
        walletAddress: provider.publicKey!.toBase58(),
        slippagePct,
        priorityFeeMode,
        debugFee
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to build withdraw transactions."));
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[]; feeDiagnostics?: FeeDiagnostics };
  };
  if (!json.data.transactions.length) {
    throw new Error("No transactions were built for this withdraw.");
  }
  await executeBuiltTransactions(provider, json.data.transactions, onProgress);
  return json.data.feeDiagnostics ?? null;
};

export const previewDepositAccounts = async (
  vault: VaultMetric,
  walletAddress: string
): Promise<AccountSetupPreview> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/accounts/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vaultId: vault.id, walletAddress })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to preview account setup."));
  }

  const json = (await response.json()) as {
    data: AccountSetupPreview;
  };
  return json.data;
};

export const createDepositAccounts = async (
  provider: WalletProvider,
  vault: VaultMetric
): Promise<AccountSetupPreview> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/accounts/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        walletAddress: provider.publicKey!.toBase58()
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to create token accounts."));
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[] } & AccountSetupPreview;
  };
  await executeBuiltTransactions(provider, json.data.transactions);

  return json.data;
};

export const closeTokenAccounts = async (
  provider: WalletProvider,
  vault: VaultMetric,
  debugFee?: boolean
): Promise<FeeDiagnostics | null> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/accounts/close`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        walletAddress: provider.publicKey!.toBase58(),
        debugFee
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to build close-account transaction."));
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[]; feeDiagnostics?: FeeDiagnostics };
  };
  if (!json.data.transactions.length) {
    throw new Error("No close-account transaction was built.");
  }
  await executeBuiltTransactions(provider, json.data.transactions);
  return json.data.feeDiagnostics ?? null;
};

export const swapAssetToSol = async (
  provider: WalletProvider,
  inputMint: string,
  amountLamports: number,
  slippagePct?: number,
  priorityFeeMode?: "auto" | "low" | "off",
  debugFee?: boolean,
  onProgress?: (event: TransactionProgressEvent) => void
): Promise<FeeDiagnostics | null> => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/swap/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        walletAddress: provider.publicKey!.toBase58(),
        inputMint,
        amountLamports,
        slippagePct,
        priorityFeeMode,
        debugFee
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    throw new Error(await readApiError(response!, "Failed to build swap transaction."));
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[]; feeDiagnostics?: FeeDiagnostics };
  };
  if (!json.data.transactions.length) {
    throw new Error("No swap transaction was built.");
  }
  await executeBuiltTransactions(provider, json.data.transactions, onProgress);
  return json.data.feeDiagnostics ?? null;
};
