import { Router } from "express";
import { Connection, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
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

export const moveRouter = Router();

import { getPrimaryConnection } from "../services/rpc.js";
const LEGACY_JUPITER_API = "https://quote-api.jup.ag/v6";
const JUPITER_API_BASE =
  process.env.JUPITER_API_BASE?.trim() || "https://api.jup.ag/swap/v1";
const JUPITER_API_KEY = process.env.JUPITER_API_KEY?.trim() || "";
const DEFAULT_SLIPPAGE_BPS = 50;
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
  direction: "deposit" | "withdraw"
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
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: KAMINO_HEADERS,
      body: JSON.stringify({
        wallet: user.toBase58(),
        kvault: kvaultAddress,
        amount: amount.toString()
      })
    });
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
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.message.recentBlockhash = blockhash;
  return [tx];
};

const isNetworkFetchError = (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("fetch failed") || msg.includes("ENOTFOUND");
};

const buildJupiterSwapTx = async (
  user: PublicKey,
  inputMint: string,
  outputMint: string,
  amountBase: number
) => {
  const buildQuoteUrl = (base: string) => {
    const quoteUrl = new URL(`${base}/quote`);
    quoteUrl.searchParams.set("inputMint", inputMint);
    quoteUrl.searchParams.set("outputMint", outputMint);
    quoteUrl.searchParams.set("amount", amountBase.toString());
    quoteUrl.searchParams.set("slippageBps", DEFAULT_SLIPPAGE_BPS.toString());
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
      swapRes = await fetch(`${LEGACY_JUPITER_API}/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: user.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true
        })
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
    return {
      base64: swapJson.swapTransaction as string,
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
      swapRes = await fetch(`${JUPITER_API_BASE}/swap`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          quoteResponse,
          userPublicKey: user.toBase58(),
          wrapAndUnwrapSol: true,
          dynamicComputeUnitLimit: true
        })
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
    return {
      base64: swapJson.swapTransaction as string,
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
  direction: "deposit" | "withdraw"
) => {
  switch (vault.protocolId) {
    case "solend":
      return buildSolendTxs(connection, user, vault, amount, direction);
    case "kamino":
      return buildKaminoTxs(connection, user, vault, amount, direction);
    default:
      throw new Error("Unsupported protocol.");
  }
};

moveRouter.post("/build", async (req, res) => {
  try {
    const payload = req.body as MoveRequest;
    if (
      typeof payload?.fromVaultId !== "string" ||
      typeof payload?.toVaultId !== "string" ||
      !payload?.amount ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid move request" });
      return;
    }

    const liveVaults = await getLiveVaults();
    const fromVault = liveVaults.find((item) => item.id === payload.fromVaultId);
    const toVault = liveVaults.find((item) => item.id === payload.toVaultId);

    if (!fromVault || !toVault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const transactions: BuiltTransaction[] = [];

    const withdrawTxs = await buildProtocolTxs(
      connection,
      user,
      fromVault,
      payload.amount,
      "withdraw"
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
        amountBase
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
      "deposit"
    );
    if (!depositTxs.length) {
      throw new Error("No deposit transactions were built.");
    }
    depositTxs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `deposit-${index + 1}`))
    );

    res.json({
      data: {
        transactions
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Move build failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/deposit/build", async (req, res) => {
  try {
    const payload = req.body as { vaultId: string; amount: number; walletAddress: string };
    if (
      typeof payload?.vaultId !== "string" ||
      !payload?.amount ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid deposit request" });
      return;
    }

    const liveVaults = await getLiveVaults();
    const vault = liveVaults.find((item) => item.id === payload.vaultId);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }

    const user = new PublicKey(payload.walletAddress);
    const connection = getPrimaryConnection();
    const txs = await buildProtocolTxs(connection, user, vault, payload.amount, "deposit");
    if (!txs.length) {
      throw new Error("No deposit transactions were built.");
    }
    const transactions: BuiltTransaction[] = [];
    txs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `deposit-${index + 1}`))
    );

    res.json({ data: { transactions } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Deposit build failed";
    res.status(500).json({ error: message });
  }
});

moveRouter.post("/deposit/sol/build", async (req, res) => {
  try {
    const payload = req.body as { vaultId: string; amountSol: number; walletAddress: string };
    if (
      typeof payload?.vaultId !== "string" ||
      !Number.isFinite(payload?.amountSol) ||
      payload.amountSol <= 0 ||
      !payload?.walletAddress
    ) {
      res.status(400).json({ error: "Invalid SOL deposit request" });
      return;
    }

    const liveVaults = await getLiveVaults();
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
    const transactions: BuiltTransaction[] = [];

    let depositAmount = payload.amountSol;
    if (vault.assetMint !== SOL_MINT) {
      const amountBase = toBaseUnits(payload.amountSol, SOL_DECIMALS);
      const swapTx = await buildJupiterSwapTx(
        user,
        SOL_MINT,
        vault.assetMint,
        amountBase
      );
      transactions.push({
        base64: swapTx.base64,
        version: "v0",
        label: "swap"
      });
      depositAmount = swapTx.minOut / 10 ** vault.assetDecimals;
    }

    const txs = await buildProtocolTxs(connection, user, vault, depositAmount, "deposit");
    if (!txs.length) {
      throw new Error("No deposit transactions were built.");
    }
    txs.forEach((tx, index) =>
      transactions.push(serializeTx(tx, `deposit-${index + 1}`))
    );

    res.json({ data: { transactions } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SOL deposit build failed";
    res.status(500).json({ error: message });
  }
});
