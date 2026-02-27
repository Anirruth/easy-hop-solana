import { Router } from "express";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  ACCOUNT_SIZE,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccountLenForMint,
  getAssociatedTokenAddress,
  getMint
} from "@solana/spl-token";
import {
  fetchPoolMetadata,
  fetchPools,
  getProgramId,
  SolendActionCore
} from "@solendprotocol/solend-sdk";
import SwitchboardProgram from "@switchboard-xyz/sbv2-lite";
import { MoveRequest, VaultMetric } from "../types.js";
import { getLiveVaults, parseVaultId } from "../services/vaults.js";
import { loadSwitchboardProgram } from "../services/solend.js";
import { getKaminoRpc, toKaminoAddress } from "../services/kamino.js";
import { KaminoVault } from "@kamino-finance/klend-sdk";

export const moveRouter = Router();

import { getPrimaryConnection } from "../services/rpc.js";
const LEGACY_JUPITER_API = "https://quote-api.jup.ag/v6";
const JUPITER_API_BASE =
  process.env.JUPITER_API_BASE?.trim() || "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const DEFAULT_SLIPPAGE_BPS = 50;
const LOW_PRIORITY_FEE_MICRO_LAMPORTS = 1_000;
const BASE_SIGNATURE_FEE_LAMPORTS = 5_000;
const SOL_MINT = "So11111111111111111111111111111111111111112";
const SOL_DECIMALS = 9;
const KAMINO_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent": "EasyHopSolana/1.0",
  Referer: "https://kamino.com/"
};

type BuiltTransaction = {
  base64: string;
  version: "legacy" | "v0";
  label: string;
};

const toBaseUnits = (amount: number, decimals: number) =>
  Math.round(amount * 10 ** decimals);

const applyRecentBlockhash = async (
  connection: Connection,
  txs: Transaction[],
  feePayer: PublicKey
) => {
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  txs.forEach((tx) => {
    tx.recentBlockhash = blockhash;
    tx.feePayer = feePayer;
  });
};

const serializeTx = (
  tx: Transaction | VersionedTransaction,
  label: string
): BuiltTransaction => {
  if (tx instanceof Transaction) {
    const base64 = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
    return { base64, version: "legacy", label };
  }
  return { base64: Buffer.from(tx.serialize()).toString("base64"), version: "v0", label };
};

const extractTransactions = (action: Record<string, unknown>) => {
  const candidates = [
    "setupTransaction",
    "lendingTransaction",
    "cleanupTransaction",
    "transaction"
  ];
  return candidates
    .map((key) => action[key])
    .filter(Boolean) as Transaction[];
};

const buildSolendTxs = async (
  connection: Connection,
  user: PublicKey,
  vault: VaultMetric,
  amount: number,
  direction: "deposit" | "withdraw"
) => {
  const parsed = parseVaultId(vault.id);
  if (!parsed || parsed.protocolId !== "solend") {
    throw new Error("Invalid Solend vault id");
  }
  const amountBase = toBaseUnits(amount, vault.assetDecimals).toString();
  const programId = getProgramId("production");
  const [poolMetadataRaw, slot, switchboardProgramRaw] = await Promise.all([
    fetchPoolMetadata(connection, "production"),
    connection.getSlot("confirmed"),
    loadSwitchboardProgram(connection)
  ]);
  const switchboardProgram = switchboardProgramRaw as SwitchboardProgram;
  const rawList = Array.isArray(poolMetadataRaw) ? poolMetadataRaw : [];
  const poolMetadata = rawList.filter(
    (p: { address?: string }) => p && typeof p.address === "string"
  ) as unknown as Parameters<typeof fetchPools>[0];
  if (!poolMetadata.length) {
    throw new Error("Solend pools not found");
  }
  const pools = await fetchPools(
    poolMetadata,
    connection,
    switchboardProgram,
    programId.toBase58(),
    slot,
    true
  );
  const pool = pools[parsed.poolAddress];
  if (!pool) {
    throw new Error("Solend pool not found");
  }
  const reserve = pool.reserves.find((item) => item.address === parsed.reserveAddress);
  if (!reserve) {
    throw new Error("Solend reserve not found");
  }
  const poolInput = {
    address: pool.address,
    owner: pool.owner,
    name: pool.name,
    authorityAddress: pool.authorityAddress,
    reserves: pool.reserves.map((item) => ({
      address: item.address,
      pythOracle: item.pythOracle,
      switchboardOracle: item.switchboardOracle,
      mintAddress: item.mintAddress,
      liquidityFeeReceiverAddress: item.liquidityFeeReceiverAddress,
      extraOracle: item.extraOracle
    }))
  };
  const reserveInput = {
    address: reserve.address,
    liquidityAddress: reserve.liquidityAddress,
    cTokenMint: reserve.cTokenMint,
    cTokenLiquidityAddress: reserve.cTokenLiquidityAddress,
    pythOracle: reserve.pythOracle,
    switchboardOracle: reserve.switchboardOracle,
    mintAddress: reserve.mintAddress,
    liquidityFeeReceiverAddress: reserve.liquidityFeeReceiverAddress
  };
  const wallet = { publicKey: user };
  const action =
    direction === "deposit"
      ? await SolendActionCore.buildDepositTxns(
          poolInput,
          reserveInput,
          connection,
          amountBase,
          wallet,
          { environment: "production" }
        )
      : await SolendActionCore.buildWithdrawTxns(
          poolInput,
          reserveInput,
          connection,
          amountBase,
          wallet,
          { environment: "production" }
        );
  const blockhash = await connection.getLatestBlockhash("finalized");
  const txGroup = await action.getTransactions(blockhash);
  const txs: Array<Transaction | VersionedTransaction> = [];
  if (txGroup.pullPriceTxns?.length) {
    txs.push(...txGroup.pullPriceTxns);
  }
  if (txGroup.preLendingTxn) {
    txs.push(txGroup.preLendingTxn);
  }
  if (txGroup.lendingTxn) {
    txs.push(txGroup.lendingTxn);
  }
  if (txGroup.postLendingTxn) {
    txs.push(txGroup.postLendingTxn);
  }
  return txs;
};

