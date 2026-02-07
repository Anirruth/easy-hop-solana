import {
  Connection,
  PublicKey,
  Transaction,
  VersionedTransaction
} from "@solana/web3.js";

declare global {
  interface Window {
    solana?: {
      isPhantom?: boolean;
      publicKey?: PublicKey;
      connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
      request?: (args: { method: string; params?: unknown }) => Promise<unknown>;
      disconnect: () => Promise<void>;
      signTransaction: <T extends Transaction | VersionedTransaction>(
        tx: T
      ) => Promise<T>;
      signAllTransactions: <T extends Transaction | VersionedTransaction>(
        txs: T[]
      ) => Promise<T[]>;
    };
    phantom?: { solana?: Window["solana"] };
    solflare?: Window["solana"];
    backpack?: { solana?: Window["solana"] };
  }
}

export type WalletProvider = NonNullable<typeof window.solana>;

export const getWalletProvider = (): WalletProvider | null => {
  if (typeof window === "undefined") return null;
  const grouped = (window.solana as { providers?: WalletProvider[] } | undefined)
    ?.providers;
  if (Array.isArray(grouped) && grouped.length > 0) {
    const phantom = grouped.find((provider) => provider.isPhantom);
    if (phantom) return phantom;
    return grouped[0];
  }
  const phantom = window.phantom?.solana;
  if (phantom?.isPhantom) return phantom;
  if (window.solana?.isPhantom) return window.solana;
  return window.solflare ?? window.backpack?.solana ?? window.solana ?? null;
};

export const connectWallet = async (): Promise<WalletProvider> => {
  const provider = getWalletProvider();
  if (!provider) {
    throw new Error("No wallet provider found. Install Phantom or Solflare.");
  }
  if (provider.publicKey) {
    return provider;
  }
  if (typeof window !== "undefined") {
    const { protocol, hostname } = window.location;
    const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1";
    if (protocol !== "https:" && !isLocalhost) {
      throw new Error(
        `Wallets require https or localhost. Current origin: ${protocol}//${hostname}`
      );
    }
  }

  let lastError: unknown;
  if (typeof provider.connect === "function") {
    try {
      await provider.connect({ onlyIfTrusted: false });
    } catch (error) {
      lastError = error;
      try {
        await provider.connect();
        lastError = undefined;
      } catch (innerError) {
        lastError = innerError ?? error;
      }
    }
  } else if (typeof provider.request === "function") {
    try {
      await provider.request({ method: "connect" });
    } catch (error) {
      lastError = error;
      try {
        await provider.request({
          method: "connect",
          params: { onlyIfTrusted: false }
        });
        lastError = undefined;
      } catch (innerError) {
        lastError = innerError ?? error;
      }
    }
  } else {
    throw new Error("Wallet provider does not support connect().");
  }

  if (lastError) {
    throw lastError;
  }
  if (!provider.publicKey) {
    throw new Error("Wallet connected but no public key found.");
  }
  return provider;
};

export const disconnectWallet = async (provider: WalletProvider) => {
  await provider.disconnect();
};

export const sendTransactions = async (
  connection: Connection,
  provider: WalletProvider,
  transactions: (Transaction | VersionedTransaction)[]
) => {
  if (!transactions.length) return [];

  const { blockhash } = await connection.getLatestBlockhash("finalized");

  const prepared = transactions.map((tx) => {
    if (tx instanceof Transaction) {
      if (!tx.feePayer) {
        tx.feePayer = provider.publicKey!;
      }
      if (!tx.recentBlockhash) {
        tx.recentBlockhash = blockhash;
      }
    }
    return tx;
  });

  const signed = provider.signAllTransactions
    ? await provider.signAllTransactions(prepared)
    : [
        await provider.signTransaction(
          prepared[0] as Transaction | VersionedTransaction
        )
      ];

  const signatures: string[] = [];
  for (const tx of signed) {
    const raw = tx.serialize();
    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed"
    });
    await connection.confirmTransaction(sig, "confirmed");
    signatures.push(sig);
  }

  return signatures;
};
