import { useEffect, useMemo, useState } from "react";
import { fetchPositions, fetchVaults } from "./api";
import { VaultMetric, VaultPosition } from "./types";
import {
  connectWallet,
  disconnectWallet,
  getWalletProvider,
  WalletProvider
} from "./wallet";
import { depositFunds, depositFundsFromSol, moveFunds } from "./move";

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);

const formatPercent = (value: number) => `${value.toFixed(2)}%`;

const formatTokenAmount = (value: number, symbol: string) =>
  `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4
  }).format(value)} ${symbol}`;

const PROTOCOL_LABELS: Record<string, string> = {
  solend: "Solend",
  kamino: "Kamino Lend"
};

const canMove = (fromVault?: VaultMetric, toVault?: VaultMetric) =>
  Boolean(fromVault && toVault && fromVault.id !== toVault.id);

type SortKey = "apyTotal" | "tvlUsd" | "liquidityUsd";
const PAGE_SIZE = 25;

export default function App() {
  const [vaults, setVaults] = useState<VaultMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fromVaultId, setFromVaultId] = useState("");
  const [toVaultId, setToVaultId] = useState("");
  const [moveAmount, setMoveAmount] = useState("");
  const [depositVaultId, setDepositVaultId] = useState("");
  const [depositAmount, setDepositAmount] = useState("");
  const [depositSolAmount, setDepositSolAmount] = useState("");
  const [depositSource, setDepositSource] = useState<"asset" | "sol">("asset");
  const [wallet, setWallet] = useState<WalletProvider | null>(null);
  const [moveResult, setMoveResult] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [depositResult, setDepositResult] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, VaultPosition>>({});
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("apyTotal");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pageIndex, setPageIndex] = useState(0);

  useEffect(() => {
    let mounted = true;
    fetchVaults()
      .then((data) => {
        if (mounted) {
          setVaults(data);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const provider = getWalletProvider();
    if (provider?.publicKey) {
      setWallet(provider);
    }
  }, []);

  useEffect(() => {
    const walletAddress = wallet?.publicKey?.toBase58();
    if (!walletAddress) {
      setPositions({});
      return;
    }

    let mounted = true;
    setPositionsLoading(true);
    fetchPositions(walletAddress)
      .then((data) => {
        if (!mounted) return;
        const mapped = data.reduce<Record<string, VaultPosition>>(
          (acc, position) => {
            acc[position.vaultId] = position;
            return acc;
          },
          {}
        );
        setPositions(mapped);
      })
      .catch((err) => {
        if (mounted) {
          setMoveResult(
            err instanceof Error ? err.message : "Failed to load positions."
          );
        }
      })
      .finally(() => {
        if (mounted) {
          setPositionsLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [wallet?.publicKey?.toBase58()]);

  const vaultOptions = useMemo(
    () =>
      vaults.map((vault) => ({
        value: vault.id,
        label: `${vault.protocolName} • ${vault.poolName} • ${vault.vaultName} (${vault.assetSymbol})`
      })),
    [vaults]
  );
  const fromVaultOptions = useMemo(() => {
    if (!wallet) return vaultOptions;
    const withPositions = vaults.filter(
      (vault) => (positions[vault.id]?.depositedAmount ?? 0) > 0
    );
    if (!withPositions.length) return vaultOptions;
    return withPositions.map((vault) => ({
      value: vault.id,
      label: `${vault.protocolName} • ${vault.poolName} • ${vault.vaultName} (${vault.assetSymbol})`
    }));
  }, [vaultOptions, vaults, positions, wallet]);

  const fromVault = vaults.find((vault) => vault.id === fromVaultId);
  const toVault = vaults.find((vault) => vault.id === toVaultId);
  const depositVault = vaults.find((vault) => vault.id === depositVaultId);
  const fromPosition = fromVault ? positions[fromVault.id] : undefined;
  const availableAmount = fromPosition?.availableAmount ?? 0;
  const depositedAmount = fromPosition?.depositedAmount ?? 0;
  useEffect(() => {
    if (!fromVault) {
      setMoveAmount("");
      return;
    }
    setMoveAmount((current) => (current ? current : availableAmount.toString()));
  }, [fromVault?.id, availableAmount]);

  const kaminoPositionRows = useMemo(() => {
    return vaults
      .filter((vault) => vault.protocolId === "kamino")
      .map((vault) => {
        const position = positions[vault.id];
        const deposited = position?.depositedAmount ?? 0;
        const available = position?.availableAmount ?? 0;
        return {
          vault,
          deposited,
          available,
          hasBalance: deposited > 0 || available > 0
        };
      })
      .sort((a, b) => b.deposited - a.deposited);
  }, [vaults, positions]);

  const kaminoPositionsWithBalance = useMemo(
    () => kaminoPositionRows.filter((row) => row.hasBalance),
    [kaminoPositionRows]
  );

  const sortedVaults = useMemo(() => {
    const sorted = vaults.slice().sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      const diff = av - bv;
      return sortDir === "asc" ? diff : -diff;
    });
    return sorted;
  }, [vaults, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedVaults.length / PAGE_SIZE));
  const currentPage = Math.min(pageIndex, totalPages - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageVaults = sortedVaults.slice(pageStart, pageStart + PAGE_SIZE);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setPageIndex(0);
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return "↕";
    return sortDir === "asc" ? "↑" : "↓";
  };

  const formatConnectError = (err: unknown) => {
    if (err instanceof Error) {
      const rawCode = (err as unknown as { code?: unknown }).code;
      const code = typeof rawCode === "number" ? ` (code ${rawCode})` : "";
      if (
        rawCode === -32603 &&
        err.message.toLowerCase().includes("unexpected error")
      ) {
        return "Wallet returned an internal error. Make sure the wallet is unlocked and the site is loaded on https or localhost.";
      }
      return `${err.name}: ${err.message}${code}`.trim();
    }
    if (typeof err === "string") return err;
    if (err && typeof err === "object") {
      const message = (err as { message?: unknown }).message;
      const code = (err as { code?: unknown }).code;
      if (typeof message === "string" && typeof code === "number") {
        return `${message} (code ${code})`;
      }
      if (typeof message === "string") {
        return message;
      }
    }
    try {
      return JSON.stringify(err);
    } catch {
      return "Failed to connect wallet.";
    }
  };

  const handleConnect = async () => {
    try {
      const provider = await connectWallet();
      setWallet(provider);
    } catch (err) {
      console.error("Wallet connect failed", err);
      const message = formatConnectError(err);
      setMoveResult(message || "Failed to connect wallet.");
    }
  };

  const handleDisconnect = async () => {
    if (!wallet) return;
    await disconnectWallet(wallet);
    setWallet(null);
  };

  const handleMove = async () => {
    if (!fromVault || !toVault) {
      setMoveResult("Select both a source and destination vault.");
      return;
    }

    if (availableAmount <= 0) {
      setMoveResult("No available balance to move from this vault.");
      return;
    }

    const amount = Number(moveAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setMoveResult("Enter a valid amount to move.");
      return;
    }
    if (amount > availableAmount) {
      setMoveResult("Amount exceeds available balance in this vault.");
      return;
    }

    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setMoveResult("Connect your wallet to continue.");
      return;
    }

    setMoving(true);
    setMoveResult(null);
    try {
      await moveFunds(provider, fromVault, toVault, amount);
      setMoveResult("Move complete. Funds deposited into the new vault.");
    } catch (err) {
      setMoveResult(
        err instanceof Error ? err.message : "Failed to move position."
      );
    } finally {
      setMoving(false);
    }
  };

  const handleDeposit = async () => {
    if (!depositVault) {
      setDepositResult("Select a vault to deposit into.");
      return;
    }
    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setDepositResult("Connect your wallet to continue.");
      return;
    }

    setDepositing(true);
    setDepositResult(null);
    try {
      if (depositSource === "sol") {
        if (depositVault.protocolId !== "kamino") {
          setDepositResult("SOL deposits are only supported for Kamino vaults.");
          return;
        }
        const amountSol = Number(depositSolAmount);
        if (!Number.isFinite(amountSol) || amountSol <= 0) {
          setDepositResult("Enter a valid SOL amount.");
          return;
        }
        await depositFundsFromSol(provider, depositVault, amountSol);
        setDepositResult("Deposit complete.");
      } else {
        const amount = Number(depositAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          setDepositResult("Enter a valid deposit amount.");
          return;
        }
        await depositFunds(provider, depositVault, amount);
        setDepositResult("Deposit complete.");
      }
    } catch (err) {
      setDepositResult(
        err instanceof Error ? err.message : "Failed to deposit into vault."
      );
    } finally {
      setDepositing(false);
    }
  };

  const truncateAddress = (addr: string) =>
    addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;

  if (loading) {
    return (
      <div className="page">
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p className="muted">Loading vaults...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <div className="card" style={{ textAlign: "center", padding: "48px 24px" }}>
          <p className="error">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">EasyHop Solana</p>
          <h1>Lending vault aggregator</h1>
          <p className="subhead">
            Compare yields and move funds across Solend and Kamino Lend in one place.
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <div className="pill">Lending</div>
          {wallet ? (
            <button className="ghost" onClick={handleDisconnect}>
              {truncateAddress(wallet.publicKey?.toBase58() ?? "")}
            </button>
          ) : (
            <button className="primary" onClick={handleConnect}>
              Connect
            </button>
          )}
        </div>
      </header>

      {wallet && (
        <section className="card">
          <h2>Your positions</h2>
          <p className="muted">Active Kamino Lend deposits detected from your wallet.</p>
          {kaminoPositionsWithBalance.length > 0 ? (
            <div className="table" style={{ marginTop: "14px" }}>
              <div className="row header-row positions-row">
                <span>Vault</span>
                <span>Asset</span>
                <span>Deposited</span>
                <span>Available</span>
                <span></span>
              </div>
              {kaminoPositionsWithBalance.map((row) => (
                <div key={row.vault.id} className="row positions-row">
                  <div>
                    <strong style={{ fontSize: "13px" }}>{row.vault.vaultName}</strong>
                    <div className="muted" style={{ fontSize: "11px" }}>{row.vault.poolName}</div>
                  </div>
                  <span>{row.vault.assetSymbol}</span>
                  <span style={{ fontWeight: 600 }}>
                    {formatTokenAmount(row.deposited, row.vault.assetSymbol)}
                  </span>
                  <span>{formatTokenAmount(row.available, row.vault.assetSymbol)}</span>
                  <span className="tag strong">Active</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted" style={{ marginTop: "12px" }}>
              {positionsLoading ? "Scanning..." : "No active Kamino positions found."}
            </p>
          )}
        </section>
      )}

      <section className="card">
        <h2>Move funds</h2>
        <p className="muted">Withdraw from one vault and deposit into another. Swap included if assets differ.</p>
        <div className="move-grid">
          <label>
            Source vault
            <select
              value={fromVaultId}
              onChange={(event) => setFromVaultId(event.target.value)}
            >
              <option value="">Select source</option>
              {fromVaultOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination vault
            <select
              value={toVaultId}
              onChange={(event) => setToVaultId(event.target.value)}
            >
              <option value="">Select destination</option>
              {vaultOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount
            <input
              type="number"
              min="0"
              step="any"
              value={moveAmount}
              onChange={(event) => setMoveAmount(event.target.value)}
              placeholder="0.0"
            />
          </label>
        </div>
        {fromVault && (
          <div className="position-summary">
            <div>
              <span className="muted">Deposited</span>
              <span className="position-value">
                {formatTokenAmount(depositedAmount, fromVault.assetSymbol)}
              </span>
            </div>
            <div>
              <span className="muted">Available</span>
              <span className="position-value">
                {formatTokenAmount(availableAmount, fromVault.assetSymbol)}
              </span>
            </div>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <button
            className="primary"
            onClick={handleMove}
            disabled={
              moving ||
              positionsLoading ||
              availableAmount <= 0 ||
              !canMove(fromVault, toVault)
            }
          >
            {moving ? "Processing..." : "Move funds"}
          </button>
          {fromVault &&
            toVault &&
            fromVault.assetMint !== toVault.assetMint && (
              <span className="muted" style={{ fontSize: "12px" }}>
                Includes Jupiter swap
              </span>
            )}
        </div>
        {moveResult && <p className="result">{moveResult}</p>}
      </section>

      <section className="card">
        <h2>Deposit</h2>
        <p className="muted">Deposit directly into any vault from your wallet or SOL balance.</p>
        <div className="move-grid">
          <label>
            Vault
            <select
              value={depositVaultId}
              onChange={(event) => setDepositVaultId(event.target.value)}
            >
              <option value="">Select vault</option>
              {vaultOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Pay with
            <select
              value={depositSource}
              onChange={(event) =>
                setDepositSource(event.target.value === "sol" ? "sol" : "asset")
              }
            >
              <option value="asset">Vault asset from wallet</option>
              <option value="sol">SOL (auto-swap via Jupiter)</option>
            </select>
          </label>
          {depositSource === "sol" ? (
            <label>
              SOL amount
              <input
                type="number"
                min="0"
                step="any"
                value={depositSolAmount}
                onChange={(event) => setDepositSolAmount(event.target.value)}
                placeholder="0.0"
              />
            </label>
          ) : (
            <label>
              Amount
              <input
                type="number"
                min="0"
                step="any"
                value={depositAmount}
                onChange={(event) => setDepositAmount(event.target.value)}
                placeholder="0.0"
              />
            </label>
          )}
        </div>
        <button className="primary" onClick={handleDeposit} disabled={depositing}>
          {depositing ? "Processing..." : "Deposit"}
        </button>
        {depositResult && <p className="result">{depositResult}</p>}
      </section>

      <section className="card">
        <div className="vaults-header">
          <div>
            <h2>All vaults</h2>
            <p className="muted" style={{ marginTop: "2px" }}>
              {sortedVaults.length} vaults
              {!wallet && " · connect wallet to see your balances"}
            </p>
          </div>
        </div>
        <div className="table">
          <div
            className="row header-row"
            style={{
              gridTemplateColumns: wallet
                ? "0.9fr 1.6fr 0.5fr 0.6fr 0.8fr 0.8fr 0.5fr 0.7fr 0.7fr 0.5fr"
                : "0.9fr 1.6fr 0.5fr 0.6fr 0.8fr 0.8fr 0.5fr 0.5fr"
            }}
          >
            <span>Protocol</span>
            <span>Pool / Vault</span>
            <span>Asset</span>
            <button
              type="button"
              className="sort-button"
              onClick={() => handleSort("apyTotal")}
            >
              APY <span className="sort-indicator">{sortIndicator("apyTotal")}</span>
            </button>
            <button
              type="button"
              className="sort-button"
              onClick={() => handleSort("tvlUsd")}
            >
              TVL <span className="sort-indicator">{sortIndicator("tvlUsd")}</span>
            </button>
            <button
              type="button"
              className="sort-button"
              onClick={() => handleSort("liquidityUsd")}
            >
              Liquidity{" "}
              <span className="sort-indicator">{sortIndicator("liquidityUsd")}</span>
            </button>
            <span>Util</span>
            {wallet && <span>Lent</span>}
            {wallet && <span>Available</span>}
            <span></span>
          </div>
          {pageVaults.map((vault) => {
            const position = positions[vault.id];
            return (
              <div
                className="row"
                key={vault.id}
                style={{
                  gridTemplateColumns: wallet
                    ? "0.9fr 1.6fr 0.5fr 0.6fr 0.8fr 0.8fr 0.5fr 0.7fr 0.7fr 0.5fr"
                    : "0.9fr 1.6fr 0.5fr 0.6fr 0.8fr 0.8fr 0.5fr 0.5fr"
                }}
              >
                <span className="tag">
                  {PROTOCOL_LABELS[vault.protocolId]}
                </span>
                <div>
                  <strong style={{ fontSize: "13px" }}>{vault.vaultName}</strong>
                  <div className="muted" style={{ fontSize: "11px" }}>{vault.poolName}</div>
                </div>
                <span>{vault.assetSymbol}</span>
                <span className="strong">{formatPercent(vault.apyTotal)}</span>
                <span>{formatUsd(vault.tvlUsd)}</span>
                <span>{formatUsd(vault.liquidityUsd)}</span>
                <span>{formatPercent(vault.utilization * 100)}</span>
                {wallet && (
                  <span>
                    {position
                      ? formatTokenAmount(position.depositedAmount, vault.assetSymbol)
                      : "—"}
                  </span>
                )}
                {wallet && (
                  <span>
                    {position
                      ? formatTokenAmount(position.availableAmount, vault.assetSymbol)
                      : "—"}
                  </span>
                )}
                <span>
                  <a
                    href={vault.vaultUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="vault-link-button"
                    title={`Lend on ${PROTOCOL_LABELS[vault.protocolId]}`}
                  >
                    Lend&thinsp;→
                  </a>
                </span>
              </div>
            );
          })}
        </div>
        {totalPages > 1 && (
          <div className="pagination">
            <span className="muted">
              {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, sortedVaults.length)} of{" "}
              {sortedVaults.length}
            </span>
            <div className="pagination-controls">
              <button
                className="ghost"
                onClick={() => setPageIndex(currentPage - 1)}
                disabled={currentPage === 0}
              >
                ← Prev
              </button>
              <span className="muted" style={{ fontSize: "12px" }}>
                {currentPage + 1} / {totalPages}
              </span>
              <button
                className="ghost"
                onClick={() => setPageIndex(currentPage + 1)}
                disabled={currentPage >= totalPages - 1}
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
