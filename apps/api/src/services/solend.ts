import SwitchboardProgram from "@switchboard-xyz/sbv2-lite";
import type { Connection } from "@solana/web3.js";

type SwitchboardModule = {
  loadMainnet?: (connection?: Connection) => Promise<unknown>;
  load?: (connection?: Connection) => Promise<unknown>;
  default?: {
    loadMainnet?: (connection?: Connection) => Promise<unknown>;
    load?: (connection?: Connection) => Promise<unknown>;
  };
};

export async function loadSwitchboardProgram(connection: Connection) {
  const mod = SwitchboardProgram as unknown as SwitchboardModule;
  const loader =
    mod.loadMainnet ??
    mod.default?.loadMainnet ??
    mod.load ??
    mod.default?.load;
  if (!loader) {
    throw new Error("SwitchboardProgram loader not available");
  }
  return loader(connection);
}
