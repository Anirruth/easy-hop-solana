import { useEffect, useMemo, useState } from "react";
import { Connection, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { fetchPositions, fetchVaults } from "./api";
import { VaultMetric, VaultPosition } from "./types";
import {
  connectWallet,
  disconnectWallet,
  getWalletProvider,
  WalletProvider
} from "./wallet";
import {
  AccountSetupPreview,
  FeeDiagnostics,
  FundProgressEvent,
  TransactionProgressEvent,
  createDepositAccounts,
  depositFunds,
  depositFundsFromSol,
  previewSolFundQuote,
  previewDepositAccounts,
  SolFundQuote,
  swapAsset,
  swapAssetToSol,
  withdrawFunds,
  closeTokenAccounts
} from "./move";

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
const formatSol = (value: number) =>
  `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 6
  }).format(value)} SOL`;

const toBaseUnits = (amount: number, decimals: number) =>
  Math.floor(Math.max(0, amount) * 10 ** decimals + Number.EPSILON);

const toInputAmount = (amount: number, decimals: number) => {
  if (!Number.isFinite(amount) || amount <= 0) return "0";
  const precision = Math.min(12, Math.max(0, decimals));
  const factor = 10 ** precision;
  const roundedDown = Math.floor(amount * factor + Number.EPSILON) / factor;
  return roundedDown.toFixed(precision).replace(/\.?0+$/, "");
};

const exceedsAvailableBalance = (amount: number, available: number) =>
  amount - available > Math.max(1e-9, Math.abs(available) * 1e-9);

const SOL_MINT = "So11111111111111111111111111111111111111112";

const ENV_RPC = import.meta.env.VITE_SOLANA_RPC_URL?.trim() ?? "";
const DEFAULT_RPCS = (
  ENV_RPC
    ? [ENV_RPC]
    : ["https://api.mainnet-beta.solana.com", "https://rpc.ankr.com/solana"]
) as string[];

const PROTOCOL_LABELS: Record<string, string> = {
  kamino: "Kamino Lend"
};

type SortKey = "apyTotal" | "tvlUsd";
const PAGE_SIZE = 25;
const MIN_VAULT_TVL_USD = 100_000;
const UI_PREFS_KEY = "easyhop_ui_prefs_v2";
type ProgressStatus = "pending" | "in_progress" | "confirmed" | "failed";
type TxFlowStep = {
  label: string;
  status: ProgressStatus;
  signature?: string;
};

type UiPrefs = {
  action?: "deposit" | "withdraw" | "hop";
  query?: string;
  depositSlippage?: string;
  withdrawSlippage?: string;
  hopSlippage?: string;
  depositPriorityFee?: "auto" | "low" | "off";
  withdrawPriorityFee?: "auto" | "low" | "off";
  hopPriorityFee?: "auto" | "low" | "off";
};

export default function App() {
  const [vaults, setVaults] = useState<VaultMetric[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [moveAmount, setMoveAmount] = useState("");
  const [depositVaultId, setDepositVaultId] = useState("");
  const [depositSolAmount, setDepositSolAmount] = useState("");
  const [depositSource, setDepositSource] = useState<"sol" | "wallet">("sol");
  const [depositSlippage, setDepositSlippage] = useState("0.5");
  const [depositPriorityFee, setDepositPriorityFee] = useState<"auto" | "low" | "off">("off");
  const [depositTokenBalance, setDepositTokenBalance] = useState<number | null>(null);
  const [depositTokenBalanceLoading, setDepositTokenBalanceLoading] = useState(false);
  const [depositTokenBalanceError, setDepositTokenBalanceError] = useState<string | null>(null);
  const [depositSetup, setDepositSetup] = useState<AccountSetupPreview | null>(null);
  const [depositSetupLoading, setDepositSetupLoading] = useState(false);
  const [depositSetupError, setDepositSetupError] = useState<string | null>(null);
  const [withdrawVaultId, setWithdrawVaultId] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [withdrawTarget, setWithdrawTarget] = useState<"asset" | "sol">("asset");
  const [withdrawSlippage, setWithdrawSlippage] = useState("0.5");
  const [withdrawPriorityFee, setWithdrawPriorityFee] = useState<"auto" | "low" | "off">("off");
  const [wallet, setWallet] = useState<WalletProvider | null>(null);
  const [depositing, setDepositing] = useState(false);
  const [depositResult, setDepositResult] = useState<string | null>(null);
  const [depositFlow, setDepositFlow] = useState<{
    visible: boolean;
    swap: ProgressStatus;
    deposit: ProgressStatus;
  }>({
    visible: false,
    swap: "pending",
    deposit: "pending"
  });
  const [depositFeeDebug, setDepositFeeDebug] = useState(false);
  const [depositFeeDetails, setDepositFeeDetails] = useState<FeeDiagnostics | null>(null);
  const [solFundQuote, setSolFundQuote] = useState<SolFundQuote | null>(null);
  const [solFundQuoteLoading, setSolFundQuoteLoading] = useState(false);
  const [solFundQuoteError, setSolFundQuoteError] = useState<string | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [withdrawResult, setWithdrawResult] = useState<string | null>(null);
  const [withdrawFlow, setWithdrawFlow] = useState<TxFlowStep[]>([]);
  const [withdrawFeeDebug, setWithdrawFeeDebug] = useState(false);
  const [withdrawFeeDetails, setWithdrawFeeDetails] = useState<FeeDiagnostics | null>(null);
  const [manualSwapping, setManualSwapping] = useState(false);
  const [manualSwapResult, setManualSwapResult] = useState<string | null>(null);
  const [manualSwapFeeDetails, setManualSwapFeeDetails] = useState<FeeDiagnostics | null>(null);
  const [positions, setPositions] = useState<Record<string, VaultPosition>>({});
  const [positionsLoading, setPositionsLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("apyTotal");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [pageIndex, setPageIndex] = useState(0);
  const [activeAction, setActiveAction] = useState<"deposit" | "withdraw" | "hop">("deposit");
  const [vaultQuery, setVaultQuery] = useState("");
  const [selectedVaultId, setSelectedVaultId] = useState("");
  const [hopFromVaultId, setHopFromVaultId] = useState("");
  const [hopToVaultId, setHopToVaultId] = useState("");
  const [hopSelectMode, setHopSelectMode] = useState<"from" | "to" | null>(null);
  const [solBalance, setSolBalance] = useState<number | null>(null);
  const [solBalanceLoading, setSolBalanceLoading] = useState(false);
  const [solBalanceError, setSolBalanceError] = useState<string | null>(null);
  const [hopping, setHopping] = useState(false);
  const [hopResult, setHopResult] = useState<string | null>(null);
  const [hopFlow, setHopFlow] = useState<TxFlowStep[]>([]);
  const [hopAmount, setHopAmount] = useState("");
  const [hopSlippage, setHopSlippage] = useState("0.5");
  const [hopPriorityFee, setHopPriorityFee] = useState<"auto" | "low" | "off">("off");
  const [hopFeeDebug, setHopFeeDebug] = useState(false);
  const [hopFeeDetails, setHopFeeDetails] = useState<FeeDiagnostics | null>(null);
  const [closingAccounts, setClosingAccounts] = useState(false);
  const [closeAccountsResult, setCloseAccountsResult] = useState<string | null>(null);
  const [closeAccountsFeeDetails, setCloseAccountsFeeDetails] = useState<FeeDiagnostics | null>(null);

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
    try {
      const raw = localStorage.getItem(UI_PREFS_KEY);
      if (!raw) return;
      const prefs = JSON.parse(raw) as UiPrefs;
      if (prefs.action) setActiveAction(prefs.action);
      if (typeof prefs.query === "string") setVaultQuery(prefs.query);
      if (typeof prefs.depositSlippage === "string") setDepositSlippage(prefs.depositSlippage);
      if (typeof prefs.withdrawSlippage === "string") setWithdrawSlippage(prefs.withdrawSlippage);
      if (typeof prefs.hopSlippage === "string") setHopSlippage(prefs.hopSlippage);
      if (prefs.depositPriorityFee) setDepositPriorityFee(prefs.depositPriorityFee);
      if (prefs.withdrawPriorityFee) setWithdrawPriorityFee(prefs.withdrawPriorityFee);
      if (prefs.hopPriorityFee) setHopPriorityFee(prefs.hopPriorityFee);
    } catch {
      // Ignore invalid local storage state.
    }
  }, []);

  useEffect(() => {
    const prefs: UiPrefs = {
      action: activeAction,
      query: vaultQuery,
      depositSlippage,
      withdrawSlippage,
      hopSlippage,
      depositPriorityFee,
      withdrawPriorityFee,
      hopPriorityFee
    };
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore write failures (private mode, etc.).
    }
  }, [
    activeAction,
    vaultQuery,
    depositSlippage,
    withdrawSlippage,
    hopSlippage,
    depositPriorityFee,
    withdrawPriorityFee,
    hopPriorityFee
  ]);

  const refreshSolBalance = async (isMounted: () => boolean) => {
    if (!wallet?.publicKey) return;
    setSolBalanceLoading(true);
    setSolBalanceError(null);
    const fetchBalance = async () => {
      for (const rpcUrl of DEFAULT_RPCS) {
        try {
          const connection = new Connection(rpcUrl, "confirmed");
          const lamports = await connection.getBalance(wallet.publicKey!, "confirmed");
          return lamports;
        } catch {
          continue;
        }
      }
      throw new Error("All RPCs failed");
    };
    try {
      const lamports = await fetchBalance();
      if (isMounted()) {
        setSolBalance(lamports / LAMPORTS_PER_SOL);
      }
    } catch {
      if (isMounted()) {
        setSolBalance(null);
        setSolBalanceError("Failed to load balance. Set VITE_SOLANA_RPC_URL in env and refresh.");
      }
    } finally {
      if (isMounted()) {
        setSolBalanceLoading(false);
      }
    }
  };

  const readWalletMintBalance = async (
    walletPublicKey: PublicKey,
    mintAddress: string
  ): Promise<number> => {
    if (mintAddress === SOL_MINT) {
      for (const rpcUrl of DEFAULT_RPCS) {
        try {
          const connection = new Connection(rpcUrl, "confirmed");
          const lamports = await connection.getBalance(walletPublicKey, "confirmed");
          return lamports / LAMPORTS_PER_SOL;
        } catch {
          continue;
        }
      }
      throw new Error("All RPCs failed");
    }

    const mint = new PublicKey(mintAddress);
    for (const rpcUrl of DEFAULT_RPCS) {
      try {
        const connection = new Connection(rpcUrl, "confirmed");
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          walletPublicKey,
          { mint },
          "confirmed"
        );
        return tokenAccounts.value.reduce((sum, accountInfo) => {
          const tokenAmount = (accountInfo.account.data as any)?.parsed?.info?.tokenAmount;
          const uiAmountString = tokenAmount?.uiAmountString;
          const uiAmount =
            typeof uiAmountString === "string" && uiAmountString.trim()
              ? Number(uiAmountString)
              : Number(tokenAmount?.uiAmount ?? 0);
          return Number.isFinite(uiAmount) ? sum + uiAmount : sum;
        }, 0);
      } catch {
        continue;
      }
    }
    throw new Error("All RPCs failed");
  };

  const readWalletMintBalanceBaseUnits = async (
    walletPublicKey: PublicKey,
    mintAddress: string
  ): Promise<bigint> => {
    if (mintAddress === SOL_MINT) {
      for (const rpcUrl of DEFAULT_RPCS) {
        try {
          const connection = new Connection(rpcUrl, "confirmed");
          const lamports = await connection.getBalance(walletPublicKey, "confirmed");
          return BigInt(lamports);
        } catch {
          continue;
        }
      }
      throw new Error("All RPCs failed");
    }

    const mint = new PublicKey(mintAddress);
    for (const rpcUrl of DEFAULT_RPCS) {
      try {
        const connection = new Connection(rpcUrl, "confirmed");
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
          walletPublicKey,
          { mint },
          "confirmed"
        );
        return tokenAccounts.value.reduce((sum, accountInfo) => {
          const tokenAmount = (accountInfo.account.data as any)?.parsed?.info?.tokenAmount;
          const rawAmount = tokenAmount?.amount;
          if (typeof rawAmount === "string" && rawAmount.trim()) {
            return sum + BigInt(rawAmount);
          }
          return sum;
        }, 0n);
      } catch {
        continue;
      }
    }
    throw new Error("All RPCs failed");
  };

  useEffect(() => {
    if (!wallet?.publicKey) {
      setSolBalance(null);
      setSolBalanceError(null);
      return;
    }
    let mounted = true;
    refreshSolBalance(() => mounted);
    return () => {
      mounted = false;
    };
  }, [wallet?.publicKey?.toBase58()]);

  const loadPositions = async (
    walletAddress: string,
    reportErrors = true,
    isMounted: () => boolean = () => true
  ) => {
    setPositionsLoading(true);
    try {
      const data = await fetchPositions(walletAddress);
      if (!isMounted()) return;
      const mapped = data.reduce<Record<string, VaultPosition>>((acc, position) => {
        acc[position.vaultId] = position;
        return acc;
      }, {});
      setPositions(mapped);
    } catch (err) {
      if (reportErrors && isMounted()) {
        setDepositResult(err instanceof Error ? err.message : "Failed to load positions.");
      } else {
        console.warn("Failed to refresh positions", err);
      }
    } finally {
      if (isMounted()) {
        setPositionsLoading(false);
      }
    }
  };

  useEffect(() => {
    const walletAddress = wallet?.publicKey?.toBase58();
    if (!walletAddress) {
      setPositions({});
      return;
    }

    let mounted = true;
    loadPositions(walletAddress, true, () => mounted);

    return () => {
      mounted = false;
    };
  }, [wallet?.publicKey?.toBase58()]);

  const eligibleVaults = useMemo(
    () => vaults.filter((vault) => Number.isFinite(vault.tvlUsd) && vault.tvlUsd >= MIN_VAULT_TVL_USD),
    [vaults]
  );

  const eligibleVaultIds = useMemo(
    () => new Set(eligibleVaults.map((vault) => vault.id)),
    [eligibleVaults]
  );

  const filteredVaults = useMemo(() => {
    const query = vaultQuery.trim().toLowerCase();
    if (!query) return eligibleVaults;
    return eligibleVaults.filter((vault) => {
      const haystack = [
        vault.protocolName,
        vault.poolName,
        vault.vaultName,
        vault.assetSymbol
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [eligibleVaults, vaultQuery]);

  const vaultOptions = useMemo(
    () =>
      filteredVaults.map((vault) => ({
        value: vault.id,
        label: `${vault.protocolName} • ${vault.poolName} • ${vault.vaultName} (${vault.assetSymbol})`
      })),
    [filteredVaults]
  );
  const fromVaultOptions = useMemo(() => {
    if (!wallet) return vaultOptions;
    const withPositions = eligibleVaults.filter(
      (vault) => (positions[vault.id]?.depositedAmount ?? 0) > 0
    );
    if (!withPositions.length) return vaultOptions;
    return withPositions.map((vault) => ({
      value: vault.id,
      label: `${vault.protocolName} • ${vault.poolName} • ${vault.vaultName} (${vault.assetSymbol})`
    }));
  }, [eligibleVaults, vaultOptions, positions, wallet]);

  const depositVault = eligibleVaults.find((vault) => vault.id === depositVaultId);
  const withdrawVault = eligibleVaults.find((vault) => vault.id === withdrawVaultId);
  const selectedVault = eligibleVaults.find((vault) => vault.id === selectedVaultId);
  const hopFromVault = eligibleVaults.find((vault) => vault.id === hopFromVaultId);
  const hopToVault = eligibleVaults.find((vault) => vault.id === hopToVaultId);
  const withdrawPosition = withdrawVault ? positions[withdrawVault.id] : undefined;
  const withdrawAvailable = withdrawPosition?.availableAmount ?? 0;
  const hopAvailable = hopFromVault ? positions[hopFromVault.id]?.availableAmount ?? 0 : 0;
  const showDepositSwap =
    depositSource === "sol" && Boolean(selectedVault && selectedVault.assetMint !== SOL_MINT);
  const showHopSwap =
    Boolean(hopFromVault && hopToVault && hopFromVault.assetMint !== hopToVault.assetMint);
  useEffect(() => {
    setDepositSetup(null);
    setDepositSetupError(null);
  }, [depositVaultId, wallet?.publicKey?.toBase58()]);

  useEffect(() => {
    if (selectedVaultId) {
      setDepositVaultId(selectedVaultId);
    }
  }, [selectedVaultId]);

  useEffect(() => {
    if (!withdrawVault) {
      setWithdrawAmount("");
      return;
    }
    setWithdrawAmount((current) =>
      current ? current : withdrawAvailable.toString()
    );
  }, [withdrawVault?.id, withdrawAvailable]);

  useEffect(() => {
    if (withdrawVaultId) {
      setSelectedVaultId(withdrawVaultId);
    }
  }, [withdrawVaultId]);

  useEffect(() => {
    if (!hopFromVault) {
      setHopAmount("");
      return;
    }
    setHopAmount((current) => (current ? current : hopAvailable.toString()));
  }, [hopFromVault?.id, hopAvailable]);

  useEffect(() => {
    if (depositSource !== "sol") {
      setDepositFlow({
        visible: false,
        swap: "pending",
        deposit: "pending"
      });
    }
  }, [depositSource]);

  useEffect(() => {
    setSolFundQuote(null);
    setSolFundQuoteError(null);
  }, [depositVaultId, depositSolAmount, depositPriorityFee, depositSlippage, depositSource]);

  const refreshDepositTokenBalance = async (isMounted: () => boolean) => {
    if (depositSource !== "wallet") {
      if (isMounted()) {
        setDepositTokenBalance(null);
        setDepositTokenBalanceError(null);
        setDepositTokenBalanceLoading(false);
      }
      return;
    }
    if (!depositVault?.assetMint) {
      if (isMounted()) {
        setDepositTokenBalance(null);
        setDepositTokenBalanceError("Select a destination vault first.");
        setDepositTokenBalanceLoading(false);
      }
      return;
    }
    if (!wallet?.publicKey) {
      if (isMounted()) {
        setDepositTokenBalance(null);
        setDepositTokenBalanceError("Connect your wallet to view token balance.");
        setDepositTokenBalanceLoading(false);
      }
      return;
    }

    setDepositTokenBalanceLoading(true);
    setDepositTokenBalanceError(null);
    try {
      const amount = await readWalletMintBalance(wallet.publicKey!, depositVault.assetMint);
      if (isMounted()) {
        setDepositTokenBalance(amount);
      }
    } catch {
      if (isMounted()) {
        setDepositTokenBalance(null);
        setDepositTokenBalanceError("Failed to load wallet token balance.");
      }
    } finally {
      if (isMounted()) {
        setDepositTokenBalanceLoading(false);
      }
    }
  };

  useEffect(() => {
    let mounted = true;
    refreshDepositTokenBalance(() => mounted);
    return () => {
      mounted = false;
    };
  }, [depositSource, depositVaultId, wallet?.publicKey?.toBase58()]);

  useEffect(() => {
    setManualSwapResult(null);
    setManualSwapFeeDetails(null);
  }, [withdrawAmount]);

  useEffect(() => {
    if (depositVaultId && !eligibleVaultIds.has(depositVaultId)) setDepositVaultId("");
    if (withdrawVaultId && !eligibleVaultIds.has(withdrawVaultId)) setWithdrawVaultId("");
    if (selectedVaultId && !eligibleVaultIds.has(selectedVaultId)) setSelectedVaultId("");
    if (hopFromVaultId && !eligibleVaultIds.has(hopFromVaultId)) setHopFromVaultId("");
    if (hopToVaultId && !eligibleVaultIds.has(hopToVaultId)) setHopToVaultId("");
  }, [depositVaultId, eligibleVaultIds, hopFromVaultId, hopToVaultId, selectedVaultId, withdrawVaultId]);

  useEffect(() => {
    setCloseAccountsResult(null);
    setCloseAccountsFeeDetails(null);
  }, [activeAction]);

  const kaminoPositionRows = useMemo(() => {
    return eligibleVaults
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
  }, [eligibleVaults, positions]);

  const kaminoPositionsWithBalance = useMemo(
    () => kaminoPositionRows.filter((row) => row.hasBalance),
    [kaminoPositionRows]
  );

  const sortedVaults = useMemo(() => {
    const sorted = filteredVaults.slice().sort((a, b) => {
      const av = a[sortKey] ?? 0;
      const bv = b[sortKey] ?? 0;
      const diff = av - bv;
      return sortDir === "asc" ? diff : -diff;
    });
    return sorted;
  }, [filteredVaults, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedVaults.length / PAGE_SIZE));
  const currentPage = Math.min(pageIndex, totalPages - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const pageVaults = sortedVaults.slice(pageStart, pageStart + PAGE_SIZE);

  useEffect(() => {
    setPageIndex(0);
  }, [vaultQuery]);

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

  const averageApy = useMemo(() => {
    if (!sortedVaults.length) return 0;
    return sortedVaults.reduce((sum, vault) => sum + (vault.apyTotal || 0), 0) / sortedVaults.length;
  }, [sortedVaults]);

  const totalTrackedTvl = useMemo(
    () => sortedVaults.reduce((sum, vault) => sum + (vault.tvlUsd || 0), 0),
    [sortedVaults]
  );

  const activeFlowSteps = useMemo(() => {
    if (activeAction === "deposit") {
      if (!depositFlow.visible) return [] as TxFlowStep[];
      return [
        { label: "swap", status: depositFlow.swap },
        { label: "deposit", status: depositFlow.deposit }
      ];
    }
    if (activeAction === "withdraw") return withdrawFlow;
    return hopFlow;
  }, [activeAction, depositFlow, hopFlow, withdrawFlow]);

  const preflightLines = useMemo(() => {
    if (activeAction === "deposit") {
      const destination = selectedVault ? selectedVault.vaultName : "Select destination vault";
      const amount =
        depositSource === "sol"
          ? `${depositSolAmount || "0"} SOL`
          : `${moveAmount || "0"} ${selectedVault?.assetSymbol ?? "token"}`;
      return [
        `Source: ${depositSource === "sol" ? "SOL wallet balance" : "Wallet vault token"}`,
        `Destination: ${destination}`,
        `Amount: ${amount}`,
        `Slippage: ${depositSlippage}%`
      ];
    }
    if (activeAction === "withdraw") {
      const from = withdrawVault ? withdrawVault.vaultName : "Select source vault";
      return [
        `Source: ${from}`,
        `Receive: ${withdrawTarget === "sol" ? "SOL" : "Vault token"}`,
        `Amount: ${withdrawAmount || "0"}`,
        `Slippage: ${withdrawSlippage}%`
      ];
    }
    const from = hopFromVault ? hopFromVault.vaultName : "Select source vault";
    const to = hopToVault ? hopToVault.vaultName : "Select destination vault";
    return [
      `Source: ${from}`,
      `Destination: ${to}`,
      `Amount: ${hopAmount || "0"}`,
      `Slippage: ${hopSlippage}%`
    ];
  }, [
    activeAction,
    depositSlippage,
    depositSolAmount,
    depositSource,
    hopAmount,
    hopFromVault,
    hopSlippage,
    hopToVault,
    moveAmount,
    selectedVault,
    withdrawAmount,
    withdrawSlippage,
    withdrawTarget,
    withdrawVault
  ]);

  const quickSetAction = (vault: VaultMetric, action: "deposit" | "withdraw" | "hop") => {
    setSelectedVaultId(vault.id);
    if (action === "deposit") {
      setDepositVaultId(vault.id);
      setActiveAction("deposit");
      return;
    }
    if (action === "withdraw") {
      setWithdrawVaultId(vault.id);
      setActiveAction("withdraw");
      return;
    }
    setHopToVaultId(vault.id);
    setActiveAction("hop");
    setHopSelectMode("from");
  };

  const selectVaultFromTable = (vault: VaultMetric) => {
    if (activeAction === "hop" || hopSelectMode === "to") {
      setHopToVaultId(vault.id);
      setSelectedVaultId(vault.id);
      setHopSelectMode(null);
      return;
    }
    setSelectedVaultId(vault.id);
    setDepositVaultId(vault.id);
    setActiveAction("deposit");
  };

  const parseSlippage = (value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return null;
    return parsed;
  };

  const applyWithdrawPreset = (fraction: number) => {
    if (!withdrawVault || withdrawAvailable <= 0) return;
    const nextAmount = withdrawAvailable * fraction;
    setWithdrawAmount(toInputAmount(nextAmount, withdrawVault.assetDecimals));
  };

  const applyHopPreset = (fraction: number) => {
    if (!hopFromVault || hopAvailable <= 0) return;
    const nextAmount = hopAvailable * fraction;
    setHopAmount(toInputAmount(nextAmount, hopFromVault.assetDecimals));
  };

  const applyDepositWalletPreset = (fraction: number) => {
    if (depositSource !== "wallet" || !depositVault) return;
    const balance = depositTokenBalance ?? 0;
    if (!Number.isFinite(balance) || balance <= 0) return;
    const nextAmount = balance * fraction;
    setMoveAmount(toInputAmount(nextAmount, depositVault.assetDecimals));
  };

  const formatFeeDiagnostics = (details: FeeDiagnostics | null) => {
    if (!details) return null;
    if (!details.transactions.length) return "No fee diagnostics available.";
    return details.transactions
      .map((tx) => {
        const parts: string[] = [];
        if (typeof tx.computeUnitPriceMicroLamports === "number") {
          parts.push(`${tx.computeUnitPriceMicroLamports} µ-lamports/CU`);
        } else {
          parts.push("no CU price");
        }
        if (typeof tx.computeUnitLimit === "number") {
          parts.push(`limit ${tx.computeUnitLimit}`);
        }
        if (typeof tx.estimatedPriorityFeeLamports === "number") {
          parts.push(
            `~${(tx.estimatedPriorityFeeLamports / 1_000_000_000).toFixed(6)} SOL priority`
          );
        }
        if (typeof tx.signatureFeeLamports === "number") {
          parts.push(
            `~${(tx.signatureFeeLamports / 1_000_000_000).toFixed(6)} SOL signatures`
          );
        }
        if (typeof tx.networkFeeLamports === "number") {
          parts.push(
            `~${(tx.networkFeeLamports / 1_000_000_000).toFixed(6)} SOL total`
          );
        }
        return `${tx.label}: ${parts.join(", ")}`;
      })
      .join("\n");
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

  const mapProgressStatus = (
    status: FundProgressEvent["status"] | TransactionProgressEvent["status"]
  ): ProgressStatus => {
    if (status === "confirmed") return "confirmed";
    if (status === "failed") return "failed";
    return "in_progress";
  };

  const flowStateLabel = (status: ProgressStatus) => {
    if (status === "confirmed") return "Confirmed";
    if (status === "failed") return "Failed";
    if (status === "in_progress") return "In progress";
    return "Waiting";
  };

  const upsertTxFlowStep = (
    current: TxFlowStep[],
    event: TransactionProgressEvent
  ): TxFlowStep[] => {
    const nextStep: TxFlowStep = {
      label: event.label,
      status: mapProgressStatus(event.status),
      signature: event.signature
    };
    const existingIndex = current.findIndex((step) => step.label === event.label);
    if (existingIndex === -1) return [...current, nextStep];
    const next = current.slice();
    next[existingIndex] = { ...next[existingIndex], ...nextStep };
    return next;
  };

  const handleConnect = async () => {
    try {
      const provider = await connectWallet();
      setWallet(provider);
    } catch (err) {
      console.error("Wallet connect failed", err);
      const message = formatConnectError(err);
      setDepositResult(message || "Failed to connect wallet.");
    }
  };

  const handleDisconnect = async () => {
    if (!wallet) return;
    await disconnectWallet(wallet);
    setWallet(null);
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

    const slippagePct = parseSlippage(depositSlippage);
    if (slippagePct === null) {
      setDepositResult("Enter a valid slippage percentage (0-100).");
      return;
    }

    setDepositing(true);
    setDepositResult(null);
    setDepositFeeDetails(null);
    setDepositFlow((prev) => ({ ...prev, visible: false }));
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
        const swapRequired = depositVault.assetMint !== SOL_MINT;
        setDepositFlow({
          visible: true,
          swap: swapRequired ? "pending" : "confirmed",
          deposit: "pending"
        });
        const diagnostics = await depositFundsFromSol(
          provider,
          depositVault,
          amountSol,
          slippagePct,
          depositPriorityFee,
          depositFeeDebug,
          (event) => {
            setDepositFlow((current) => ({
              ...current,
              [event.step]: mapProgressStatus(event.status)
            }));
            if (event.step === "swap" && event.status === "confirmed") {
              setDepositResult("Swap confirmed. Depositing into vault...");
            }
            if (event.step === "deposit" && event.status === "confirmed") {
              setDepositResult("Deposit transaction confirmed.");
            }
          }
        );
        if (depositFeeDebug) {
          setDepositFeeDetails(diagnostics);
        }
        await loadPositions(provider.publicKey!.toBase58(), false);
        setDepositFlow((current) => ({
          ...current,
          visible: true,
          swap: swapRequired ? "confirmed" : current.swap,
          deposit: "confirmed"
        }));
        setDepositResult("Deposit complete.");
        return;
      }

      const amount = Number(moveAmount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setDepositResult("Enter a valid token amount to deposit.");
        return;
      }
      if (depositTokenBalance !== null && amount > depositTokenBalance) {
        setDepositResult("Amount exceeds wallet balance for this vault token.");
        return;
      }
      const diagnostics = await depositFunds(
        provider,
        depositVault,
        amount,
        slippagePct,
        depositPriorityFee,
        depositFeeDebug
      );
      if (depositFeeDebug) {
        setDepositFeeDetails(diagnostics);
      }
      await loadPositions(provider.publicKey!.toBase58(), false);
      await refreshDepositTokenBalance(() => true);
      setDepositResult("Deposit complete. Wallet token deposited into vault.");
    } catch (err) {
      if (depositSource === "sol") {
        setDepositFlow((current) => ({
          ...current,
          visible: true,
          swap: current.swap === "confirmed" ? "confirmed" : "failed",
          deposit: current.swap === "confirmed" && current.deposit !== "confirmed"
            ? "failed"
            : current.deposit
        }));
      }
      setDepositResult(
        err instanceof Error ? err.message : "Failed to deposit into vault."
      );
    } finally {
      setDepositing(false);
    }
  };

  const handlePreviewDepositAccounts = async () => {
    if (!depositVault) {
      setDepositSetupError("Select a vault to preview setup fees.");
      return;
    }
    const walletAddress = wallet?.publicKey?.toBase58() ?? getWalletProvider()?.publicKey?.toBase58();
    if (!walletAddress) {
      setDepositSetupError("Connect your wallet to continue.");
      return;
    }
    setDepositSetupLoading(true);
    setDepositSetupError(null);
    try {
      const preview = await previewDepositAccounts(depositVault, walletAddress);
      setDepositSetup(preview);
    } catch (err) {
      setDepositSetupError(
        err instanceof Error ? err.message : "Failed to preview setup fees."
      );
    } finally {
      setDepositSetupLoading(false);
    }
  };

  const handleCreateDepositAccounts = async () => {
    if (!depositVault) {
      setDepositSetupError("Select a vault to create token accounts.");
      return;
    }
    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setDepositSetupError("Connect your wallet to continue.");
      return;
    }
    setDepositSetupLoading(true);
    setDepositSetupError(null);
    try {
      const preview = await createDepositAccounts(provider, depositVault);
      setDepositSetup(preview);
    } catch (err) {
      setDepositSetupError(
        err instanceof Error ? err.message : "Failed to create token accounts."
      );
    } finally {
      setDepositSetupLoading(false);
    }
  };

  const handlePreviewSolFundQuote = async () => {
    if (depositSource !== "sol") return;
    if (!depositVault) {
      setSolFundQuoteError("Select a destination vault first.");
      return;
    }
    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setSolFundQuoteError("Connect your wallet to continue.");
      return;
    }
    const amountSol = Number(depositSolAmount);
    if (!Number.isFinite(amountSol) || amountSol <= 0) {
      setSolFundQuoteError("Enter a valid SOL amount.");
      return;
    }
    const slippagePct = parseSlippage(depositSlippage);
    if (slippagePct === null) {
      setSolFundQuoteError("Enter a valid slippage percentage (0-100).");
      return;
    }

    setSolFundQuoteLoading(true);
    setSolFundQuoteError(null);
    try {
      const quote = await previewSolFundQuote(
        provider,
        depositVault,
        amountSol,
        slippagePct,
        depositPriorityFee
      );
      setSolFundQuote(quote);
    } catch (err) {
      setSolFundQuoteError(err instanceof Error ? err.message : "Failed to preview debit.");
    } finally {
      setSolFundQuoteLoading(false);
    }
  };

  const handleWithdraw = async () => {
    if (!withdrawVault) {
      setWithdrawResult("Select a vault to withdraw from.");
      return;
    }
    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setWithdrawResult("Connect your wallet to continue.");
      return;
    }
    if (withdrawAvailable <= 0) {
      setWithdrawResult("No available balance to withdraw from this vault.");
      return;
    }
    const amount = Number(withdrawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setWithdrawResult("Enter a valid withdraw amount.");
      return;
    }
    if (exceedsAvailableBalance(amount, withdrawAvailable)) {
      setWithdrawResult("Amount exceeds available balance in this vault.");
      return;
    }
    const requestedAmount = Math.min(amount, withdrawAvailable);
    const slippagePct = parseSlippage(withdrawSlippage);
    if (slippagePct === null) {
      setWithdrawResult("Enter a valid slippage percentage (0-100).");
      return;
    }

    setWithdrawing(true);
    setWithdrawResult(null);
    setWithdrawFlow([]);
    setWithdrawFeeDetails(null);
    setManualSwapResult(null);
    setManualSwapFeeDetails(null);
    try {
      const shouldRunManualSwap =
        withdrawTarget === "sol" && withdrawVault.assetMint !== SOL_MINT;
      const beforeWithdrawSourceBalanceBase = shouldRunManualSwap
        ? await readWalletMintBalanceBaseUnits(provider.publicKey!, withdrawVault.assetMint)
        : 0n;
      const finalDestination = shouldRunManualSwap ? "asset" : withdrawTarget;
      const diagnostics = await withdrawFunds(
        provider,
        withdrawVault,
        requestedAmount,
        finalDestination,
        slippagePct,
        withdrawPriorityFee,
        withdrawFeeDebug,
        (event) => {
          setWithdrawFlow((current) => upsertTxFlowStep(current, event));
        }
      );
      if (withdrawFeeDebug) {
        setWithdrawFeeDetails(diagnostics);
      }
      if (shouldRunManualSwap) {
        const afterWithdrawSourceBalanceBase = await readWalletMintBalanceBaseUnits(
          provider.publicKey!,
          withdrawVault.assetMint
        );
        const withdrawnSourceBase =
          afterWithdrawSourceBalanceBase > beforeWithdrawSourceBalanceBase
            ? afterWithdrawSourceBalanceBase - beforeWithdrawSourceBalanceBase
            : 0n;
        await runManualSwap(requestedAmount, {
          propagateError: true,
          amountBaseOverride:
            withdrawnSourceBase > 0n ? Number(withdrawnSourceBase) : undefined,
          onProgress: (event) => {
            setWithdrawFlow((current) =>
              upsertTxFlowStep(current, { ...event, label: "manual-swap" })
            );
          }
        });
      }
      await loadPositions(provider.publicKey!.toBase58(), false);
      setWithdrawResult(
        withdrawTarget === "sol"
          ? "Withdraw complete. Funds swapped to SOL."
          : "Withdraw complete. Funds returned to your wallet."
      );
    } catch (err) {
      setWithdrawResult(
        err instanceof Error ? err.message : "Failed to withdraw from vault."
      );
    } finally {
      setWithdrawing(false);
    }
  };

  const runManualSwap = async (
    amount: number,
    options?: {
      propagateError?: boolean;
      onProgress?: (event: TransactionProgressEvent) => void;
      amountBaseOverride?: number;
    }
  ) => {
    if (!withdrawVault) {
      setManualSwapResult("Select a vault to withdraw from.");
      return;
    }
    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setManualSwapResult("Connect your wallet to continue.");
      return;
    }
    const slippagePct = parseSlippage(withdrawSlippage);
    if (slippagePct === null) {
      setManualSwapResult("Enter a valid slippage percentage (0-100).");
      return;
    }
    const lamports = options?.amountBaseOverride ?? toBaseUnits(amount, withdrawVault.assetDecimals);
    setManualSwapping(true);
    setManualSwapResult(null);
    setManualSwapFeeDetails(null);
    try {
      const diagnostics = await swapAssetToSol(
        provider,
        withdrawVault.assetMint,
        lamports,
        slippagePct,
        withdrawPriorityFee,
        withdrawFeeDebug,
        options?.onProgress
      );
      if (withdrawFeeDebug) {
        setManualSwapFeeDetails(diagnostics);
      }
      setManualSwapResult("Manual swap to SOL submitted.");
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Swap failed.");
      setManualSwapResult(error.message);
      if (options?.propagateError) {
        throw error;
      }
    } finally {
      setManualSwapping(false);
    }
  };

  const handleHop = async () => {
    if (!hopFromVault || !hopToVault) {
      setHopResult("Select both a source and destination vault.");
      return;
    }
    if (hopFromVault.id === hopToVault.id) {
      setHopResult("Source and destination vaults must be different.");
      return;
    }
    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setHopResult("Connect your wallet to continue.");
      return;
    }
    const slippagePct = parseSlippage(hopSlippage);
    if (slippagePct === null) {
      setHopResult("Enter a valid slippage percentage (0-100).");
      return;
    }
    const amount = Number(hopAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setHopResult("Enter a valid amount to hop.");
      return;
    }
    const sourcePosition = positions[hopFromVault.id];
    const sourceAvailable = sourcePosition?.availableAmount ?? 0;
    if (sourceAvailable <= 0) {
      setHopResult("No available balance to move from this vault.");
      return;
    }
    if (exceedsAvailableBalance(amount, sourceAvailable)) {
      setHopResult("Amount exceeds available balance in this vault.");
      return;
    }
    const hopRequestedAmount = Math.min(amount, sourceAvailable);
    setHopping(true);
    setHopResult(null);
    setHopFlow([]);
    setHopFeeDetails(null);
    try {
      const closeSourceAccounts =
        toBaseUnits(hopRequestedAmount, hopFromVault.assetDecimals) >=
        toBaseUnits(sourceAvailable, hopFromVault.assetDecimals);
      try {
        setHopFlow((current) =>
          upsertTxFlowStep(current, {
            label: "create-accounts",
            status: "sending"
          })
        );
        const setupVaults = [hopFromVault, hopToVault].filter(
          (vault, index, list) => list.findIndex((item) => item.id === vault.id) === index
        );
        for (const vault of setupVaults) {
          await createDepositAccounts(provider, vault);
        }
        setHopFlow((current) =>
          upsertTxFlowStep(current, {
            label: "create-accounts",
            status: "confirmed"
          })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setHopFlow((current) =>
          upsertTxFlowStep(current, {
            label: "create-accounts",
            status: "failed",
            error: message
          })
        );
        throw err;
      }

      const beforeWithdrawSourceBalanceBase = await readWalletMintBalanceBaseUnits(
        provider.publicKey!,
        hopFromVault.assetMint
      );
      const withdrawDiagnostics = await withdrawFunds(
        provider,
        hopFromVault,
        hopRequestedAmount,
        "asset",
        slippagePct,
        hopPriorityFee,
        hopFeeDebug,
        (event) => {
          setHopFlow((current) =>
            upsertTxFlowStep(current, { ...event, label: "withdraw" })
          );
        }
      );
      if (hopFeeDebug && withdrawDiagnostics) {
        setHopFeeDetails(withdrawDiagnostics);
      }
      const afterWithdrawSourceBalanceBase = await readWalletMintBalanceBaseUnits(
        provider.publicKey!,
        hopFromVault.assetMint
      );
      const withdrawnSourceBase =
        afterWithdrawSourceBalanceBase > beforeWithdrawSourceBalanceBase
          ? afterWithdrawSourceBalanceBase - beforeWithdrawSourceBalanceBase
          : 0n;

      let depositAmount = hopRequestedAmount;
      if (hopFromVault.assetMint !== hopToVault.assetMint) {
        const swapInputBase =
          withdrawnSourceBase > 0n
            ? Number(withdrawnSourceBase)
            : toBaseUnits(hopRequestedAmount, hopFromVault.assetDecimals);
        if (!Number.isFinite(swapInputBase) || swapInputBase <= 0) {
          throw new Error("No source tokens available to swap after withdraw.");
        }
        const beforeSwapOutBalanceBase = await readWalletMintBalanceBaseUnits(
          provider.publicKey!,
          hopToVault.assetMint
        );
        await swapAsset(
          provider,
          hopFromVault.assetMint,
          hopToVault.assetMint,
          swapInputBase,
          slippagePct,
          hopPriorityFee,
          hopFeeDebug,
          (event) => {
            setHopFlow((current) =>
              upsertTxFlowStep(current, { ...event, label: "swap" })
            );
          }
        );
        const afterSwapOutBalanceBase = await readWalletMintBalanceBaseUnits(
          provider.publicKey!,
          hopToVault.assetMint
        );
        const receivedBase =
          afterSwapOutBalanceBase > beforeSwapOutBalanceBase
            ? afterSwapOutBalanceBase - beforeSwapOutBalanceBase
            : 0n;
        const received = Number(receivedBase) / 10 ** hopToVault.assetDecimals;
        if (!Number.isFinite(received) || received <= 0) {
          throw new Error(
            "Swap completed but no destination tokens were detected in wallet for deposit."
          );
        }
        depositAmount = received;
      } else if (withdrawnSourceBase > 0n) {
        const withdrawn = Number(withdrawnSourceBase) / 10 ** hopFromVault.assetDecimals;
        if (Number.isFinite(withdrawn) && withdrawn > 0) {
          depositAmount = withdrawn;
        }
      }

      const depositDiagnostics = await depositFunds(
        provider,
        hopToVault,
        depositAmount,
        slippagePct,
        hopPriorityFee,
        hopFeeDebug
      );
      setHopFlow((current) =>
        upsertTxFlowStep(current, { label: "deposit", status: "confirmed" })
      );
      if (hopFeeDebug && depositDiagnostics) {
        setHopFeeDetails(depositDiagnostics);
      }
      if (closeSourceAccounts) {
        try {
          await closeTokenAccounts(provider, hopFromVault, false);
        } catch {
          // Best-effort close after full hop.
        }
      }
      await loadPositions(provider.publicKey!.toBase58(), false);
      setHopResult("Hop complete. Funds moved into the destination vault.");
    } catch (err) {
      setHopResult(err instanceof Error ? err.message : "Failed to hop positions.");
    } finally {
      setHopping(false);
    }
  };

  const handleCloseTokenAccounts = async (
    vault: VaultMetric | undefined,
    feeDebug: boolean
  ) => {
    if (!vault) {
      setCloseAccountsResult("Select a vault to close token accounts.");
      return;
    }
    const provider = wallet ?? getWalletProvider();
    if (!provider?.publicKey) {
      setCloseAccountsResult("Connect your wallet to continue.");
      return;
    }
    setClosingAccounts(true);
    setCloseAccountsResult(null);
    setCloseAccountsFeeDetails(null);
    try {
      const diagnostics = await closeTokenAccounts(provider, vault, feeDebug);
      if (feeDebug && diagnostics) {
        setCloseAccountsFeeDetails(diagnostics);
      }
      setCloseAccountsResult("Token accounts closed and rent reclaimed.");
    } catch (err) {
      setCloseAccountsResult(
        err instanceof Error ? err.message : "Failed to close token accounts."
      );
    } finally {
      setClosingAccounts(false);
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
      <section className="card workspace-summary">
        <div className="summary-head">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>Kamino Vault Workspace</h1>
            <p className="subhead">Pick vaults, review preflight, then execute in manual steps.</p>
          </div>
          <div className="wallet-inline">
            <span className="muted">Wallet</span>
            <strong>{wallet ? truncateAddress(wallet.publicKey?.toBase58() ?? "") : "Not connected"}</strong>
          </div>
        </div>
        <div className="summary-grid">
          <div className="summary-item">
            <span className="muted">Visible vaults</span>
            <span className="summary-value">{sortedVaults.length}</span>
          </div>
          <div className="summary-item">
            <span className="muted">Tracked TVL</span>
            <span className="summary-value">{formatUsd(totalTrackedTvl)}</span>
          </div>
          <div className="summary-item">
            <span className="muted">Avg APY</span>
            <span className="summary-value">{formatPercent(averageApy)}</span>
          </div>
          <div className="summary-item">
            <span className="muted">Active positions</span>
            <span className="summary-value">
              {wallet ? kaminoPositionsWithBalance.length : "—"}
            </span>
          </div>
          <div className="summary-item">
            <span className="muted">SOL balance</span>
            <span className="summary-value">
              {solBalanceLoading
                ? "Loading..."
                : solBalance !== null
                  ? `${solBalance.toFixed(4)} SOL`
                  : "—"}
            </span>
          </div>
        </div>
      </section>

      <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <p className="eyebrow">EasyHop Solana</p>
          <h1>Kamino Lend Console</h1>
          <p className="subhead">
            Track positions, watch liquidity, and swap in or out of vaults fast.
          </p>
        </div>

        <section className="card sidebar-card">
          <div className="wallet-block">
            <div>
              <span className="muted">Wallet</span>
              <div className="wallet-address">
                {wallet ? truncateAddress(wallet.publicKey?.toBase58() ?? "") : "Not connected"}
              </div>
            </div>
            {wallet ? (
              <button className="ghost" onClick={handleDisconnect}>
                Disconnect
              </button>
            ) : (
              <button className="primary" onClick={handleConnect}>
                Connect
              </button>
            )}
          </div>
          <div className="balance-row">
            <div>
              <span className="muted">SOL balance</span>
              <span className="strong">
                {solBalanceLoading
                  ? "Loading..."
                  : solBalance !== null
                    ? `${solBalance.toFixed(4)} SOL`
                    : "—"}
              </span>
            </div>
            <button
              className="ghost"
              onClick={() => refreshSolBalance(() => true)}
              disabled={!wallet || solBalanceLoading}
            >
              Refresh
            </button>
          </div>
          {solBalanceError && <p className="error">{solBalanceError}</p>}
        </section>

        <section className="card sidebar-card">
          <div className="sidebar-head">
            <h2>Your positions</h2>
            <p className="muted">Click a vault to withdraw.</p>
          </div>
          {!wallet && <p className="muted">Connect your wallet to load positions.</p>}
          {wallet && kaminoPositionsWithBalance.length === 0 && (
            <p className="muted">{positionsLoading ? "Scanning..." : "No active positions."}</p>
          )}
          {wallet && kaminoPositionsWithBalance.length > 0 && (
            <div className="positions-list">
              {kaminoPositionsWithBalance.map((row) => (
                <button
                  key={row.vault.id}
                  type="button"
                  className={`position-item${withdrawVaultId === row.vault.id ? " active" : ""}`}
                  onClick={() => {
                    if (hopSelectMode === "to") return;
                    setHopFromVaultId(row.vault.id);
                    setHopAmount(row.available.toString());
                    setActiveAction("hop");
                    setHopSelectMode("to");
                  }}
                >
                  <div>
                    <div className="position-title">{row.vault.vaultName}</div>
                    <div className="muted">{row.vault.assetSymbol}</div>
                  </div>
                  <div className="position-values">
                    <span>{formatTokenAmount(row.available, row.vault.assetSymbol)}</span>
                    <span className="muted">avail</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      </aside>

      <main className="main">
        <header className="header">
          <div>
            <p className="eyebrow">Vaults</p>
            <h1>Vault explorer</h1>
            <p className="subhead">Search and trigger actions directly from each vault row.</p>
          </div>
          <div className="filter-field">
            <input
              type="search"
              placeholder="Filter vaults (asset, pool, protocol)"
              value={vaultQuery}
              onChange={(event) => setVaultQuery(event.target.value)}
            />
            {vaultQuery && (
              <span className="filter-count">
                {filteredVaults.length}/{eligibleVaults.length}
              </span>
            )}
          </div>
          {vaultQuery && (
            <button className="ghost" type="button" onClick={() => setVaultQuery("")}>
              Clear filter
            </button>
          )}
        </header>

        <section className="card">
          <div className="vaults-header">
            <div>
              <h2>All vaults</h2>
              <p className="muted" style={{ marginTop: "2px" }}>
                {sortedVaults.length} vaults (TVL ≥ {formatUsd(MIN_VAULT_TVL_USD)})
              </p>
            </div>
          </div>
          <div className="table vault-table">
            <div className="row header-row vault-row">
              <span>Vault</span>
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
              <span></span>
            </div>
            {pageVaults.map((vault) => {
              const isActive = selectedVaultId === vault.id;
              return (
                <div
                  key={vault.id}
                  className={`row vault-row${isActive ? " selected" : ""}`}
                  onClick={() => selectVaultFromTable(vault)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      selectVaultFromTable(vault);
                    }
                  }}
                >
                  <div className="vault-main">
                    <strong className="vault-title">{vault.vaultName}</strong>
                    <div className="vault-subline">
                      <span className="muted">{vault.poolName}</span>
                      <span className="tag">{PROTOCOL_LABELS[vault.protocolId]}</span>
                    </div>
                  </div>
                  <span className="vault-asset">{vault.assetSymbol}</span>
                  <span className="vault-metric strong">{formatPercent(vault.apyTotal)}</span>
                  <span className="vault-metric">{formatUsd(vault.tvlUsd)}</span>
                  <span className="vault-row-actions">
                    <button
                      type="button"
                      className="ghost vault-action-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        quickSetAction(vault, "deposit");
                      }}
                    >
                      Fund
                    </button>
                    <button
                      type="button"
                      className="ghost vault-action-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        quickSetAction(vault, "withdraw");
                      }}
                    >
                      Withdraw
                    </button>
                    <button
                      type="button"
                      className="ghost vault-action-btn"
                      onClick={(event) => {
                        event.stopPropagation();
                        quickSetAction(vault, "hop");
                      }}
                    >
                      Hop
                    </button>
                    <a
                      href={vault.vaultUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="vault-link-button"
                      onClick={(event) => event.stopPropagation()}
                      title={`Lend on ${PROTOCOL_LABELS[vault.protocolId]}`}
                    >
                      Open
                    </a>
                  </span>
                </div>
              );
            })}
            {pageVaults.length === 0 && (
              <div className="row vault-empty">
                <span>No vaults match the current filter.</span>
                <button className="ghost" type="button" onClick={() => setVaultQuery("")}>
                  Reset filters
                </button>
              </div>
            )}
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

      </main>

      <aside className="rightbar">
        <section className="card sidebar-card action-card">
          <div className="action-head">
            <div>
              <h2>Vault actions</h2>
              <p className="muted">Fund, withdraw, or hop between vaults.</p>
            </div>
            <div className="segmented" data-active={activeAction}>
              <button
                className={`segment-btn${activeAction === "deposit" ? " active" : ""}`}
                onClick={() => setActiveAction("deposit")}
                type="button"
              >
                Fund
              </button>
              <button
                className={`segment-btn${activeAction === "withdraw" ? " active" : ""}`}
                onClick={() => setActiveAction("withdraw")}
                type="button"
              >
                Withdraw
              </button>
              <button
                className={`segment-btn${activeAction === "hop" ? " active" : ""}`}
                onClick={() => setActiveAction("hop")}
                type="button"
              >
                Hop
              </button>
            </div>
          </div>

          <div className="preflight-box">
            <div className="preflight-head">
              <span className="muted">Preflight summary</span>
              <span className="tag">{activeAction.toUpperCase()}</span>
            </div>
            {preflightLines.map((line) => (
              <div key={line} className="preflight-line">
                {line}
              </div>
            ))}
          </div>

          {activeAction === "deposit" && (
            <div className="action-panel">
              {selectedVault ? (
                <div className="selected-vault">
                  <div>
                    <div className="selected-title">{selectedVault.vaultName}</div>
                    <div className="muted">{selectedVault.poolName}</div>
                  </div>
                  <span className="tag">{selectedVault.assetSymbol}</span>
                </div>
              ) : (
                <p className="muted">Select a vault from the table to continue.</p>
              )}
              <div className="move-grid">
                <label>
                  Fund from
                  <select
                    value={depositSource}
                    onChange={(event) =>
                      setDepositSource(event.target.value === "sol" ? "sol" : "wallet")
                    }
                  >
                    <option value="sol">SOL balance (swap via Jupiter)</option>
                    <option value="wallet">Vault token (wallet)</option>
                  </select>
                </label>
                {depositSource === "sol" ? (
                  <label>
                    SOL max spend
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
                    Vault token amount
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={moveAmount}
                      onChange={(event) => setMoveAmount(event.target.value)}
                      placeholder="0.0"
                    />
                    <div className="quick-amounts">
                      <button
                        type="button"
                        className="quick-amount"
                        onClick={() => applyDepositWalletPreset(0.25)}
                        disabled={
                          depositSource !== "wallet" ||
                          depositTokenBalanceLoading ||
                          !depositVault ||
                          !depositTokenBalance ||
                          depositTokenBalance <= 0
                        }
                      >
                        25%
                      </button>
                      <button
                        type="button"
                        className="quick-amount"
                        onClick={() => applyDepositWalletPreset(0.5)}
                        disabled={
                          depositSource !== "wallet" ||
                          depositTokenBalanceLoading ||
                          !depositVault ||
                          !depositTokenBalance ||
                          depositTokenBalance <= 0
                        }
                      >
                        50%
                      </button>
                      <button
                        type="button"
                        className="quick-amount"
                        onClick={() => applyDepositWalletPreset(0.75)}
                        disabled={
                          depositSource !== "wallet" ||
                          depositTokenBalanceLoading ||
                          !depositVault ||
                          !depositTokenBalance ||
                          depositTokenBalance <= 0
                        }
                      >
                        75%
                      </button>
                      <button
                        type="button"
                        className="quick-amount"
                        onClick={() => applyDepositWalletPreset(1)}
                        disabled={
                          depositSource !== "wallet" ||
                          depositTokenBalanceLoading ||
                          !depositVault ||
                          !depositTokenBalance ||
                          depositTokenBalance <= 0
                        }
                      >
                        100%
                      </button>
                    </div>
                  </label>
                )}
                <label>
                  Slippage (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={depositSlippage}
                    onChange={(event) => setDepositSlippage(event.target.value)}
                    placeholder="0.5"
                  />
                </label>
                <label>
                  Priority fee
                  <select
                    value={depositPriorityFee}
                    onChange={(event) =>
                      setDepositPriorityFee(
                        event.target.value === "low"
                          ? "low"
                          : event.target.value === "auto"
                            ? "auto"
                            : "off"
                      )
                    }
                  >
                    <option value="off">Off</option>
                    <option value="low">Low</option>
                    <option value="auto">Auto</option>
                  </select>
                </label>
                <label>
                  Fee diagnostics
                  <select
                    value={depositFeeDebug ? "on" : "off"}
                    onChange={(event) => setDepositFeeDebug(event.target.value === "on")}
                  >
                    <option value="off">Off</option>
                    <option value="on">On</option>
                  </select>
                </label>
              </div>
              {depositSource === "wallet" && depositVault && (
                <div className="position-summary">
                  <div>
                    <span className="muted">Wallet balance</span>
                    <span className="position-value">
                      {depositTokenBalanceLoading
                        ? "Loading..."
                        : depositTokenBalanceError
                          ? depositTokenBalanceError
                          : formatTokenAmount(
                              depositTokenBalance ?? 0,
                              depositVault.assetSymbol
                            )}
                    </span>
                  </div>
                </div>
              )}
              <div className="action-footer">
                <button
                  className="primary"
                  onClick={handleDeposit}
                  disabled={depositing || !selectedVault}
                >
                  {depositing ? "Processing..." : "Fund vault"}
                </button>
                {showDepositSwap && (
                  <span className="inline-badge">Includes Jupiter swap</span>
                )}
              </div>
              <div className="action-tools">
                {depositSource === "sol" && (
                  <button
                    className="ghost"
                    onClick={handlePreviewSolFundQuote}
                    disabled={solFundQuoteLoading || !selectedVault}
                  >
                    {solFundQuoteLoading ? "Calculating..." : "Preview debit"}
                  </button>
                )}
                <button
                  className="ghost"
                  onClick={handlePreviewDepositAccounts}
                  disabled={depositSetupLoading || !selectedVault}
                >
                  {depositSetupLoading ? "Checking..." : "Preview setup fees"}
                </button>
                {depositSetup?.missingAccounts?.length ? (
                  <button
                    className="ghost"
                    onClick={handleCreateDepositAccounts}
                    disabled={depositSetupLoading || !selectedVault}
                  >
                    Create token accounts
                  </button>
                ) : null}
              </div>
              {depositSource === "sol" && solFundQuoteError && (
                <p className="error">{solFundQuoteError}</p>
              )}
              {depositSource === "sol" && solFundQuote && (
                <div className="quote-box">
                  {solFundQuote.canProceed ? (
                    <>
                      <div className="quote-row">
                        <span className="muted">Requested SOL</span>
                        <span className="route-value">{formatSol(solFundQuote.requestedSol)}</span>
                      </div>
                      <div className="quote-row">
                        <span className="muted">SOL used for swap</span>
                        <span className="route-value">
                          {formatSol(solFundQuote.swapInputSol ?? solFundQuote.requestedSol)}
                        </span>
                      </div>
                      <div className="quote-row">
                        <span className="muted">Estimated output</span>
                        <span className="route-value">
                          {solFundQuote.estimatedOutAmount?.toFixed(6)} {solFundQuote.estimatedOutSymbol}
                        </span>
                      </div>
                      <div className="quote-row">
                        <span className="muted">Estimated setup fee (one-time)</span>
                        <span className="route-value">
                          {formatSol(
                            (solFundQuote.estimatedSetupLamports ?? 0) / 1_000_000_000
                          )}
                        </span>
                      </div>
                      <div className="quote-row">
                        <span className="muted">Estimated network+priority fee</span>
                        <span className="route-value">
                          {formatSol(
                            (solFundQuote.estimatedNetworkFeeLamports ?? 0) / 1_000_000_000
                          )}
                        </span>
                      </div>
                      <div className="quote-row">
                        <span className="muted">Estimated total wallet debit</span>
                        <span className="route-value">
                          {formatSol(solFundQuote.estimatedTotalDebitSol ?? solFundQuote.requestedSol)}
                        </span>
                      </div>
                      {!!solFundQuote.txPlan?.length && (
                        <p className="muted quote-plan">
                          Plan: {solFundQuote.txPlan.map((tx) => tx.label).join(" -> ")}
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="muted">
                      {solFundQuote.reason === "insufficient_requested_sol"
                        ? "Requested SOL is too small after one-time setup and network fees. Increase amount."
                        : `Missing accounts: ${solFundQuote.missingAccountsCount ?? 0}. One-time rent: ${formatSol(
                            (solFundQuote.rentLamports ?? 0) / 1_000_000_000
                          )}. Create token accounts first.`}
                    </p>
                  )}
                </div>
              )}
              {depositSource === "sol" && depositFlow.visible && (
                <div className="flow-progress">
                  <div className="flow-track">
                    <div
                      className={`flow-line${depositFlow.swap === "confirmed" || depositFlow.deposit !== "pending" ? " done" : ""}`}
                    />
                  </div>
                  <div className="flow-steps">
                    <div className={`flow-step ${depositFlow.swap}`}>
                      <div className="flow-dot" />
                      <div>
                        <div className="flow-title">Swap SOL to vault token</div>
                        <div className="muted flow-state">
                          {depositFlow.swap === "pending"
                            ? "Waiting"
                            : depositFlow.swap === "in_progress"
                              ? "In progress"
                              : depositFlow.swap === "confirmed"
                                ? "Confirmed"
                                : "Failed"}
                        </div>
                      </div>
                    </div>
                    <div className={`flow-step ${depositFlow.deposit}`}>
                      <div className="flow-dot" />
                      <div>
                        <div className="flow-title">Deposit token to vault</div>
                        <div className="muted flow-state">
                          {depositFlow.deposit === "pending"
                            ? "Waiting"
                            : depositFlow.deposit === "in_progress"
                              ? "In progress"
                              : depositFlow.deposit === "confirmed"
                                ? "Confirmed"
                                : "Failed"}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
              {depositSetupError && <p className="error">{depositSetupError}</p>}
              {depositSetup && (
                <p className="result">
                  {depositSetup.missingAccounts.length === 0
                    ? "All required token accounts already exist. No rent needed."
                    : `Missing ${depositSetup.missingAccounts.length} token account(s). Estimated one-time rent: ~${depositSetup.totalRentSol.toFixed(4)} SOL.`}
                </p>
              )}
              {depositResult && <p className="result">{depositResult}</p>}
              {depositFeeDebug && depositFeeDetails && (
                <p className="result" style={{ whiteSpace: "pre-line" }}>
                  {formatFeeDiagnostics(depositFeeDetails)}
                </p>
              )}
            </div>
          )}

          {activeAction === "withdraw" && (
            <div className="action-panel">
              <div className="move-grid">
                <label>
                  Vault
                  <select
                    value={withdrawVaultId}
                    onChange={(event) => setWithdrawVaultId(event.target.value)}
                  >
                    <option value="">Select vault</option>
                    {fromVaultOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Receive
                  <select
                    value={withdrawTarget}
                    onChange={(event) =>
                      setWithdrawTarget(event.target.value === "sol" ? "sol" : "asset")
                    }
                  >
                    <option value="asset">Vault asset</option>
                    <option value="sol">SOL (swap via Jupiter)</option>
                  </select>
                </label>
                <label>
                  Amount
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={withdrawAmount}
                    onChange={(event) => setWithdrawAmount(event.target.value)}
                    placeholder="0.0"
                  />
                  <div className="quick-amounts">
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyWithdrawPreset(0.25)}
                      disabled={!withdrawVault || withdrawAvailable <= 0}
                    >
                      25%
                    </button>
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyWithdrawPreset(0.5)}
                      disabled={!withdrawVault || withdrawAvailable <= 0}
                    >
                      50%
                    </button>
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyWithdrawPreset(0.75)}
                      disabled={!withdrawVault || withdrawAvailable <= 0}
                    >
                      75%
                    </button>
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyWithdrawPreset(1)}
                      disabled={!withdrawVault || withdrawAvailable <= 0}
                    >
                      100%
                    </button>
                  </div>
                </label>
                <label>
                  Slippage (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={withdrawSlippage}
                    onChange={(event) => setWithdrawSlippage(event.target.value)}
                    placeholder="0.5"
                  />
                </label>
                <label>
                  Priority fee
                  <select
                    value={withdrawPriorityFee}
                    onChange={(event) =>
                      setWithdrawPriorityFee(
                        event.target.value === "low"
                          ? "low"
                          : event.target.value === "auto"
                            ? "auto"
                            : "off"
                      )
                    }
                  >
                    <option value="off">Off</option>
                    <option value="low">Low</option>
                    <option value="auto">Auto</option>
                  </select>
                </label>
                <label>
                  Fee diagnostics
                  <select
                    value={withdrawFeeDebug ? "on" : "off"}
                    onChange={(event) => setWithdrawFeeDebug(event.target.value === "on")}
                  >
                    <option value="off">Off</option>
                    <option value="on">On</option>
                  </select>
                </label>
              </div>
              {withdrawVault && (
                <div className="position-summary">
                  <div>
                    <span className="muted">Available</span>
                    <span className="position-value">
                      {formatTokenAmount(withdrawAvailable, withdrawVault.assetSymbol)}
                    </span>
                  </div>
                </div>
              )}
              <div className="action-footer">
                <button
                  className="primary"
                  onClick={handleWithdraw}
                  disabled={withdrawing || positionsLoading || withdrawAvailable <= 0}
                >
                  {withdrawing ? "Processing..." : "Withdraw"}
                </button>
                {withdrawTarget === "sol" && (
                  <span className="inline-badge">Includes Jupiter swap</span>
                )}
              </div>
              <div className="action-tools">
                <button
                  className="ghost"
                  onClick={() => handleCloseTokenAccounts(withdrawVault, withdrawFeeDebug)}
                  disabled={closingAccounts || !withdrawVault}
                >
                  {closingAccounts ? "Closing accounts..." : "Close token accounts"}
                </button>
              </div>
              {manualSwapResult && <p className="result">{manualSwapResult}</p>}
              {manualSwapFeeDetails && (
                <p className="result" style={{ whiteSpace: "pre-line" }}>
                  {formatFeeDiagnostics(manualSwapFeeDetails)}
                </p>
              )}
              {closeAccountsResult && <p className="result">{closeAccountsResult}</p>}
              {closeAccountsFeeDetails && (
                <p className="result" style={{ whiteSpace: "pre-line" }}>
                  {formatFeeDiagnostics(closeAccountsFeeDetails)}
                </p>
              )}
              {withdrawFlow.length > 0 && (
                <div className="flow-progress">
                  <div className="flow-steps">
                    {withdrawFlow.map((step) => (
                      <div key={step.label} className={`flow-step ${step.status}`}>
                        <div className="flow-dot" />
                        <div>
                          <div className="flow-title">{step.label}</div>
                          <div className="muted flow-state">{flowStateLabel(step.status)}</div>
                          {step.signature && (
                            <div className="muted flow-state">
                              Signature: {truncateAddress(step.signature)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {withdrawResult && <p className="result">{withdrawResult}</p>}
              {withdrawFeeDebug && withdrawFeeDetails && (
                <p className="result" style={{ whiteSpace: "pre-line" }}>
                  {formatFeeDiagnostics(withdrawFeeDetails)}
                </p>
              )}
            </div>
          )}

          {activeAction === "hop" && (
            <div className="action-panel">
              <div className="hop-selector">
                <button
                  type="button"
                  className={`hop-card${hopSelectMode === "from" ? " active" : ""}`}
                  onClick={() => setHopSelectMode("from")}
                >
                  <span className="muted">From vault</span>
                  <span className="route-value">
                    {hopFromVault ? hopFromVault.vaultName : "Select from positions"}
                  </span>
                </button>
                <span className="hop-arrow">↓</span>
                <button
                  type="button"
                  className={`hop-card${hopSelectMode === "to" ? " active" : ""}`}
                  onClick={() => setHopSelectMode("to")}
                >
                  <span className="muted">Destination vault</span>
                  <span className="route-value">
                    {hopToVault ? hopToVault.vaultName : "Select from vault list"}
                  </span>
                </button>
              </div>
              <div className="move-grid">
                <label>
                  Amount
                  <input
                    type="number"
                    min="0"
                    step="any"
                    value={hopAmount}
                    onChange={(event) => setHopAmount(event.target.value)}
                    placeholder="0.0"
                  />
                  <div className="quick-amounts">
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyHopPreset(0.25)}
                      disabled={!hopFromVault || hopAvailable <= 0}
                    >
                      25%
                    </button>
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyHopPreset(0.5)}
                      disabled={!hopFromVault || hopAvailable <= 0}
                    >
                      50%
                    </button>
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyHopPreset(0.75)}
                      disabled={!hopFromVault || hopAvailable <= 0}
                    >
                      75%
                    </button>
                    <button
                      type="button"
                      className="quick-amount"
                      onClick={() => applyHopPreset(1)}
                      disabled={!hopFromVault || hopAvailable <= 0}
                    >
                      100%
                    </button>
                  </div>
                  <span className="muted">
                    {hopFromVault
                      ? `Available: ${formatTokenAmount(hopAvailable, hopFromVault.assetSymbol)}`
                      : "Select a source vault to see available balance."}
                  </span>
                </label>
                <label>
                  Slippage (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    step="0.1"
                    value={hopSlippage}
                    onChange={(event) => setHopSlippage(event.target.value)}
                    placeholder="0.5"
                  />
                </label>
                <label>
                  Priority fee
                  <select
                    value={hopPriorityFee}
                    onChange={(event) =>
                      setHopPriorityFee(
                        event.target.value === "low"
                          ? "low"
                          : event.target.value === "auto"
                            ? "auto"
                            : "off"
                      )
                    }
                  >
                    <option value="off">Off</option>
                    <option value="low">Low</option>
                    <option value="auto">Auto</option>
                  </select>
                </label>
                <label>
                  Fee diagnostics
                  <select
                    value={hopFeeDebug ? "on" : "off"}
                    onChange={(event) => setHopFeeDebug(event.target.value === "on")}
                  >
                    <option value="off">Off</option>
                    <option value="on">On</option>
                  </select>
                </label>
              </div>
              <div className="action-footer">
                <button className="primary" onClick={handleHop} disabled={hopping}>
                  {hopping ? "Processing..." : "Hop vaults"}
                </button>
                {showHopSwap && (
                  <span className="inline-badge">Includes Jupiter swap</span>
                )}
              </div>
              <div className="action-tools">
                <button
                  className="ghost"
                  onClick={() => handleCloseTokenAccounts(hopFromVault, hopFeeDebug)}
                  disabled={closingAccounts || !hopFromVault}
                >
                  {closingAccounts ? "Closing accounts..." : "Close token accounts"}
                </button>
              </div>
              {closeAccountsResult && <p className="result">{closeAccountsResult}</p>}
              {closeAccountsFeeDetails && (
                <p className="result" style={{ whiteSpace: "pre-line" }}>
                  {formatFeeDiagnostics(closeAccountsFeeDetails)}
                </p>
              )}
              {hopFlow.length > 0 && (
                <div className="flow-progress">
                  <div className="flow-steps">
                    {hopFlow.map((step) => (
                      <div key={step.label} className={`flow-step ${step.status}`}>
                        <div className="flow-dot" />
                        <div>
                          <div className="flow-title">{step.label}</div>
                          <div className="muted flow-state">{flowStateLabel(step.status)}</div>
                          {step.signature && (
                            <div className="muted flow-state">
                              Signature: {truncateAddress(step.signature)}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {hopResult && <p className="result">{hopResult}</p>}
              {hopFeeDebug && hopFeeDetails && (
                <p className="result" style={{ whiteSpace: "pre-line" }}>
                  {formatFeeDiagnostics(hopFeeDetails)}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="card sidebar-card">
          <div className="sidebar-head">
            <h2>Transaction timeline</h2>
            <p className="muted">Live status for the current action flow.</p>
          </div>
          {activeFlowSteps.length > 0 ? (
            <div className="flow-progress">
              <div className="flow-steps">
                {activeFlowSteps.map((step) => (
                  <div key={step.label} className={`flow-step ${step.status}`}>
                    <div className="flow-dot" />
                    <div>
                      <div className="flow-title">{step.label}</div>
                      <div className="muted flow-state">{flowStateLabel(step.status)}</div>
                      {step.signature && (
                        <div className="muted flow-state">
                          Signature: {truncateAddress(step.signature)}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="muted">No active transaction yet.</p>
          )}
        </section>

        <section className="card sidebar-card">
          <div className="sidebar-head">
            <h2>Selected vault</h2>
            <p className="muted">Quick details for the vault in focus.</p>
          </div>
          {selectedVault ? (
            <div className="metric-list">
              <div>
                <span className="muted">Asset</span>
                <span className="route-value">{selectedVault.assetSymbol}</span>
              </div>
              <div>
                <span className="muted">APY</span>
                <span className="route-value">{formatPercent(selectedVault.apyTotal)}</span>
              </div>
              <div>
                <span className="muted">TVL</span>
                <span className="route-value">{formatUsd(selectedVault.tvlUsd)}</span>
              </div>
            </div>
          ) : (
            <p className="muted">Select a vault in the table.</p>
          )}
        </section>
      </aside>
      </div>

      <div className="mobile-action-bar">
        <div>
          <div className="muted">Current action</div>
          <div className="mobile-action-title">{activeAction}</div>
        </div>
        {activeAction === "deposit" && (
          <button className="primary" onClick={handleDeposit} disabled={depositing || !selectedVault}>
            {depositing ? "Processing..." : "Fund vault"}
          </button>
        )}
        {activeAction === "withdraw" && (
          <button
            className="primary"
            onClick={handleWithdraw}
            disabled={withdrawing || positionsLoading || withdrawAvailable <= 0}
          >
            {withdrawing ? "Processing..." : "Withdraw"}
          </button>
        )}
        {activeAction === "hop" && (
          <button className="primary" onClick={handleHop} disabled={hopping}>
            {hopping ? "Processing..." : "Hop vaults"}
          </button>
        )}
      </div>
    </div>
  );
}
