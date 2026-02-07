import { VaultHistoryPoint } from "../types.js";

const days = 30;

const randomWithin = (base: number, variance: number) =>
  Number((base + (Math.random() - 0.5) * variance).toFixed(2));

export const buildHistory = (apyBase: number, tvlBase: number) => {
  const points: VaultHistoryPoint[] = [];
  for (let i = days; i >= 0; i -= 1) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    points.push({
      timestamp: date.toISOString(),
      apyTotal: randomWithin(apyBase, 0.6),
      tvlUsd: Math.max(1, Math.round(randomWithin(tvlBase, tvlBase * 0.08)))
    });
  }
  return points;
};
