import * as fs from "fs";
import * as path from "path";

export type CommitmentLevel = "submitted" | "processed" | "confirmed" | "finalized" | "failed";

export type FailureClass =
  | "expired_blockhash"
  | "fee_too_low"
  | "compute_exceeded"
  | "bundle_failure"
  | "leader_skip"
  | "simulation_failure"
  | "unknown";

export interface LifecycleEntry {
  bundleId: string;
  attempt: number;
  txSignature?: string;

  // Tip
  tipLamports: number;
  tipSol: number;
  tipAccount: string;

  // Stages — each is null until reached
  submittedAt?: number;
  submittedSlot?: number;

  processedAt?: number;
  processedSlot?: number;

  confirmedAt?: number;
  confirmedSlot?: number;

  finalizedAt?: number;
  finalizedSlot?: number;

  failedAt?: number;
  failedSlot?: number;

  // Derived latencies (ms)
  submitToProcessMs?: number;
  processToConfirmMs?: number;
  confirmToFinalizeMs?: number;
  totalLatencyMs?: number;

  // Outcome
  finalStatus: CommitmentLevel;
  failureClass?: FailureClass;
  failureMessage?: string;

  // AI agent reasoning (if applicable)
  aiDecision?: string;
  aiReasoning?: string;

  // Network conditions at submission time
  networkLoad?: "low" | "medium" | "high";
  slotPressure?: number;

  blockhashUsed?: string;
  blockhashRefreshed?: boolean;
}

export class LifecycleLogger {
  private logPath: string;
  private entries: Map<string, LifecycleEntry> = new Map();

  constructor(logPath: string) {
    this.logPath = logPath;
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Append mode — existing logs preserved
    console.log(`[Logger] Logging lifecycle events to ${logPath}`);
  }

  startBundle(bundleId: string, attempt: number, tipLamports: number, tipAccount: string, blockhash: string): void {
    const entry: LifecycleEntry = {
      bundleId,
      attempt,
      tipLamports,
      tipSol: tipLamports / 1e9,
      tipAccount,
      finalStatus: "submitted",
      blockhashUsed: blockhash,
      blockhashRefreshed: false,
    };
    this.entries.set(bundleId, entry);
  }

  markSubmitted(bundleId: string, slot: number, txSignature?: string): void {
    const entry = this.get(bundleId);
    entry.submittedAt = Date.now();
    entry.submittedSlot = slot;
    entry.finalStatus = "submitted";
    if (txSignature) entry.txSignature = txSignature;
  }

  markProcessed(bundleId: string, slot: number): void {
    const entry = this.get(bundleId);
    entry.processedAt = Date.now();
    entry.processedSlot = slot;
    entry.finalStatus = "processed";
    if (entry.submittedAt) {
      entry.submitToProcessMs = entry.processedAt - entry.submittedAt;
    }
  }

  markConfirmed(bundleId: string, slot: number): void {
    const entry = this.get(bundleId);
    entry.confirmedAt = Date.now();
    entry.confirmedSlot = slot;
    entry.finalStatus = "confirmed";
    if (entry.processedAt) {
      entry.processToConfirmMs = entry.confirmedAt - entry.processedAt;
    }
  }

  markFinalized(bundleId: string, slot: number): void {
    const entry = this.get(bundleId);
    entry.finalizedAt = Date.now();
    entry.finalizedSlot = slot;
    entry.finalStatus = "finalized";
    if (entry.confirmedAt) {
      entry.confirmToFinalizeMs = entry.finalizedAt - entry.confirmedAt;
    }
    if (entry.submittedAt) {
      entry.totalLatencyMs = entry.finalizedAt - entry.submittedAt;
    }
    this.flush(bundleId);
  }

  markFailed(
    bundleId: string,
    slot: number,
    failureClass: FailureClass,
    message: string,
    aiDecision?: string,
    aiReasoning?: string
  ): void {
    const entry = this.get(bundleId);
    entry.failedAt = Date.now();
    entry.failedSlot = slot;
    entry.finalStatus = "failed";
    entry.failureClass = failureClass;
    entry.failureMessage = message;
    if (aiDecision) entry.aiDecision = aiDecision;
    if (aiReasoning) entry.aiReasoning = aiReasoning;
    if (entry.submittedAt) {
      entry.totalLatencyMs = entry.failedAt - entry.submittedAt;
    }
    this.flush(bundleId);
  }

  setNetworkConditions(bundleId: string, networkLoad: "low" | "medium" | "high", slotPressure: number): void {
    const entry = this.get(bundleId);
    entry.networkLoad = networkLoad;
    entry.slotPressure = slotPressure;
  }

  setAIDecision(bundleId: string, decision: string, reasoning: string): void {
    const entry = this.get(bundleId);
    entry.aiDecision = decision;
    entry.aiReasoning = reasoning;
  }

  markBlockhashRefreshed(bundleId: string, newBlockhash: string): void {
    const entry = this.get(bundleId);
    entry.blockhashRefreshed = true;
    entry.blockhashUsed = newBlockhash;
  }

  private get(bundleId: string): LifecycleEntry {
    const entry = this.entries.get(bundleId);
    if (!entry) throw new Error(`No entry found for bundleId ${bundleId}`);
    return entry;
  }

  private flush(bundleId: string): void {
    const entry = this.entries.get(bundleId);
    if (!entry) return;
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(this.logPath, line, "utf-8");
    this.printSummary(entry);
  }

  private printSummary(entry: LifecycleEntry): void {
    const status = entry.finalStatus === "failed" ? `❌ FAILED [${entry.failureClass}]` : "✅ FINALIZED";
    console.log(`\n[Lifecycle] Bundle ${entry.bundleId.slice(0, 8)}... | Attempt ${entry.attempt}`);
    console.log(`  Status: ${status}`);
    console.log(`  Tip: ${entry.tipLamports} lamports (${entry.tipSol.toFixed(9)} SOL)`);
    console.log(`  Slots: submitted=${entry.submittedSlot} processed=${entry.processedSlot} confirmed=${entry.confirmedSlot} finalized=${entry.finalizedSlot}`);
    if (entry.submitToProcessMs !== undefined)
      console.log(`  Latencies: submit→process=${entry.submitToProcessMs}ms process→confirm=${entry.processToConfirmMs}ms confirm→finalize=${entry.confirmToFinalizeMs}ms`);
    if (entry.aiDecision)
      console.log(`  AI Decision: ${entry.aiDecision}`);
    if (entry.failureMessage)
      console.log(`  Failure: ${entry.failureMessage}`);
    if (entry.blockhashRefreshed)
      console.log(`  Blockhash was refreshed during retry`);
  }

  getAllEntries(): LifecycleEntry[] {
    return Array.from(this.entries.values());
  }
}
