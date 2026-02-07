import { Router } from "express";
import { Transaction, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { getPrimaryConnection } from "../services/rpc.js";

export const transactionsRouter = Router();

transactionsRouter.post("/send", async (req, res) => {
  try {
    const payload = req.body as { base64?: string; version?: "legacy" | "v0" };
    if (!payload?.base64 || (payload.version !== "legacy" && payload.version !== "v0")) {
      res.status(400).json({ error: "Invalid transaction payload" });
      return;
    }
    const buffer = Buffer.from(payload.base64, "base64");
    const tx =
      payload.version === "v0"
        ? VersionedTransaction.deserialize(buffer)
        : Transaction.from(buffer);
    const connection = getPrimaryConnection();
    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });
    await connection.confirmTransaction(signature, "confirmed");
    res.json({ data: { signature } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send transaction";
    res.status(500).json({ error: message });
  }
});
