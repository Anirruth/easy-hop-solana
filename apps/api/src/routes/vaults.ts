import { Router } from "express";
import { buildHistory } from "../data/history.js";
import { getLiveVaults } from "../services/vaults.js";

export const vaultsRouter = Router();

vaultsRouter.get("/", async (_req, res) => {
  try {
    const liveVaults = await getLiveVaults({ allowStale: true });
    res.json({ data: liveVaults });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load vaults";
    res.status(500).json({ error: message });
  }
});

vaultsRouter.get("/:id", async (req, res) => {
  try {
    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === req.params.id);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }
    res.json({ data: vault });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load vault";
    res.status(500).json({ error: message });
  }
});

vaultsRouter.get("/:id/history", async (req, res) => {
  try {
    const liveVaults = await getLiveVaults({ allowStale: true });
    const vault = liveVaults.find((item) => item.id === req.params.id);
    if (!vault) {
      res.status(404).json({ error: "Vault not found" });
      return;
    }
    const history = buildHistory(vault.apyTotal, vault.tvlUsd);
    res.json({ data: history });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load vault history";
    res.status(500).json({ error: message });
  }
});
