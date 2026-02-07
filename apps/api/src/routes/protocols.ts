import { Router } from "express";
import { protocols } from "../data/vaults.js";

export const protocolsRouter = Router();

protocolsRouter.get("/", (_req, res) => {
  res.json({ data: protocols });
});
