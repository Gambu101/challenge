import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

export interface BundleConfig {
  rpcEndpoint: string;
  jitoEndpoint: string;
  walletKeypair: Keypair;
  tipAccount: PublicKey;
  tipLamports: number;
  blockhash: string;
  lastValidBlockHeight: number;
}

export interface BundleResult {
  bundleId: string;
  accepted: boolean;
  error?: string;
  slot?: number;
}

/**
 * JitoBundleBuilder
 *
 * Constructs and submits Jito bundles.
 * A Jito bundle is an ordered list of transactions that are atomically submitted.
 * The last transaction in the bundle must be a tip payment to a Jito tip account.
 *
 * Bundle format:
 *   [userTx1, userTx2, ..., tipTx]
 *
 * The tip transaction is a simple SOL transfer to one of Jito's 8 tip accounts.
 * Bundles are submitted via Jito's sendBundle RPC method.
 */
export class JitoBundleBuilder {
  private connection: Connection;
  private jitoEndpoint: string;

  constructor(rpcEndpoint: string, jitoEndpoint: string) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
    this.jitoEndpoint = jitoEndpoint;
  }

  /**
   * Build a demo transaction (self-transfer of 0 lamports with a memo).
   * In production, replace with your actual transaction instructions.
   */
  buildDemoTransaction(
    wallet: Keypair,
    memo: string,
    blockhash: string,
    lastValidBlockHeight: number
  ): Transaction {
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: wallet.publicKey,
      lastValidBlockHeight,
    });

    // Add compute budget instruction
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })
    );

    // Add a memo instruction (acts as the "real" user instruction)
    tx.add(
      new TransactionInstruction({
        keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: false }],
        programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
        data: Buffer.from(memo, "utf-8"),
      })
    );

    tx.sign(wallet);
    return tx;
  }

  /**
   * Build the Jito tip transaction.
   * This is a simple SOL transfer to a Jito tip account.
   */
  buildTipTransaction(
    wallet: Keypair,
    tipAccount: PublicKey,
    tipLamports: number,
    blockhash: string,
    lastValidBlockHeight: number
  ): Transaction {
    const tx = new Transaction({
      recentBlockhash: blockhash,
      feePayer: wallet.publicKey,
      lastValidBlockHeight,
    });

    tx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      })
    );

    tx.sign(wallet);
    return tx;
  }

  /**
   * Submit a bundle to the Jito block engine.
   * Returns the bundle ID and acceptance status.
   */
  async submitBundle(transactions: Transaction[]): Promise<BundleResult> {
    const serialized = transactions.map((tx) =>
      Buffer.from(tx.serialize()).toString("base64")
    );

    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [serialized],
    };

    try {
      const response = await fetch(`${this.jitoEndpoint}/api/v1/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (data.error) {
        return {
          bundleId: "",
          accepted: false,
          error: `Jito error ${data.error.code}: ${data.error.message}`,
        };
      }

      return {
        bundleId: data.result as string,
        accepted: true,
      };
    } catch (err) {
      return {
        bundleId: "",
        accepted: false,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Poll Jito for bundle status.
   * Jito bundle statuses: Invalid, Pending, Failed, Landed
   */
  async getBundleStatus(bundleId: string): Promise<{
    status: "invalid" | "pending" | "failed" | "landed";
    slot?: number;
    transactions?: string[];
    error?: string;
  }> {
    try {
      const response = await fetch(`${this.jitoEndpoint}/api/v1/bundles`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getBundleStatuses",
          params: [[bundleId]],
        }),
      });

      const data = await response.json();
      const result = data.result?.value?.[0];

      if (!result) return { status: "pending" };

      return {
        status: result.confirmation_status?.toLowerCase() || "pending",
        slot: result.slot,
        transactions: result.transactions,
        error: result.err ? JSON.stringify(result.err) : undefined,
      };
    } catch (err) {
      return { status: "pending", error: (err as Error).message };
    }
  }

  getConnection(): Connection {
    return this.connection;
  }

  /**
   * Fetch a fresh blockhash.
   * Uses "confirmed" commitment — see README for why NOT to use "finalized" here.
   */
  async fetchBlockhash(): Promise<{ blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
    return { blockhash, lastValidBlockHeight };
  }
}
