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

type BuiltTransaction = {
  base64: string;
  version: "legacy" | "v0";
  label: string;
};

const isForbiddenRpc = (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("403") || msg.toLowerCase().includes("forbidden");
};

const relaySignedTransaction = async (base64: string, version: "legacy" | "v0") => {
  const response = await fetch(`${API_BASE}/transactions/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, version })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Failed to relay transaction.");
  }
};

const sendSignedTransaction = async (
  connection: Connection,
  signed: Transaction | VersionedTransaction,
  version: "legacy" | "v0"
) => {
  try {
    const signature = await connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });
    await connection.confirmTransaction(signature, "confirmed");
  } catch (err) {
    if (isForbiddenRpc(err)) {
      const base64 = Buffer.from(signed.serialize()).toString("base64");
      await relaySignedTransaction(base64, version);
      return;
    }
    throw err;
  }
};

export const moveFunds = async (
  provider: WalletProvider,
  fromVault: VaultMetric,
  toVault: VaultMetric,
  amount: number
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
        walletAddress: provider.publicKey!.toBase58()
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Failed to build move transactions.");
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[] };
  };
  if (!json.data.transactions.length) {
    throw new Error("No transactions were built for this move.");
  }

  const connection = new Connection(RPC_URL, "confirmed");
  for (const entry of json.data.transactions) {
    const buffer = Buffer.from(entry.base64, "base64");
    const tx =
      entry.version === "v0"
        ? VersionedTransaction.deserialize(buffer)
        : Transaction.from(buffer);
    const signed = await provider.signTransaction(tx);
    await sendSignedTransaction(connection, signed, entry.version);
  }
};

export const depositFunds = async (
  provider: WalletProvider,
  vault: VaultMetric,
  amount: number
) => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/deposit/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        amount,
        walletAddress: provider.publicKey!.toBase58()
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Failed to build deposit transactions.");
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[] };
  };
  if (!json.data.transactions.length) {
    throw new Error("No transactions were built for this deposit.");
  }

  const connection = new Connection(RPC_URL, "confirmed");
  for (const entry of json.data.transactions) {
    const buffer = Buffer.from(entry.base64, "base64");
    const tx =
      entry.version === "v0"
        ? VersionedTransaction.deserialize(buffer)
        : Transaction.from(buffer);
    const signed = await provider.signTransaction(tx);
    await sendSignedTransaction(connection, signed, entry.version);
  }
};

export const depositFundsFromSol = async (
  provider: WalletProvider,
  vault: VaultMetric,
  amountSol: number
) => {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/move/deposit/sol/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vaultId: vault.id,
        amountSol,
        walletAddress: provider.publicKey!.toBase58()
      })
    });
  } catch (err) {
    wrapNetworkError(err);
  }

  if (!response!.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Failed to build SOL deposit transactions.");
  }

  const json = (await response.json()) as {
    data: { transactions: BuiltTransaction[] };
  };
  if (!json.data.transactions.length) {
    throw new Error("No transactions were built for this SOL deposit.");
  }

  const connection = new Connection(RPC_URL, "confirmed");
  for (const entry of json.data.transactions) {
    const buffer = Buffer.from(entry.base64, "base64");
    const tx =
      entry.version === "v0"
        ? VersionedTransaction.deserialize(buffer)
        : Transaction.from(buffer);
    const signed = await provider.signTransaction(tx);
    await sendSignedTransaction(connection, signed, entry.version);
  }
};
