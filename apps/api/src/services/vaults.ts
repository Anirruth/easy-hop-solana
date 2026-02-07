import { Connection } from "@solana/web3.js";
import {
  fetchPoolMetadata,
  fetchPools,
  getProgramId,
  MAIN_POOL_ADDRESS
} from "@solendprotocol/solend-sdk";
import { VaultMetric } from "../types.js";
import { loadSwitchboardProgram } from "./solend.js";

import { getFallbackConnection, getPrimaryConnection } from "./rpc.js";
const VAULT_CACHE_TTL_MS = 180_000;
const EMPTY_CACHE_TTL_MS = 10_000;
const SOLEND_API_TIMEOUT_MS = 5000;
const SOLEND_MARKETS_TTL_MS = 10 * 60_000;
let vaultCache: { data: VaultMetric[]; expires: number } | null = null;
let solendMarketCache: { data: Map<string, string>; expires: number } | null = null;

const safeNumber = (value: number) => (Number.isFinite(value) ? value : 0);

const toNumberSafe = (value: unknown): number => {
  if (typeof value === "number") return safeNumber(value);
  if (typeof value === "bigint") return safeNumber(Number(value));
  if (value && typeof (value as { toNumber?: () => number }).toNumber === "function") {
    return safeNumber((value as { toNumber: () => number }).toNumber());
  }
  return safeNumber(Number(value));
};

const clampUsd = (value: number, max = 1e15): number => {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, max);
};

const normalizeString = (value: unknown): string =>
  typeof value === "string" ? value : (value as { toString?: () => string })?.toString?.() ?? "";

const isLikelyAddress = (value: string) =>
  /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);

const pickDisplayName = (candidates: Array<string | undefined>, fallback: string) => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!isLikelyAddress(candidate)) return candidate;
  }
  return fallback;
};

const solendPoolParam = (poolAddress: string): string =>
  poolAddress === MAIN_POOL_ADDRESS.toBase58() ? "main" : poolAddress;

const kaminoHeaders = {
  Accept: "application/json",
  "User-Agent": "EasyHopSolana/1.0",
  Referer: "https://kamino.com/"
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R | null>
): Promise<R[]> => {
  const results: R[] = [];
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = index++;
      const res = await worker(items[current]);
      if (res !== null) {
        results.push(res);
      }
    }
  });
  await Promise.all(runners);
  return results;
};

const toNumberOrZero = (value: unknown): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const normalizeApy = (value: number) => (value > 0 && value <= 1 ? value * 100 : value);