const buildKaminoTxs = async (
  connection: Connection,
  user: PublicKey,
  vault: VaultMetric,
  amount: number,
  direction: "deposit" | "withdraw",
  priorityFeeMicroLamports?: number
) => {
  const rawId =
    typeof vault.id === "string" ? vault.id : (vault.id as { toString?: () => string })?.toString?.() ?? "";
  const kvaultAddress = rawId.split(":")[1];
  if (!kvaultAddress) {
    throw new Error("Invalid Kamino vault id");
  }
  const endpoint =
    direction === "deposit" ? "deposit" : "withdraw";
  const url = `https://api.kamino.finance/ktx/kvault/${endpoint}`;
  const requestBody: Record<string, unknown> = {
    wallet: user.toBase58(),
    kvault: kvaultAddress,
    amount: amount.toString()
  };
  if (priorityFeeMicroLamports !== undefined) {
    requestBody.computeUnitPriceMicroLamports = priorityFeeMicroLamports;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: KAMINO_HEADERS,
      body: JSON.stringify(requestBody)
    });
    if (!response.ok && priorityFeeMicroLamports !== undefined) {
      response = await fetch(url, {
        method: "POST",
        headers: KAMINO_HEADERS,
        body: JSON.stringify({
          wallet: user.toBase58(),
          kvault: kvaultAddress,
          amount: amount.toString()
        })
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Kamino API ${endpoint} fetch failed: ${msg}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Kamino API ${endpoint} failed (${response.status}): ${text || response.statusText}`
    );
  }
  const { transaction } = (await response.json()) as { transaction?: string };
  if (!transaction) {
    throw new Error("Kamino API did not return a transaction.");
  }
  const txBuffer = Buffer.from(transaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuffer);
  stripComputeUnitPrice(tx, priorityFeeMicroLamports === 0);
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.message.recentBlockhash = blockhash;
  return [tx];
};

const isNetworkFetchError = (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("fetch failed") || msg.includes("ENOTFOUND");
};

const toSlippageBps = (value?: number) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SLIPPAGE_BPS;
  return Math.min(10000, Math.round(parsed * 100));
};

const toPriorityFeeMicroLamports = (mode?: unknown) => {
  if (mode === "off") return 0;
  if (mode === "low") return LOW_PRIORITY_FEE_MICRO_LAMPORTS;
  return undefined;
};

const stripComputeUnitPrice = (
  tx: Transaction | VersionedTransaction,
  shouldStrip: boolean
) => {
  if (!shouldStrip) return tx;
  if (tx instanceof Transaction) {
    tx.instructions = tx.instructions.filter((ix) => {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) return true;
      return ix.data?.[0] !== 3;
    });
    return tx;
  }

  const message = tx.message as any;
  const staticKeys: PublicKey[] = message.staticAccountKeys ?? [];
  const compiled = message.compiledInstructions ?? [];
  const filtered = compiled.filter((ix: { programIdIndex: number; data: Uint8Array }) => {
    const programId = staticKeys[ix.programIdIndex];
    if (!programId) return true;
    if (!programId.equals(ComputeBudgetProgram.programId)) return true;
    return ix.data?.[0] !== 3;
  });
  if (filtered.length !== compiled.length) {
    message.compiledInstructions = filtered;
  }
  return tx;
};

const extractComputeBudget = (tx: Transaction | VersionedTransaction) => {
  let computeUnitLimit: number | undefined;
  let computeUnitPriceMicroLamports: number | undefined;

  const readInstruction = (data: Uint8Array) => {
    if (!data?.length) return;
    const tag = data[0];
    if (tag === 2 && data.length >= 5) {
      computeUnitLimit = Buffer.from(data).readUInt32LE(1);
    }
    if (tag === 3 && data.length >= 9) {
      computeUnitPriceMicroLamports = Number(Buffer.from(data).readBigUInt64LE(1));
    }
  };

  if (tx instanceof Transaction) {
    tx.instructions.forEach((ix) => {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) return;
      readInstruction(ix.data);
    });
    return { computeUnitLimit, computeUnitPriceMicroLamports };
  }

  const message = tx.message as any;
  const staticKeys: PublicKey[] = message.staticAccountKeys ?? [];
  const compiled = message.compiledInstructions ?? [];
  compiled.forEach((ix: { programIdIndex: number; data: Uint8Array }) => {
    const programId = staticKeys[ix.programIdIndex];
    if (!programId || !programId.equals(ComputeBudgetProgram.programId)) return;
    readInstruction(ix.data);
  });
  return { computeUnitLimit, computeUnitPriceMicroLamports };
};

const buildFeeDiagnostics = (entries: BuiltTransaction[]): FeeDiagnostics => {
  return {
    transactions: entries.map((entry) => {
      try {
        const buffer = Buffer.from(entry.base64, "base64");
        const tx =
          entry.version === "v0"
            ? VersionedTransaction.deserialize(buffer)
            : Transaction.from(buffer);
        const { computeUnitLimit, computeUnitPriceMicroLamports } =
          extractComputeBudget(tx);
        const estimatedPriorityFeeLamports =
          computeUnitLimit && computeUnitPriceMicroLamports
            ? Math.ceil((computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000)
            : undefined;
        return {
          label: entry.label,
          version: entry.version,
          computeUnitLimit,
          computeUnitPriceMicroLamports,
          estimatedPriorityFeeLamports
        };
      } catch {
        return { label: entry.label, version: entry.version };
      }
    })
  };
};

const estimateTransactionCostLamports = (entries: BuiltTransaction[]) => {
  let signatureFeeLamports = 0;
  let priorityFeeLamports = 0;

  entries.forEach((entry) => {
    try {
      const buffer = Buffer.from(entry.base64, "base64");
      const tx =
        entry.version === "v0"
          ? VersionedTransaction.deserialize(buffer)
          : Transaction.from(buffer);

      const signatures =
        tx instanceof Transaction
          ? Math.max(1, tx.signatures?.length || 1)
          : Math.max(
              1,
              ((tx.message as unknown as { header?: { numRequiredSignatures?: number } })
                .header?.numRequiredSignatures ?? 1)
            );
      signatureFeeLamports += signatures * BASE_SIGNATURE_FEE_LAMPORTS;

      const { computeUnitLimit, computeUnitPriceMicroLamports } =
        extractComputeBudget(tx);
      if (computeUnitLimit && computeUnitPriceMicroLamports) {
        priorityFeeLamports += Math.ceil(
          (computeUnitLimit * computeUnitPriceMicroLamports) / 1_000_000
        );
      }
    } catch {
      signatureFeeLamports += BASE_SIGNATURE_FEE_LAMPORTS;
    }
  });

  return {
    signatureFeeLamports,
    priorityFeeLamports,
    totalLamports: signatureFeeLamports + priorityFeeLamports
  };
};

const readU64AsNumber = (data: Uint8Array, offset: number) => {
  if (!data || data.length < offset + 8) return 0;
  return Number(Buffer.from(data).readBigUInt64LE(offset));
};

const decodeSystemLamportsDebit = (data: Uint8Array) => {
  if (!data || data.length < 4) return 0;
  const tag = Buffer.from(data).readUInt32LE(0);
  if (tag === 0 || tag === 2) {
    return readU64AsNumber(data, 4);
  }
  return 0;
};

const estimateEmbeddedSetupLamports = async (
  connection: Connection,
  user: PublicKey,
  entries: BuiltTransaction[]
) => {
  let associatedTokenCreates = 0;
  let explicitSystemLamports = 0;

  entries.forEach((entry) => {
    const buffer = Buffer.from(entry.base64, "base64");
    const tx =
      entry.version === "v0"
        ? VersionedTransaction.deserialize(buffer)
        : Transaction.from(buffer);

    if (tx instanceof Transaction) {
      tx.instructions.forEach((ix) => {
        if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
          associatedTokenCreates += 1;
          return;
        }
        if (!ix.programId.equals(SystemProgram.programId)) return;
        const payer = ix.keys?.[0]?.pubkey;
        if (!payer || !payer.equals(user)) return;
        explicitSystemLamports += decodeSystemLamportsDebit(ix.data);
      });
      return;
    }

    const message = tx.message as any;
    const staticKeys: PublicKey[] = message.staticAccountKeys ?? [];
    const compiled = message.compiledInstructions ?? [];
    compiled.forEach(
      (ix: { programIdIndex: number; data: Uint8Array; accountKeyIndexes: number[] }) => {
        const programId = staticKeys[ix.programIdIndex];
        if (!programId) return;
        if (programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
          associatedTokenCreates += 1;
          return;
        }
        if (!programId.equals(SystemProgram.programId)) return;
        const payerIndex = ix.accountKeyIndexes?.[0];
        const payer = Number.isInteger(payerIndex) ? staticKeys[payerIndex] : undefined;
        if (!payer || !payer.equals(user)) return;
        explicitSystemLamports += decodeSystemLamportsDebit(ix.data);
      }
    );
  });

  const ataRentLamports = associatedTokenCreates
    ? await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)
    : 0;
  const associatedRentLamports = associatedTokenCreates * ataRentLamports;
  const totalLamports = associatedRentLamports + explicitSystemLamports;

  return {
    associatedTokenCreates,
    associatedRentLamports,
    explicitSystemLamports,
    totalLamports
  };
};

type MissingAccount = {
  mint: string;
  ata: string;
  tokenProgramId: string;
  rentLamports: number;
  kind: "asset" | "shares";
};

type FeeDiagnostics = {
  transactions: Array<{
    label: string;
    version: "legacy" | "v0";
    computeUnitLimit?: number;
    computeUnitPriceMicroLamports?: number;
    estimatedPriorityFeeLamports?: number;
  }>;
};

const buildJupiterSwapTx = async (
  user: PublicKey,
  inputMint: string,
  outputMint: string,
  amountBase: number,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  priorityFeeMicroLamports?: number
) => {
  const buildQuoteUrl = (base: string) => {
    const quoteUrl = new URL(`${base}/quote`);
    quoteUrl.searchParams.set("inputMint", inputMint);
    quoteUrl.searchParams.set("outputMint", outputMint);
    quoteUrl.searchParams.set("amount", amountBase.toString());
    quoteUrl.searchParams.set("slippageBps", slippageBps.toString());
    quoteUrl.searchParams.set("swapMode", "ExactIn");
    return quoteUrl;
  };

  const fetchLegacy = async () => {
    let quoteRes: Response;
    try {
      quoteRes = await fetch(buildQuoteUrl(LEGACY_JUPITER_API).toString());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Jupiter quote fetch failed: ${msg}`);
    }
    if (!quoteRes.ok) {
      const text = await quoteRes.text().catch(() => "");
      throw new Error(
        `Failed to fetch Jupiter quote (${quoteRes.status}): ${text || quoteRes.statusText}`
      );
    }
    const quoteResponse = await quoteRes.json();
    let swapRes: Response;
    try {
      const swapBody: Record<string, unknown> = {
        quoteResponse,
        userPublicKey: user.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true
      };
      if (priorityFeeMicroLamports === 0) {
        swapBody.prioritizationFeeLamports = 0;
      }
      if (
        priorityFeeMicroLamports !== undefined &&
        priorityFeeMicroLamports > 0
      ) {
        swapBody.computeUnitPriceMicroLamports = priorityFeeMicroLamports;
      }
      swapRes = await fetch(`${LEGACY_JUPITER_API}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(swapBody)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Jupiter swap fetch failed: ${msg}`);
    }
    if (!swapRes.ok) {
      const text = await swapRes.text().catch(() => "");
      throw new Error(
        `Failed to build Jupiter swap transaction (${swapRes.status}): ${text || swapRes.statusText}`
      );
    }
    const swapJson = await swapRes.json();
    const minOut = Number(quoteResponse.otherAmountThreshold ?? quoteResponse.outAmount);
    let base64 = swapJson.swapTransaction as string;
    if (priorityFeeMicroLamports === 0) {
      const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
      stripComputeUnitPrice(tx, true);
      base64 = Buffer.from(tx.serialize()).toString("base64");
    }
    return {
      base64,
      minOut
    };
  };

  const fetchWithApiKey = async () => {
    if (!JUPITER_API_KEY) {
      throw new Error("JUPITER_API_KEY is not configured.");
    }
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": JUPITER_API_KEY
    };
    let quoteRes: Response;
    try {
      quoteRes = await fetch(buildQuoteUrl(JUPITER_API_BASE).toString(), {
        headers
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Jupiter quote fetch failed: ${msg}`);
    }
    if (!quoteRes.ok) {
      const text = await quoteRes.text().catch(() => "");
      throw new Error(
        `Failed to fetch Jupiter quote (${quoteRes.status}): ${text || quoteRes.statusText}`
      );
    }
    const quoteResponse = await quoteRes.json();
    let swapRes: Response;
    try {
      const swapBody: Record<string, unknown> = {
        quoteResponse,
        userPublicKey: user.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true
      };
      if (priorityFeeMicroLamports === 0) {
        swapBody.prioritizationFeeLamports = 0;
      }
      if (
        priorityFeeMicroLamports !== undefined &&
        priorityFeeMicroLamports > 0
      ) {
        swapBody.computeUnitPriceMicroLamports = priorityFeeMicroLamports;
      }
      swapRes = await fetch(`${JUPITER_API_BASE}/swap`, {
        method: "POST",
        headers,
        body: JSON.stringify(swapBody)
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Jupiter swap fetch failed: ${msg}`);
    }
    if (!swapRes.ok) {
      const text = await swapRes.text().catch(() => "");
      throw new Error(
        `Failed to build Jupiter swap transaction (${swapRes.status}): ${text || swapRes.statusText}`
      );
    }
    const swapJson = await swapRes.json();
    const minOut = Number(quoteResponse.otherAmountThreshold ?? quoteResponse.outAmount);
    let base64 = swapJson.swapTransaction as string;
    if (priorityFeeMicroLamports === 0) {
      const tx = VersionedTransaction.deserialize(Buffer.from(base64, "base64"));
      stripComputeUnitPrice(tx, true);
      base64 = Buffer.from(tx.serialize()).toString("base64");
    }
    return {
      base64,
      minOut
    };
  };

  try {
    return await fetchLegacy();
  } catch (err) {
    if (isNetworkFetchError(err) && JUPITER_API_KEY) {
      return await fetchWithApiKey();
    }
    if (isNetworkFetchError(err) && !JUPITER_API_KEY) {
      throw new Error(
        "Jupiter quote fetch failed (DNS). Set JUPITER_API_KEY for https://api.jup.ag/swap/v1 or move between same-asset vaults."
      );
    }
    throw err;
  }
};

