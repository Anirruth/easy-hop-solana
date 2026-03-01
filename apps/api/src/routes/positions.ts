import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { KaminoManager, KaminoVault } from "@kamino-finance/klend-sdk";
import { Farms, lamportsToCollDecimal, scaleDownWads } from "@kamino-finance/farms-sdk";
import { VaultPosition } from "../types.js";
import { getLiveVaults } from "../services/vaults.js";
import { getKaminoRpc, toKaminoAddress } from "../services/kamino.js";

export const positionsRouter = Router();

import { getPrimaryConnection } from "../services/rpc.js";

const toSafeNumber = (value: number) =>
  Number.isFinite(value) && value > 0 ? value : 0;

const kaminoRpc = () => getKaminoRpc() as unknown as any;

const fetchTokenBalancesByMint = async (
  connection: ReturnType<typeof getPrimaryConnection>,
  owner: PublicKey,
  programId: PublicKey
) => {
  const balances = new Map<string, number>();
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
      programId
    });
    accounts.value.forEach(({ account }) => {
      const parsed = (account.data as { parsed?: { info?: Record<string, unknown> } })?.parsed;
      const info = parsed?.info as { mint?: string; tokenAmount?: { uiAmount?: number; uiAmountString?: string } } | undefined;
      const mint = info?.mint;
      if (!mint) return;
      const amount =
        typeof info?.tokenAmount?.uiAmount === "number"
          ? info.tokenAmount.uiAmount
          : Number(info?.tokenAmount?.uiAmountString ?? 0);
      if (!Number.isFinite(amount) || amount <= 0) return;
      balances.set(mint, (balances.get(mint) ?? 0) + amount);
    });
  } catch (_err) {
    return balances;
  }
  return balances;
};

positionsRouter.get("/", async (req, res) => {
  try {
    const walletAddress = req.query.walletAddress?.toString();
    if (!walletAddress) {
      res.status(400).json({ error: "walletAddress is required" });
      return;
    }

    const user = new PublicKey(walletAddress);
    const connection = getPrimaryConnection();
    const [tokenBalances, token2022Balances] = await Promise.all([
      fetchTokenBalancesByMint(connection, user, TOKEN_PROGRAM_ID),
      fetchTokenBalancesByMint(connection, user, TOKEN_2022_PROGRAM_ID)
    ]);

    const positionsByVault = new Map<string, VaultPosition>();

    const vaults = await getLiveVaults({ allowStale: true });
    const kaminoVaults = vaults.filter((vault) => vault.protocolId === "kamino");
    if (kaminoVaults.length) {
      const rpc = kaminoRpc();
      const manager = new KaminoManager(rpc);
      const farms = new Farms(rpc);
      const userKaminoAddress = toKaminoAddress(user.toBase58());
      const kvaultAddresses = kaminoVaults
        .map((vault) => {
          const idValue =
            typeof vault.id === "string" ? vault.id : String(vault.id ?? "");
          return idValue.split(":")[1];
        })
        .filter((value): value is string => Boolean(value));
      let vaultByAddress = new Map<string, KaminoVault>();
      try {
        const vaultsLoaded = await manager.getVaults(
          kvaultAddresses.map((address) => toKaminoAddress(address))
        );
        vaultsLoaded.forEach((vault, index) => {
          if (!vault) return;
          const addr = kvaultAddresses[index];
          if (addr) vaultByAddress.set(addr, vault);
        });
      } catch (_err) {
        vaultByAddress = new Map();
      }

      let userFarmStates = new Map<string, { activeStakeScaled: unknown }>();
      try {
        const farmStates = await farms.getAllUserStatesForUser(userKaminoAddress);
        farmStates.forEach((entry) => {
          userFarmStates.set(entry.userState.farmState.toString(), entry.userState);
        });
      } catch {
        userFarmStates = new Map();
      }

      await Promise.all(kaminoVaults.map(async (vault) => {
        const idValue =
          typeof vault.id === "string" ? vault.id : String(vault.id ?? "");
        const kvaultAddress = idValue.split(":")[1];
        if (!kvaultAddress) {
          positionsByVault.set(vault.id, {
            vaultId: vault.id,
            depositedAmount: 0,
            availableAmount: 0
          });
          return;
        }

        try {
          let kvault = vaultByAddress.get(kvaultAddress);
          if (!kvault) {
            kvault = new KaminoVault(rpc, toKaminoAddress(kvaultAddress));
            await kvault.getState();
          }
          if (!kvault.state) {
            positionsByVault.set(vault.id, {
              vaultId: vault.id,
              depositedAmount: 0,
              availableAmount: 0
            });
            return;
          }
          const state = kvault.state;

          const sharesMint = state.sharesMint
            ? String(state.sharesMint)
            : "";
          const walletShares =
            (sharesMint ? tokenBalances.get(sharesMint) ?? 0 : 0) +
            (sharesMint ? token2022Balances.get(sharesMint) ?? 0 : 0);
          const farmAddress = state.vaultFarm
            ? String(state.vaultFarm)
            : "";
          let farmShares = 0;
          if (farmAddress && farmAddress !== "11111111111111111111111111111111") {
            const userState = userFarmStates.get(farmAddress);
            if (userState && (userState as { activeStakeScaled?: unknown }).activeStakeScaled) {
              const decimals = Number(state.sharesMintDecimals.toString());
              const activeStake = (userState as { activeStakeScaled: unknown }).activeStakeScaled as any;
              const scaled = scaleDownWads(activeStake);
              const tokens = lamportsToCollDecimal(scaled, decimals);
              farmShares = Number(tokens.toString());
            } else {
              try {
                const decimals = Number(state.sharesMintDecimals.toString());
                const farmTokens = await farms.getUserTokensInUndelegatedFarm(
                  userKaminoAddress,
                  toKaminoAddress(farmAddress),
                  decimals
                );
                farmShares = Number(farmTokens.toString());
              } catch {
                farmShares = 0;
              }
            }
          }

          const totalShares = walletShares + farmShares;
          if (totalShares <= 0) {
            positionsByVault.set(vault.id, {
              vaultId: vault.id,
              depositedAmount: 0,
              availableAmount: 0
            });
            return;
          }

          let amount = 0;
          try {
            const rate = await kvault.getExchangeRate();
            amount = toSafeNumber(Number(rate.toString()) * totalShares);
          } catch {
            amount = toSafeNumber(totalShares);
          }
          positionsByVault.set(vault.id, {
            vaultId: vault.id,
            depositedAmount: amount,
            availableAmount: amount
          });
        } catch (_err) {
          positionsByVault.set(vault.id, {
            vaultId: vault.id,
            depositedAmount: 0,
            availableAmount: 0
          });
        }
      }));
    }

    const positions = vaults.map((vault) => {
      return (
        positionsByVault.get(vault.id) ?? {
          vaultId: vault.id,
          depositedAmount: 0,
          availableAmount: 0
        }
      );
    });

    res.json({ data: { positions } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load positions";
    res.status(500).json({ error: message });
  }
});