const extractSymbolFromName = (name: unknown) => {
  const safeName =
    typeof name === "string" ? name : (name as { toString?: () => string })?.toString?.() ?? "";
  if (!safeName) return "Token";
  const parts = safeName.split(" ").filter(Boolean);
  const upper = parts.find((part) => /^[A-Z0-9]{2,8}$/.test(part));
  if (upper) return upper;
  const last = parts[parts.length - 1];
  if (last && /[A-Z]/.test(last)) return last;
  return parts[0] ?? safeName;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

async function fetchSolendApiOverrides(): Promise<
  Map<string, { apyTotal: number; tvlUsd: number; liquidityUsd: number }> | null
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLEND_API_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.solend.fi/v1/reserves", {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data) ? data : (data as { reserves?: unknown[] })?.reserves;
    if (!Array.isArray(list)) return null;
    const byMint = new Map<string, { apyTotal: number; tvlUsd: number; liquidityUsd: number }>();
    for (const r of list) {
      const mint =
        (r as { liquidity?: { mint?: string }; mint?: string })?.liquidity?.mint ??
        (r as { mint?: string })?.mint;
      if (!mint) continue;
      const apy = safeNumber(
        (r as { supplyInterestRate?: number; supply_apy?: number })?.supplyInterestRate ??
          (r as { supply_apy?: number })?.supply_apy
      );
      const apyPct = apy <= 1 && apy > 0 ? apy * 100 : apy;
      const totalUsd = clampUsd(
        safeNumber(
          (r as { totalDepositsUsd?: number })?.totalDepositsUsd ??
            (r as { total_deposits_usd?: number })?.total_deposits_usd ??
            0
        )
      );
      const availUsd = clampUsd(
        safeNumber(
          (r as { availableAmountUsd?: number })?.availableAmountUsd ??
            (r as { available_liquidity_usd?: number })?.available_liquidity_usd ??
            0
        )
      );
      byMint.set(mint, {
        apyTotal: apyPct,
        tvlUsd: totalUsd,
        liquidityUsd: Math.min(availUsd, totalUsd)
      });
    }
    return byMint.size > 0 ? byMint : null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function fetchSolendMarketNames(): Promise<Map<string, string> | null> {
  const now = Date.now();
  if (solendMarketCache && solendMarketCache.expires > now) {
    return solendMarketCache.data;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOLEND_API_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.solend.fi/v1/markets?scope=all", {
      signal: controller.signal,
      headers: { Accept: "application/json" }
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ address?: string; name?: string }> };
    if (!Array.isArray(data?.results)) return null;
    const map = new Map<string, string>();
    data.results.forEach((market) => {
      if (!market?.address || !market?.name) return;
      map.set(market.address, market.name);
    });
    solendMarketCache = { data: map, expires: now + SOLEND_MARKETS_TTL_MS };
    return map;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

async function buildSolendVaults(
  connection: Connection,
  overrides: Map<string, { apyTotal: number; tvlUsd: number; liquidityUsd: number }> | null
): Promise<VaultMetric[]> {
  try {
    const programId = getProgramId("production");
    const [poolMetadataRaw, slot, switchboardProgram, solendMarkets] = await Promise.all([
      fetchPoolMetadata(connection, "production"),
      connection.getSlot("confirmed"),
      loadSwitchboardProgram(connection),
      fetchSolendMarketNames()
    ]);

    const rawList = Array.isArray(poolMetadataRaw) ? poolMetadataRaw : [];
    const poolMetadata = rawList.filter(
      (p: { address?: string }) => p && typeof p.address === "string"
    ) as unknown as Parameters<typeof fetchPools>[0];
    if (poolMetadata.length === 0) return [];

    const pools = await fetchPools(
      poolMetadata,
      connection,
      switchboardProgram,
      programId.toBase58(),
      slot,
      true
    );

    const vaults: VaultMetric[] = [];
    Object.values(pools).forEach((pool) => {
      if (!pool || !Array.isArray(pool.reserves)) return;
      const marketName = solendMarkets?.get(pool.address);
      const poolName = pickDisplayName([marketName, pool.name], "Solend Pool");
      const poolAddress = pool.address;
      const poolParam = solendPoolParam(poolAddress);
      pool.reserves.forEach((reserve) => {
        if (!reserve?.mintAddress || !reserve.address) return;
        const tvlUsd = clampUsd(safeNumber(reserve.totalSupplyUsd.toNumber()));
        const availUsd = clampUsd(safeNumber(reserve.availableAmountUsd.toNumber()));
        const liquidityUsd = Math.min(availUsd, tvlUsd);
        const reserveAddr = reserve.address;
        const solendVaultUrl = reserveAddr
          ? `https://save.finance/?pool=${poolParam}&reserve=${reserveAddr}`
          : `https://save.finance/?pool=${poolParam}`;
        const apiOverride =
          poolAddress === MAIN_POOL_ADDRESS.toBase58()
            ? overrides?.get(reserve.mintAddress)
            : undefined;
        const tokenName = pickDisplayName(
          [reserve.symbol, reserve.name],
          "Token"
        );
        vaults.push({
          id: `solend:${poolAddress}:${reserveAddr}`,
          protocolId: "solend",
          protocolName: "Solend",
          poolName,
          vaultName: tokenName,
          category: "lending",
          assetSymbol: tokenName,
          assetMint: reserve.mintAddress,
          assetDecimals: reserve.decimals,
          vaultUrl: solendVaultUrl,
          apyTotal: apiOverride?.apyTotal ?? safeNumber(reserve.supplyInterest.toNumber() * 100),
          apyBase: safeNumber(reserve.supplyInterest.toNumber() * 100),
          apyRewards: 0,
          tvlUsd: apiOverride?.tvlUsd ?? tvlUsd,
          liquidityUsd: apiOverride?.liquidityUsd ?? liquidityUsd,
          utilization: safeNumber(reserve.reserveUtilization.toNumber()),
          updatedAt: new Date().toISOString()
        });
      });
    });

    return vaults;
  } catch (err) {
    console.warn("Solend vault fetch failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

async function buildKaminoVaults(_connection: Connection): Promise<VaultMetric[]> {
  try {
    const res = await fetch("https://api.kamino.finance/kvaults/vaults", {
      headers: kaminoHeaders
    });
    if (!res.ok) return [];
    const list = (await res.json()) as Array<{
      address?: string;
      state?: { name?: string; tokenMint?: string; tokenMintDecimals?: number };
    }>;
    if (!Array.isArray(list)) return [];

    const vaults = await mapWithConcurrency(list, 4, async (vault) => {
      if (!vault?.address || !vault?.state?.name) return null;
      const metricsRes = await fetch(
        `https://api.kamino.finance/kvaults/vaults/${vault.address}/metrics`,
        { headers: kaminoHeaders }
      );
      if (!metricsRes.ok) return null;
      const metrics = (await metricsRes.json()) as {
        apy?: string;
        apyActual?: string;
        tokensAvailableUsd?: string;
        tokensInvestedUsd?: string;
      };
      const availableUsd = toNumberOrZero(metrics.tokensAvailableUsd);
      const investedUsd = toNumberOrZero(metrics.tokensInvestedUsd);
      const tvlUsd = clampUsd(availableUsd + investedUsd);
      const liquidityUsd = tvlUsd;
      const apyRaw = toNumberOrZero(metrics.apy ?? metrics.apyActual);
      const apyTotal = normalizeApy(apyRaw);
      const poolName = "Kamino Lend";
      const vaultName = vault.state.name;
      const assetSymbol = extractSymbolFromName(vaultName);
      const slug = slugify(vaultName);
      return {
        id: `kamino:${vault.address}`,
        protocolId: "kamino",
        protocolName: "Kamino Lend",
        poolName,
        vaultName,
        category: "lending",
        assetSymbol,
        assetMint: vault.state.tokenMint ?? "",
        assetDecimals: vault.state.tokenMintDecimals ?? 6,
        vaultUrl: slug ? `https://kamino.com/lend/${slug}` : "https://kamino.com/lend",
        apyTotal,
        apyBase: apyTotal,
        apyRewards: 0,
        tvlUsd,
        liquidityUsd,
        utilization: tvlUsd > 0 ? investedUsd / tvlUsd : 0,
        updatedAt: new Date().toISOString()
      } satisfies VaultMetric;
    });

    return vaults;
  } catch (err) {
    console.warn("Kamino vault fetch failed:", err instanceof Error ? err.message : err);
    return [];
  }
}


export async function getLiveVaults(): Promise<VaultMetric[]> {
  const now = Date.now();
  if (vaultCache && vaultCache.expires > now) return vaultCache.data;
  const connection = getPrimaryConnection();
  const fallbackConnection = getFallbackConnection();
  const solendOverrides = await fetchSolendApiOverrides();
  let solend = await buildSolendVaults(connection, solendOverrides);
  await new Promise((resolve) => setTimeout(resolve, 500));
  let kamino = await buildKaminoVaults(connection);
  await new Promise((resolve) => setTimeout(resolve, 500));
  if (fallbackConnection) {
    if (!solend.length) {
      solend = await buildSolendVaults(fallbackConnection, solendOverrides);
    }
    if (!kamino.length) {
      kamino = await buildKaminoVaults(fallbackConnection, true);
    }
  }

  const data = [...solend, ...kamino].filter((vault) => vault.liquidityUsd >= 100_000);
  const ttl = data.length ? VAULT_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
  vaultCache = { data, expires: now + ttl };
  return data;
}

export async function getVaultById(id: string): Promise<VaultMetric | undefined> {
  const vaults = await getLiveVaults();
  return vaults.find((vault) => vault.id === id);
}

export function parseVaultId(
  id: unknown
): { protocolId: "solend"; poolAddress: string; reserveAddress: string } |
  { protocolId: "kamino"; marketAddress: string; reserveAddress: string } |
  null {
  try {
    const raw =
      typeof id === "string" ? id : (id as { toString?: () => string })?.toString?.() ?? "";
    if (!raw) return null;
    const [protocolId, first, second] = raw.split(":");
    if (protocolId === "solend" && first && second) {
      return { protocolId: "solend", poolAddress: first, reserveAddress: second };
    }
    if (protocolId === "kamino" && first && second) {
      return { protocolId: "kamino", marketAddress: first, reserveAddress: second };
    }
    return null;
  } catch {
    return null;
  }
}