const buildProtocolTxs = async (
  connection: Connection,
  user: PublicKey,
  vault: VaultMetric,
  amount: number,
  direction: "deposit" | "withdraw",
  priorityFeeMicroLamports?: number
) => {
  switch (vault.protocolId) {
    case "solend":
      return buildSolendTxs(connection, user, vault, amount, direction);
    case "kamino":
      return buildKaminoTxs(connection, user, vault, amount, direction, priorityFeeMicroLamports);
    default:
      throw new Error("Unsupported protocol.");
  }
};

const resolveTokenProgramId = async (connection: Connection, mint: PublicKey) => {
  const info = await connection.getAccountInfo(mint);
  if (info?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
};

const estimateAtaRent = async (
  connection: Connection,
  mint: PublicKey,
  programId: PublicKey
) => {
  try {
    const mintState = await getMint(connection, mint, undefined, programId);
    const accountLen = getAccountLenForMint(mintState);
    return await connection.getMinimumBalanceForRentExemption(accountLen);
  } catch {
    return await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE);
  }
};

const getKaminoSharesMint = async (vaultId: string) => {
  const kvaultAddress = vaultId.split(":")[1];
  if (!kvaultAddress) return null;
  try {
    const rpc = getKaminoRpc() as unknown as any;
    const kvault = new KaminoVault(rpc, toKaminoAddress(kvaultAddress));
    await kvault.getState();
    return kvault.state?.sharesMint ? kvault.state.sharesMint.toString() : null;
  } catch {
    return null;
  }
};

