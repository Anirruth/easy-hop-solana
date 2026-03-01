import { VaultMetric } from "../types.js";

const VAULT_CACHE_TTL_MS = 180_000;
const EMPTY_CACHE_TTL_MS = 10_000;
const KAMINO_API_TIMEOUT_MS = 7000;
const KAMINO_API_RETRIES = 1;
const KAMINO_FETCH_PER_VAULT_METRICS =
  process.env.KAMINO_FETCH_PER_VAULT_METRICS === "true";
const KAMINO_FORCE_BULK_ONLY =
  process.env.KAMINO_FORCE_BULK_ONLY === "true";
const KAMINO_VAULT_BUILD_CONCURRENCY = Math.max(
  1,
  Number(process.env.KAMINO_VAULT_BUILD_CONCURRENCY ?? 10)
);
let vaultCache: { data: VaultMetric[]; expires: number } | null = null;
let vaultRefreshPromise: Promise<VaultMetric[]> | null = null;

const safeNumber = (value: number) => (Number.isFinite(value) ? value : 0);

const clampUsd = (value: number, max = 1e15): number => {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, max);
};

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

const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  timeoutMs = KAMINO_API_TIMEOUT_MS
) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchWithRetry = async (
  url: string,
  init: RequestInit = {},
  timeoutMs = KAMINO_API_TIMEOUT_MS,
  retries = KAMINO_API_RETRIES
) => {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (err) {
      lastError = err;
      if (attempt >= retries) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Fetch failed");
};

const toNumberOrZero = (value: unknown): number => {
  if (typeof value === "string") {
    const normalized = value.replaceAll(",", "").replaceAll("%", "").trim();
    if (!normalized) return 0;
    const num = Number(normalized);
    return Number.isFinite(num) ? num : 0;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
};

const toNumberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const parsed = toNumberOrZero(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeMetricKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, "");

const flattenMetricEntries = (
  source: Record<string, unknown>,
  depth = 4,
  prefix = ""
): Array<[string, unknown]> => {
  const out: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(source)) {
    const pathKey = prefix ? `${prefix}.${key}` : key;
    out.push([pathKey, value]);
    if (depth <= 0 || !value || typeof value !== "object" || Array.isArray(value)) continue;
    out.push(
      ...flattenMetricEntries(
        value as Record<string, unknown>,
        depth - 1,
        pathKey
      )
    );
  }
  return out;
};

const pickMetricValue = (
  sources: Array<Record<string, unknown> | null | undefined>,
  keys: string[]
): number | null => {
  const normalizedKeys = keys.map(normalizeMetricKey);
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const entries = flattenMetricEntries(source);
    for (const wanted of normalizedKeys) {
      const match = entries.find(([rawKey]) => {
        const normalized = normalizeMetricKey(rawKey);
        if (normalized === wanted) return true;
        const parts = rawKey.split(".");
        const leaf = parts[parts.length - 1] ?? rawKey;
        return normalizeMetricKey(leaf) === wanted;
      });
      if (!match) continue;
      const parsed = toNumberOrNull(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
};

const normalizeUtilization = (value: number | null): number => {
  if (value === null) return 0;
  if (value > 1) return safeNumber(value / 100);
  return safeNumber(value);
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

const sanitizeVaultName = (value: unknown) =>
  (typeof value === "string" ? value : String(value ?? ""))
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeKaminoVaultName = (value: unknown) => {
  const cleaned = sanitizeVaultName(value);
  if (!cleaned) return "Kamino Vault";
  return cleaned.replace(/^kamino\s+vault\s+/i, "") || cleaned;
};

const KAMINO_LEND_KNOWN_SLUGS = [
  "sentora-pyusd",
  "usdc-prime",
  "cash-earn",
  "allez-usdc",
  "elemental-usdc-optimizer",
  "allez-sol",
  "rockaway-rwa-usdc",
  "gauntlet-usdc-prime",
  "steakhouse-usdg-high-yield",
  "steakhouse-usd1-high-yield",
  "steakhouse-usdc-high-yield",
  "mev-capital-sol",
  "gauntlet-usdc-frontier",
  "elemental-usdg-optimizer",
  "gauntlet-sol-balanced",
  "usdg-prime",
  "elemental-usds-optimizer",
  "neutral-trade-usdc-max-yield",
  "allez-usds",
  "mev-capital-usdc",
  "mev-capital-usds",
  "elemental-sol-optimizer"
] as const;

const wordsForMatching = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

const fallbackSlugFromName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const resolveKaminoLendSlug = (vaultName: string): string | null => {
  const words = wordsForMatching(vaultName);
  if (!words.length) return null;
  const wordSet = new Set(words);

  let best: { slug: string; score: number } | null = null;
  for (const slug of KAMINO_LEND_KNOWN_SLUGS) {
    const slugWords = slug.split("-");
    const matches = slugWords.reduce((count, word) => count + (wordSet.has(word) ? 1 : 0), 0);
    if (matches === 0) continue;

    const complete = matches === slugWords.length ? 1 : 0;
    const firstWordBonus = slugWords[0] && wordSet.has(slugWords[0]) ? 0.5 : 0;
    const score = matches + complete + firstWordBonus;
    if (!best || score > best.score) {
      best = { slug, score };
    }
  }

  if (best) return best.slug;

  const fallback = fallbackSlugFromName(vaultName);
  return KAMINO_LEND_KNOWN_SLUGS.includes(fallback as (typeof KAMINO_LEND_KNOWN_SLUGS)[number])
    ? fallback
    : null;
};

async function buildKaminoVaults(): Promise<VaultMetric[]> {
  try {
    const res = await fetchWithRetry("https://api.kamino.finance/kvaults/vaults", {
      headers: kaminoHeaders
    });
    if (!res.ok) return [];
    const list = (await res.json()) as Array<{
      address?: string;
      state?: {
        name?: string;
        tokenMint?: string;
        tokenMintDecimals?: number;
        sharesMint?: string;
      };
    }>;
    if (!Array.isArray(list)) return [];

    const loadKaminoVaultRows = async (fetchPerVaultMetrics: boolean) => {
      const vaultBuildConcurrency = fetchPerVaultMetrics
        ? KAMINO_VAULT_BUILD_CONCURRENCY
        : 24;
      return mapWithConcurrency(list, vaultBuildConcurrency, async (vault) => {
        try {
          if (!vault?.address || !vault?.state?.name) return null;
          const vaultAny = vault as Record<string, unknown>;
          let metrics: {
            apy?: string;
            apyActual?: string;
            tokensAvailableUsd?: string;
            tokensInvestedUsd?: string;
            availableUsd?: string;
            investedUsd?: string;
            liquidityUsd?: string;
            borrowedUsd?: string;
            utilization?: string;
          } | null = null;
          if (fetchPerVaultMetrics) {
            try {
              const metricsUrls = [
                `https://api.kamino.finance/kvaults/${vault.address}/metrics`,
                `https://api.kamino.finance/kvaults/vaults/${vault.address}/metrics`
              ];
              for (const metricsUrl of metricsUrls) {
                const metricsRes = await fetchWithRetry(metricsUrl, { headers: kaminoHeaders });
                if (!metricsRes.ok) continue;
                metrics = (await metricsRes.json()) as {
                  apy?: string;
                  apyActual?: string;
                  tokensAvailableUsd?: string;
                  tokensInvestedUsd?: string;
                  availableUsd?: string;
                  investedUsd?: string;
                  liquidityUsd?: string;
                  borrowedUsd?: string;
                  utilization?: string;
                };
                break;
              }
            } catch {
              metrics = null;
            }
          }

          const metricSources: Array<Record<string, unknown> | null | undefined> = [
            metrics as unknown as Record<string, unknown>,
            (vaultAny.metrics as Record<string, unknown> | undefined) ?? undefined,
            (vaultAny.stats as Record<string, unknown> | undefined) ?? undefined,
            (vault.state as unknown as Record<string, unknown>) ?? undefined
          ];
          const availableUsdRaw = pickMetricValue(metricSources, [
            "tokensAvailableUsd",
            "availableUsd",
            "liquidityUsd",
            "availableLiquidityUsd"
          ]);
          const investedUsdRaw = pickMetricValue(metricSources, [
            "tokensInvestedUsd",
            "investedUsd",
            "investedAmountUsd"
          ]);
          const suppliedUsdRaw = pickMetricValue(metricSources, [
            "totalSuppliedUsd",
            "totalSupplyUsd",
            "suppliedUsd",
            "tvlUsd",
            "aumUsd",
            "totalAssetsUsd",
            "totalUsdIncludingFees"
          ]);
          const borrowedUsdRaw = pickMetricValue(metricSources, [
            "totalBorrowedUsd",
            "borrowedUsd",
            "borrowUsd"
          ]);
          const utilizationRaw = pickMetricValue(metricSources, [
            "utilization",
            "utilizationRatio",
            "utilizationPct",
            "util"
          ]);

          const availableUsd = clampUsd(
            availableUsdRaw ?? toNumberOrZero(metrics?.tokensAvailableUsd ?? metrics?.availableUsd ?? metrics?.liquidityUsd)
          );
          const investedUsd = clampUsd(
            investedUsdRaw ?? toNumberOrZero(metrics?.tokensInvestedUsd ?? metrics?.investedUsd ?? metrics?.borrowedUsd)
          );
          const suppliedUsd = clampUsd(suppliedUsdRaw ?? 0);
          const tvlUsd = suppliedUsd > 0 ? suppliedUsd : clampUsd(availableUsd + investedUsd);
          const utilizationFromApi = normalizeUtilization(utilizationRaw);
          const borrowedFromApi = borrowedUsdRaw !== null ? clampUsd(borrowedUsdRaw) : 0;
          const borrowedFromUtil =
            utilizationFromApi > 0 && tvlUsd > 0 ? clampUsd(tvlUsd * utilizationFromApi) : 0;
          const borrowedUsd = borrowedFromApi || borrowedFromUtil || clampUsd(investedUsd);
          const liquidityUsd =
            availableUsd > 0 ? clampUsd(availableUsd) : clampUsd(Math.max(0, tvlUsd - borrowedUsd));
          const utilization = tvlUsd > 0 ? safeNumber(borrowedUsd / tvlUsd) : 0;
          const apyRaw = toNumberOrZero(metrics?.apy ?? metrics?.apyActual);
          const apyTotal = normalizeApy(apyRaw);
          const poolName = "Kamino Lend";
          const vaultName = normalizeKaminoVaultName(vault.state.name);
          const assetSymbol = extractSymbolFromName(vaultName);
          const kaminoSlug = resolveKaminoLendSlug(vaultName);
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
            sharesMint: vault.state.sharesMint ?? undefined,
            vaultUrl: kaminoSlug ? `https://kamino.com/lend/${kaminoSlug}` : "https://kamino.com/lend",
            apyTotal,
            apyBase: apyTotal,
            apyRewards: 0,
            tvlUsd,
            liquidityUsd,
            borrowedUsd,
            utilization,
            updatedAt: new Date().toISOString()
          } satisfies VaultMetric;
        } catch {
          return null;
        }
      });
    };

    let vaults = await loadKaminoVaultRows(KAMINO_FETCH_PER_VAULT_METRICS);
    if (!KAMINO_FETCH_PER_VAULT_METRICS && !KAMINO_FORCE_BULK_ONLY) {
      const total = vaults.length;
      const nonZeroTvl = vaults.filter((vault) => vault.tvlUsd > 0).length;
      const uiEligibleTvl = vaults.filter((vault) => vault.tvlUsd >= 100_000).length;
      const hasReasonableTvlCoverage =
        total > 0 && (
          uiEligibleTvl >= 5 ||
          uiEligibleTvl / total >= 0.1 ||
          nonZeroTvl / total >= 0.25
        );
      if (!hasReasonableTvlCoverage) {
        vaults = await loadKaminoVaultRows(true);
      }
    }

    return vaults;
  } catch (err) {
    console.warn("Kamino vault fetch failed:", err instanceof Error ? err.message : err);
    return [];
  }
}


type LiveVaultOptions = { allowStale?: boolean };

const refreshVaults = async (): Promise<VaultMetric[]> => {
  if (vaultRefreshPromise) return vaultRefreshPromise;
  vaultRefreshPromise = (async () => {
    const now = Date.now();
    const data = await buildKaminoVaults();
    const ttl = data.length ? VAULT_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS;
    vaultCache = { data, expires: now + ttl };
    return data;
  })();

  try {
    return await vaultRefreshPromise;
  } finally {
    vaultRefreshPromise = null;
  }
};

export async function getLiveVaults(options: LiveVaultOptions = {}): Promise<VaultMetric[]> {
  const now = Date.now();
  if (vaultCache && vaultCache.expires > now) {
    return vaultCache.data.filter((vault) => vault.protocolId === "kamino");
  }
  if (options.allowStale && vaultCache) {
    void refreshVaults().catch(() => {});
    return vaultCache.data.filter((vault) => vault.protocolId === "kamino");
  }
  return refreshVaults();
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
