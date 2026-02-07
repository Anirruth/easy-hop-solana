import { VaultMetric, VaultPosition } from "./types";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:4000";

const networkErrorHint = `Cannot reach the API at ${API_BASE}. Start it with: cd apps/api && npm run dev`;

async function apiFetch(url: string): Promise<Response> {
  try {
    return await fetch(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "Failed to fetch" || (err instanceof TypeError && msg.includes("fetch"))) {
      throw new Error(networkErrorHint);
    }
    throw err;
  }
}

export const fetchVaults = async (): Promise<VaultMetric[]> => {
  const res = await apiFetch(`${API_BASE}/vaults`);
  if (!res.ok) {
    throw new Error("Failed to load vaults");
  }
  const json = await res.json();
  return json.data as VaultMetric[];
};

export const fetchPositions = async (
  walletAddress: string
): Promise<VaultPosition[]> => {
  const res = await apiFetch(
    `${API_BASE}/positions?walletAddress=${encodeURIComponent(walletAddress)}`
  );
  if (!res.ok) {
    throw new Error("Failed to load positions");
  }
  const json = await res.json();
  return json.data.positions as VaultPosition[];
};