const buildMissingAccounts = async (
  connection: Connection,
  wallet: PublicKey,
  vault: VaultMetric
): Promise<MissingAccount[]> => {
  const missing: MissingAccount[] = [];
  const mints: Array<{ mint: string; kind: "asset" | "shares" }> = [];
  if (vault.assetMint && vault.assetMint !== SOL_MINT) {
    mints.push({ mint: vault.assetMint, kind: "asset" });
  }
  const sharesMint = vault.sharesMint ?? (await getKaminoSharesMint(vault.id));
  if (sharesMint) {
    mints.push({ mint: sharesMint, kind: "shares" });
  }

  for (const entry of mints) {
    const mintPk = new PublicKey(entry.mint);
    const programId = await resolveTokenProgramId(connection, mintPk);
    const ata = await getAssociatedTokenAddress(
      mintPk,
      wallet,
      false,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    const ataInfo = await connection.getAccountInfo(ata);
    if (ataInfo) continue;
    const rentLamports = await estimateAtaRent(connection, mintPk, programId);
    missing.push({
      mint: mintPk.toBase58(),
      ata: ata.toBase58(),
      tokenProgramId: programId.toBase58(),
      rentLamports,
      kind: entry.kind
    });
  }

  return missing;
};

type SolDepositPlan = {
  transactions: BuiltTransaction[];
  swapInputLamports: number;
  swapInputSol: number;
  estimatedOutAmount: number;
  estimatedOutSymbol: string;
  setupLamports: number;
  setupDetails: {
    associatedTokenCreates: number;
    associatedRentLamports: number;
    explicitSystemLamports: number;
  };
  feeLamports: number;
  feeBreakdown: {
    signatureFeeLamports: number;
    priorityFeeLamports: number;
  };
  estimatedTotalDebitLamports: number;
};

const buildSolDepositPlan = async ({
  connection,
  user,
  vault,
  requestedLamports,
  slippageBps,
  priorityFeeMicroLamports
}: {
  connection: Connection;
  user: PublicKey;
  vault: VaultMetric;
  requestedLamports: number;
  slippageBps: number;
  priorityFeeMicroLamports?: number;
}): Promise<SolDepositPlan> => {
  const buildForSwapLamports = async (swapInputLamports: number) => {
    const transactions: BuiltTransaction[] = [];
    let estimatedOutAmount = swapInputLamports / 10 ** SOL_DECIMALS;
    let estimatedOutSymbol = vault.assetSymbol;
    let depositAmount = estimatedOutAmount;

    if (vault.assetMint !== SOL_MINT) {
      const outputMintPk = new PublicKey(vault.assetMint);
      const outputMintProgramId = await resolveTokenProgramId(connection, outputMintPk);
      const outputMintInfo = await getMint(
        connection,
        outputMintPk,
        undefined,
        outputMintProgramId
      );
      const outputDecimals = outputMintInfo.decimals;
      const swapTx = await buildJupiterSwapTx(
        user,
        SOL_MINT,
        vault.assetMint,
        swapInputLamports,
        slippageBps,
        priorityFeeMicroLamports
      );
      transactions.push({
        base64: swapTx.base64,
        version: "v0",
        label: "swap"
      });
      depositAmount = swapTx.minOut / 10 ** outputDecimals;
      estimatedOutAmount = depositAmount;
    } else {
      estimatedOutSymbol = "SOL";
    }

    const depositTxs = await buildProtocolTxs(
      connection,
      user,
      vault,
      depositAmount,
      "deposit",
      priorityFeeMicroLamports
    );
    if (!depositTxs.length) {
      throw new Error("No deposit transactions were built.");
    }
    depositTxs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `deposit-${index + 1}`))
    );

    return {
      transactions,
      estimatedOutAmount,
      estimatedOutSymbol
    };
  };

  // First pass: estimate non-swap debits from the generated transaction plan.
  const provisional = await buildForSwapLamports(requestedLamports);
  const provisionalSetup = await estimateEmbeddedSetupLamports(
    connection,
    user,
    provisional.transactions.filter((entry) => entry.label.startsWith("deposit"))
  );
  const provisionalFees = estimateTransactionCostLamports(provisional.transactions);
  const reserveLamports = provisionalSetup.totalLamports + provisionalFees.totalLamports;
  const boundedSwapInputLamports = Math.max(0, requestedLamports - reserveLamports);

  if (vault.assetMint !== SOL_MINT && boundedSwapInputLamports <= 0) {
    throw new Error(
      "Requested SOL is too small after setup/network fees. Increase amount or reduce setup costs first."
    );
  }

  const needsRebuild =
    vault.assetMint !== SOL_MINT &&
    Math.abs(requestedLamports - boundedSwapInputLamports) >= 1;
  const finalBuild = needsRebuild
    ? await buildForSwapLamports(boundedSwapInputLamports)
    : provisional;
  const finalSetup = await estimateEmbeddedSetupLamports(
    connection,
    user,
    finalBuild.transactions.filter((entry) => entry.label.startsWith("deposit"))
  );
  const finalFees = estimateTransactionCostLamports(finalBuild.transactions);
  const swapInputLamports =
    needsRebuild && vault.assetMint !== SOL_MINT
      ? boundedSwapInputLamports
      : requestedLamports;
  const estimatedTotalDebitLamports =
    swapInputLamports + finalSetup.totalLamports + finalFees.totalLamports;

  return {
    transactions: finalBuild.transactions,
    swapInputLamports,
    swapInputSol: swapInputLamports / 1_000_000_000,
    estimatedOutAmount: finalBuild.estimatedOutAmount,
    estimatedOutSymbol: finalBuild.estimatedOutSymbol,
    setupLamports: finalSetup.totalLamports,
    setupDetails: {
      associatedTokenCreates: finalSetup.associatedTokenCreates,
      associatedRentLamports: finalSetup.associatedRentLamports,
      explicitSystemLamports: finalSetup.explicitSystemLamports
    },
    feeLamports: finalFees.totalLamports,
    feeBreakdown: {
      signatureFeeLamports: finalFees.signatureFeeLamports,
      priorityFeeLamports: finalFees.priorityFeeLamports
    },
    estimatedTotalDebitLamports
  };
};

