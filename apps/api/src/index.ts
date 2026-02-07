import "dotenv/config";
import "./fetch-polyfill.js";

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

import express from "express";
import cors from "cors";
import { vaultsRouter } from "./routes/vaults.js";
import { protocolsRouter } from "./routes/protocols.js";
import { moveRouter } from "./routes/move.js";
import { positionsRouter } from "./routes/positions.js";
import { transactionsRouter } from "./routes/transactions.js";

const app = express();
const port = Number(process.env.PORT) || 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.use("/vaults", vaultsRouter);
app.use("/protocols", protocolsRouter);
app.use("/move", moveRouter);
app.use("/positions", positionsRouter);
app.use("/transactions", transactionsRouter);

app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
  if (process.env.SOLANA_RPC_URL) {
    console.log("Using SOLANA_RPC_URL from environment");
  }
}).on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the other process or run with PORT=${port + 1} npm run dev`);
    process.exit(1);
  }
  throw err;
});
