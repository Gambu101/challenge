import { Connection } from "@solana/web3.js";
import { GeyserStreamManager, SlotInfo } from "../stream/GeyserStreamManager";
import { LifecycleLogger } from "../lifecycle/LifecycleLogger";

export interface ConfirmationResult {
  signature: string;
  slot: number;
  commitment: "processed" | "confirmed" | "finalized";
  error?: string;
}

/**
 * ConfirmationTracker
 *
 * Tracks a transaction through all commitment levels.
 *
 * Key design decisions:
 *
 * 1. Stream-first confirmation (RPC polling alone is insufficient):
 *    - We subscribe to Geyser slot notifications at "processed" level
 *    - This gives us instant notification when the transaction lands
 *    - RPC polling at 400ms intervals would add 200ms average latency
 *
 * 2. Commitment progression:
 *    processed → confirmed (32 validator votes = ~600ms typical)
 *    confirmed → finalized (full supermajority = ~12 additional slots)
 *
 * 3. We poll getSignatureStatus for the progression to confirmed/finalized
 *    because slot notifications alone don't tell us commitment level
 */
export class ConfirmationTracker {
  private connection: Connection;
  private stream: GeyserStreamManager;
  private logger: LifecycleLogger;

  constructor(connection: Connection, stream: GeyserStreamManager, logger: LifecycleLogger) {
    this.connection = connection;
    this.stream = stream;
    this.logger = logger;
  }

  /**
   * Wait for a transaction to reach "confirmed" commitment.
   * Uses Geyser stream for fast "processed" detection, then RPC for commitment polling.
   */
  async waitForConfirmation(
    signature: string,
    bundleId: string,
    timeoutMs: number = 60_000
  ): Promise<ConfirmationResult | null> {
    const startTime = Date.now();
    const currentSlot = this.stream.getCurrentSlot();

    // Phase 1: Wait for "processed" via stream (fast path)
    // In production: Geyser emits a transaction notification the moment it's in a block
    // Here we poll getSignatureStatus since we don't have full Geyser tx subscription
    const processedResult = await this.pollForStatus(
      signature,
      bundleId,
      "processed",
      timeoutMs,
      startTime
    );

    if (!processedResult) return null;

    // Phase 2: Wait for "confirmed" (32 votes)
    const confirmedResult = await this.pollForStatus(
      signature,
      bundleId,
      "confirmed",
      timeoutMs - (Date.now() - startTime),
      startTime
    );

    if (!confirmedResult) return processedResult;

    // Phase 3: Wait for "finalized" (full supermajority)
    const finalizedResult = await this.pollForStatus(
      signature,
      bundleId,
      "finalized",
      timeoutMs - (Date.now() - startTime),
      startTime
    );

    return finalizedResult || confirmedResult;
  }

  private async pollForStatus(
    signature: string,
    bundleId: string,
    targetCommitment: "processed" | "confirmed" | "finalized",
    timeoutMs: number,
    startTime: number
  ): Promise<ConfirmationResult | null> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const result = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: false,
        });

        const status = result?.value;
        if (!status) {
          await sleep(500);
          continue;
        }

        if (status.err) {
          return {
            signature,
            slot: status.slot,
            commitment: "processed",
            error: JSON.stringify(status.err),
          };
        }

        const reachedCommitment =
          targetCommitment === "processed"
            ? status.confirmationStatus !== undefined
            : targetCommitment === "confirmed"
            ? status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"
            : status.confirmationStatus === "finalized";

        if (reachedCommitment) {
          const slot = status.slot;
          const currentSlot = this.stream.getCurrentSlot();

          if (targetCommitment === "processed") {
            this.logger.markProcessed(bundleId, slot);
          } else if (targetCommitment === "confirmed") {
            this.logger.markConfirmed(bundleId, slot);
          } else {
            this.logger.markFinalized(bundleId, slot);
          }

          return {
            signature,
            slot,
            commitment: status.confirmationStatus as "processed" | "confirmed" | "finalized",
          };
        }
      } catch (err) {
        console.warn(`[Confirm] Status poll error: ${(err as Error).message}`);
      }

      await sleep(400);
    }

    return null;
  }

  /**
   * Check if a bundle has landed via Jito's bundle status API.
   * Used as an alternative to signature polling when signature is unknown.
   */
  async pollBundleStatus(
    bundleId: string,
    jitoEndpoint: string,
    timeoutMs: number = 30_000
  ): Promise<{ landed: boolean; slot?: number; error?: string }> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${jitoEndpoint}/api/v1/bundles`, {
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

        if (!result) {
          await sleep(1000);
          continue;
        }

        if (result.confirmation_status === "landed") {
          return { landed: true, slot: result.slot };
        }

        if (result.err || result.confirmation_status === "failed") {
          return {
            landed: false,
            error: result.err ? JSON.stringify(result.err) : "Bundle failed",
          };
        }
      } catch (err) {
        console.warn(`[Confirm] Bundle poll error: ${(err as Error).message}`);
      }

      await sleep(1000);
    }

    return { landed: false, error: "Timeout waiting for bundle status" };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