moveRouter.post("/build", async (req, res) => {
  try {
    const payload = req.body as MoveRequest & {
      slippagePct?: number;
      priorityFeeMode?: unknown;
      debugFee?: boolean;
    };
    if (
      typeof payload?.fromVaultId !== "string" ||
      typeof payload?.toVaultId !== "string" ||
      !payload?.amount ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid move request" });
      return;
    }

    const liveVaults = await getLiveVaults({ allowStale: true });
    const fromVault = liveVaults.find((item) => item.id === payload.fromVaultId);
    const toVault = liveVaults.find((item) => item.id === payload.toVaultId);

    if (!fromVault || !toVault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const transactions: BuiltTransaction[] = [];
    const slippageBps = toSlippageBps(payload.slippagePct);
    const priorityFeeMicroLamports = toPriorityFeeMicroLamports(payload.priorityFeeMode);
    const [fromMissing, toMissing] = await Promise.all([
      buildMissingAccounts(connection, user, fromVault),
      buildMissingAccounts(connection, user, toVault)
    ]);
    if (fromMissing.length || toMissing.length) {
      const fromRentLamports = fromMissing.reduce((sum, item) => sum + item.rentLamports, 0);
      const toRentLamports = toMissing.reduce((sum, item) => sum + item.rentLamports, 0);
      res.status(400).json({
        error:
          "Required token accounts are missing for hop. Create token accounts for source/destination vault first to avoid one-time SOL rent in the hop transaction.",
        details: {
          fromVaultId: fromVault.id,
          fromMissingAccounts: fromMissing.length,
          fromRentLamports,
          toVaultId: toVault.id,
          toMissingAccounts: toMissing.length,
          toRentLamports
        }
      });
      return;
    }

    const withdrawTxs = await buildProtocolTxs(
      connection,
      user,
      fromVault,
      payload.amount,
      "withdraw",
      priorityFeeMicroLamports
    );
    if (!withdrawTxs.length) {
      throw new Error("No withdraw transactions were built.");
    }
    withdrawTxs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `withdraw-${index + 1}`))
    );

    let depositAmount = payload.amount;
    if (fromVault.assetMint !== toVault.assetMint) {
      const amountBase = toBaseUnits(payload.amount, fromVault.assetDecimals);
      const swapTx = await buildJupiterSwapTx(
        user,
        fromVault.assetMint,
        toVault.assetMint,
        amountBase,
        slippageBps,
        priorityFeeMicroLamports
      );
      transactions.push({
        base64: swapTx.base64,
        version: "v0",
        label: "swap"
      });
      depositAmount = swapTx.minOut / 10 ** toVault.assetDecimals;
    }

    const depositTxs = await buildProtocolTxs(
      connection,
      user,
      toVault,
      depositAmount,
      "deposit",
      priorityFeeMicroLamports
    );
    if (!depositTxs.length) {
      throw new Error("No deposit transactions were built.");
    }
    depositTxs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `deposit-${index + 1}`))
    );

    const feeDiagnostics = payload.debugFee ? buildFeeDiagnostics(transactions) : undefined;
    res.json({
      data: {
        transactions,
        feeDiagnostics
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Move build failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/deposit/build", async (req, res) => {
  try {
    const payload = req.body as {
      vaultId: string;
      amount: number;
      walletAddress: string;
      slippagePct?: number;
      priorityFeeMode?: unknown;
      debugFee?: boolean;
    };
    if (
      typeof payload?.vaultId !== "string" ||
      !payload?.amount ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid deposit request" });
      return;
    }

    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === payload.vaultId);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const priorityFeeMicroLamports = toPriorityFeeMicroLamports(payload.priorityFeeMode);
    const missingAccounts = await buildMissingAccounts(connection, user, vault);
    if (missingAccounts.length) {
      res.status(400).json({
        error:
          "Required token accounts are missing. Run 'Preview setup fees' and 'Create token accounts' first."
      });
      return;
    }
    const transactions: BuiltTransaction[] = [];
    const txs = await buildProtocolTxs(
      connection,
      user,
      vault,
      payload.amount,
      "deposit",
      priorityFeeMicroLamports
    );
    if (!txs.length) {
      throw new Error("No deposit transactions were built.");
    }
    txs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `deposit-${index + 1}`))
    );

    const feeDiagnostics = payload.debugFee ? buildFeeDiagnostics(transactions) : undefined;
    res.json({ data: { transactions, feeDiagnostics } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deposit build failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/deposit/sol/build", async (req, res) => {
  try {
    const payload = req.body as {
      vaultId: string;
      amountSol: number;
      walletAddress: string;
      slippagePct?: number;
      priorityFeeMode?: unknown;
      debugFee?: boolean;
    };
    if (
      typeof payload?.vaultId !== "string" ||
      !Number.isFinite(payload?.amountSol) ||
      payload.amountSol <= 0 ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid SOL deposit request" });
      return;
    }

    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === payload.vaultId);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }
    if (vault.protocolId !== "kamino") {
      res.status(400).json({ error: "SOL deposits are only supported for Kamino vaults." });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const slippageBps = toSlippageBps(payload.slippagePct);
    const priorityFeeMicroLamports = toPriorityFeeMicroLamports(payload.priorityFeeMode);
    const requestedLamports = toBaseUnits(payload.amountSol, SOL_DECIMALS);
    const missingAccounts = await buildMissingAccounts(connection, user, vault);

    // Keep SOL funding predictable: do not auto-create accounts (which adds rent).
    // Users can create accounts explicitly via Preview/Create setup actions.
    if (missingAccounts.length) {
      res.status(400).json({
        error:
          "Required token accounts are missing. Run 'Preview setup fees' and 'Create token accounts' first."
      });
      return;
    }

    let plan: SolDepositPlan;
    try {
      plan = await buildSolDepositPlan({
        connection,
        user,
        vault,
        requestedLamports,
        slippageBps,
        priorityFeeMicroLamports
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Requested SOL is too small")) {
        res.status(400).json({ error: message });
        return;
      }
      throw err;
    }

    const feeDiagnostics = payload.debugFee ? buildFeeDiagnostics(plan.transactions) : undefined;
    res.json({
      data: {
        transactions: plan.transactions,
        feeDiagnostics,
        plan: {
          requestedLamports,
          requestedSol: requestedLamports / 1_000_000_000,
          swapInputLamports: plan.swapInputLamports,
          swapInputSol: plan.swapInputSol,
          estimatedSetupLamports: plan.setupLamports,
          estimatedNetworkFeeLamports: plan.feeLamports,
          estimatedTotalDebitLamports: plan.estimatedTotalDebitLamports
        }
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SOL deposit build failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/deposit/sol/quote", async (req, res) => {
  try {
    const payload = req.body as {
      vaultId: string;
      amountSol: number;
      walletAddress: string;
      slippagePct?: number;
      priorityFeeMode?: unknown;
    };
    if (
      typeof payload?.vaultId !== "string" ||
      !Number.isFinite(payload?.amountSol) ||
      payload.amountSol <= 0 ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid SOL quote request" });
      return;
    }

    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === payload.vaultId);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }
    if (vault.protocolId !== "kamino") {
      res.status(400).json({ error: "SOL deposits are only supported for Kamino vaults." });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const requestedLamports = toBaseUnits(payload.amountSol, SOL_DECIMALS);
    const slippageBps = toSlippageBps(payload.slippagePct);
    const priorityFeeMicroLamports = toPriorityFeeMicroLamports(payload.priorityFeeMode);
    const missingAccounts = await buildMissingAccounts(connection, user, vault);
    const rentLamports = missingAccounts.reduce((sum, item) => sum + item.rentLamports, 0);

    if (missingAccounts.length) {
      res.json({
        data: {
          canProceed: false,
          reason: "missing_accounts",
          requestedLamports,
          requestedSol: payload.amountSol,
          missingAccountsCount: missingAccounts.length,
          rentLamports,
          rentSol: rentLamports / 1_000_000_000
        }
      });
      return;
    }

    let plan: SolDepositPlan;
    try {
      plan = await buildSolDepositPlan({
        connection,
        user,
        vault,
        requestedLamports,
        slippageBps,
        priorityFeeMicroLamports
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Requested SOL is too small")) {
        res.json({
          data: {
            canProceed: false,
            reason: "insufficient_requested_sol",
            requestedLamports,
            requestedSol: payload.amountSol
          }
        });
        return;
      }
      throw err;
    }
    res.json({
      data: {
        canProceed: true,
        requestedLamports,
        requestedSol: payload.amountSol,
        swapInputLamports: plan.swapInputLamports,
        swapInputSol: plan.swapInputSol,
        estimatedOutAmount: plan.estimatedOutAmount,
        estimatedOutSymbol: plan.estimatedOutSymbol,
        txPlan: plan.transactions.map((entry) => ({
          label: entry.label,
          version: entry.version
        })),
        estimatedSetupLamports: plan.setupLamports,
        estimatedSetupAssociatedRentLamports: plan.setupDetails.associatedRentLamports,
        estimatedSetupSystemLamports: plan.setupDetails.explicitSystemLamports,
        estimatedSignatureFeeLamports: plan.feeBreakdown.signatureFeeLamports,
        estimatedPriorityFeeLamports: plan.feeBreakdown.priorityFeeLamports,
        estimatedNetworkFeeLamports: plan.feeLamports,
        estimatedTotalDebitLamports: plan.estimatedTotalDebitLamports,
        estimatedTotalDebitSol: plan.estimatedTotalDebitLamports / 1_000_000_000
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SOL quote failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/withdraw/build", async (req, res) => {
  try {
    const payload = req.body as {
      vaultId: string;
      amount: number;
      walletAddress: string;
      destination?: "asset" | "sol";
      slippagePct?: number;
      priorityFeeMode?: unknown;
      debugFee?: boolean;
    };
    if (
      typeof payload?.vaultId !== "string" ||
      !payload?.amount ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid withdraw request" });
      return;
    }

    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === payload.vaultId);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const transactions: BuiltTransaction[] = [];
    const slippageBps = toSlippageBps(payload.slippagePct);
    const priorityFeeMicroLamports = toPriorityFeeMicroLamports(payload.priorityFeeMode);
    const missingAccounts = await buildMissingAccounts(connection, user, vault);
    if (missingAccounts.length) {
      res.status(400).json({
        error:
          "Required token accounts are missing. Create token accounts for this vault first to avoid one-time SOL rent during withdraw.",
        details: {
          vaultId: vault.id,
          missingAccounts: missingAccounts.length,
          rentLamports: missingAccounts.reduce((sum, item) => sum + item.rentLamports, 0)
        }
      });
      return;
    }

    const withdrawTxs = await buildProtocolTxs(
      connection,
      user,
      vault,
      payload.amount,
      "withdraw",
      priorityFeeMicroLamports
    );
    if (!withdrawTxs.length) {
      throw new Error("No withdraw transactions were built.");
    }
    withdrawTxs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `withdraw-${index + 1}`))
    );

    if (payload.destination === "sol" && vault.assetMint !== SOL_MINT) {
      const amountBase = toBaseUnits(payload.amount, vault.assetDecimals);
      const swapTx = await buildJupiterSwapTx(
        user,
        vault.assetMint,
        SOL_MINT,
        amountBase,
        slippageBps,
        priorityFeeMicroLamports
      );
      transactions.push({
        base64: swapTx.base64,
        version: "v0",
        label: "swap"
      });
    }

    const feeDiagnostics = payload.debugFee ? buildFeeDiagnostics(transactions) : undefined;
    res.json({ data: { transactions, feeDiagnostics } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Withdraw build failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/accounts/preview", async (req, res) => {
  try {
    const payload = req.body as { vaultId: string; walletAddress: string };
    if (typeof payload?.vaultId !== "string" || !payload?.walletAddress) {
      res.status(400).json({ error: "Invalid account preview request" });
      return;
    }

    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === payload.vaultId);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const missingAccounts = await buildMissingAccounts(connection, user, vault);
    const totalRentLamports = missingAccounts.reduce(
      (sum, entry) => sum + entry.rentLamports,
      0
    );

    res.json({
      data: {
        missingAccounts,
        totalRentLamports,
        totalRentSol: totalRentLamports / 1_000_000_000
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Account preview failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/accounts/create", async (req, res) => {
  try {
    const payload = req.body as { vaultId: string; walletAddress: string };
    if (typeof payload?.vaultId !== "string" || !payload?.walletAddress) {
      res.status(400).json({ error: "Invalid account creation request" });
      return;
    }

    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === payload.vaultId);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const missingAccounts = await buildMissingAccounts(connection, user, vault);
    const totalRentLamports = missingAccounts.reduce(
      (sum, entry) => sum + entry.rentLamports,
      0
    );

    if (!missingAccounts.length) {
      res.json({
        data: {
          transactions: [],
          missingAccounts,
          totalRentLamports,
          totalRentSol: totalRentLamports / 1_000_000_000
        }
      });
      return;
    }

    const tx = new Transaction();
    missingAccounts.forEach((entry) => {
      const mintPk = new PublicKey(entry.mint);
      const ataPk = new PublicKey(entry.ata);
      const programId = new PublicKey(entry.tokenProgramId);
      tx.add(
        createAssociatedTokenAccountInstruction(
          user,
          ataPk,
          user,
          mintPk,
          programId,
          ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
    });
    const { blockhash } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;
    tx.feePayer = user;

    res.json({
      data: {
        transactions: [serializeTx(tx, "create-accounts")],
        missingAccounts,
        totalRentLamports,
        totalRentSol: totalRentLamports / 1_000_000_000
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Account creation failed";
    res.status(500).json({ error: message });
  }
});
