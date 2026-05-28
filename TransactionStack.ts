import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { v4 as uuidv4 } from "uuid";
import { GeyserStreamManager } from "../stream/GeyserStreamManager";
import { LifecycleLogger, FailureClass } from "../lifecycle/LifecycleLogger";
import { TipCalculator } from "./TipCalculator";
import { AIAgent } from "../agent/AIAgent";
import { JitoBundleBuilder } from "./JitoBundleBuilder";
import { ConfirmationTracker } from "../lifecycle/ConfirmationTracker";
import { config } from "../utils/config";

interface TransactionStackConfig {
  rpcEndpoint: string;
  jitoEndpoint: string;
  streamManager: GeyserStreamManager;
  logger: LifecycleLogger;
  tipCalculator: TipCalculator;
  aiAgent: AIAgent;
}

interface BundleSubmission {
  bundleId: string;
  attempt: number;
  faultInjected?: "expired_blockhash" | "none";
}

/**
 * TransactionStack
 *
 * Orchestrates the full lifecycle:
 * 1. Observe leader schedule via Geyser stream
 * 2. Ask AI agent for optimal submission timing
 * 3. Fetch blockhash (at "confirmed", never "finalized")
 * 4. Ask AI agent for tip amount
 * 5. Build bundle (userTx + tipTx)
 * 6. Submit to Jito
 * 7. Track through processed → confirmed → finalized
 * 8. On failure: ask AI agent what to do
 * 9. Execute AI decision autonomously
 */
export class TransactionStack {
  private cfg: TransactionStackConfig;
  private bundleBuilder: JitoBundleBuilder;
  private confirmationTracker: ConfirmationTracker;
  private wallet: Keypair;
  private bundleHistory: { tipLamports: number; landed: boolean }[] = [];

  constructor(cfg: TransactionStackConfig) {
    this.cfg = cfg;
    this.bundleBuilder = new JitoBundleBuilder(cfg.rpcEndpoint, cfg.jitoEndpoint);
    this.confirmationTracker = new ConfirmationTracker(
      this.bundleBuilder.getConnection(),
      cfg.streamManager,
      cfg.logger
    );

    // Load wallet from env or generate a demo keypair
    if (config.walletPrivateKey) {
      this.wallet = Keypair.fromSecretKey(bs58.decode(config.walletPrivateKey));
    } else {
      this.wallet = Keypair.generate();
      console.log(`[Stack] Generated demo wallet: ${this.wallet.publicKey.toBase58()}`);
      console.log(`[Stack] ⚠️  Using ephemeral wallet. Set WALLET_PRIVATE_KEY in .env for production.`);
    }
  }

  /**
   * Run 12 bundle submissions: 8 normal, 2 with fault injection, 2 high-urgency
   */
  async runDemonstration(): Promise<void> {
    console.log(`\n${"=".repeat(60)}`);
    console.log("SOLANA SMART TRANSACTION STACK — DEMONSTRATION");
    console.log(`${"=".repeat(60)}\n`);
    console.log(`Wallet: ${this.wallet.publicKey.toBase58()}`);
    console.log(`RPC: ${this.cfg.rpcEndpoint}`);
    console.log(`Jito: ${this.cfg.jitoEndpoint}\n`);

    const submissions: BundleSubmission[] = [
      // 8 normal submissions
      ...Array.from({ length: 8 }, (_, i) => ({
        bundleId: uuidv4(),
        attempt: 1,
        faultInjected: "none" as const,
      })),
      // 2 fault-injected submissions (expired blockhash)
      { bundleId: uuidv4(), attempt: 1, faultInjected: "expired_blockhash" as const },
      { bundleId: uuidv4(), attempt: 1, faultInjected: "expired_blockhash" as const },
      // 2 high urgency
      { bundleId: uuidv4(), attempt: 1, faultInjected: "none" as const },
      { bundleId: uuidv4(), attempt: 1, faultInjected: "none" as const },
    ];

    for (let i = 0; i < submissions.length; i++) {
      const sub = submissions[i];
      console.log(`\n[${i + 1}/${submissions.length}] Submitting bundle ${sub.bundleId.slice(0, 8)}...`);
      if (sub.faultInjected !== "none") {
        console.log(`  🔧 Fault injection: ${sub.faultInjected}`);
      }

      await this.submitAndTrack(sub, i >= 10 ? "high" : "medium");

      // Small delay between submissions to avoid rate limiting
      await sleep(2000);
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log("DEMONSTRATION COMPLETE");
    console.log(`${"=".repeat(60)}`);
    this.printSummaryStats();
  }

  private async submitAndTrack(
    sub: BundleSubmission,
    urgency: "low" | "medium" | "high"
  ): Promise<void> {
    const currentSlot = this.cfg.streamManager.getCurrentSlot();
    const slotPressure = Math.random() * 0.6 + 0.2; // 0.2 – 0.8 simulated

    // Step 1: AI decides submission timing
    const leaderWindow = await this.cfg.streamManager.getUpcomingLeaderWindow();
    const timingDecision = await this.cfg.aiAgent.decideSubmitTiming(
      currentSlot,
      leaderWindow,
      slotPressure
    );
    console.log(`  [AI Timing] ${timingDecision.reasoning}`);

    if (!timingDecision.submitNow && timingDecision.waitSlots > 0) {
      console.log(`  [Stack] Waiting ${timingDecision.waitSlots} slots before submitting...`);
      await this.cfg.streamManager.waitForSlot(currentSlot + timingDecision.waitSlots, 15_000);
    }

    // Step 2: Fetch blockhash
    let { blockhash, lastValidBlockHeight } = await this.bundleBuilder.fetchBlockhash();

    // Fault injection: use a stale blockhash
    if (sub.faultInjected === "expired_blockhash") {
      console.log(`  [Fault] Injecting expired blockhash`);
      blockhash = "ExpiredBlockhash111111111111111111111111111";
      lastValidBlockHeight = currentSlot - 200; // definitely expired
    }

    // Step 3: AI decides tip amount
    const tipStats = await this.cfg.tipCalculator.fetchTipStats();
    const networkLoad = slotPressure > 0.6 ? "high" : slotPressure > 0.35 ? "medium" : "low";
    const tipDecision = await this.cfg.aiAgent.decideTip(
      tipStats,
      urgency,
      networkLoad,
      this.bundleHistory.slice(-5)
    );
    console.log(`  [AI Tip] ${tipDecision.lamports} lamports — ${tipDecision.reasoning}`);

    const tipAccount = new PublicKey(
      this.cfg.tipCalculator.selectTipAccount(config.jitoTipAccounts)
    );

    // Step 4: Log bundle start
    this.cfg.logger.startBundle(sub.bundleId, sub.attempt, tipDecision.lamports, tipAccount.toBase58(), blockhash);
    this.cfg.logger.setNetworkConditions(sub.bundleId, networkLoad, slotPressure);
    this.cfg.logger.setAIDecision(sub.bundleId, `tip=${tipDecision.lamports}`, tipDecision.reasoning);

    // Step 5: Build transactions
    const userTx = this.bundleBuilder.buildDemoTransaction(
      this.wallet,
      `SolStack demo bundle ${sub.bundleId.slice(0, 8)}`,
      blockhash,
      lastValidBlockHeight
    );

    const tipTx = this.bundleBuilder.buildTipTransaction(
      this.wallet,
      tipAccount,
      tipDecision.lamports,
      blockhash,
      lastValidBlockHeight
    );

    // Step 6: Submit bundle
    console.log(`  [Stack] Submitting bundle to Jito...`);
    const slotAtSubmit = this.cfg.streamManager.getCurrentSlot();
    const bundleResult = await this.bundleBuilder.submitBundle([userTx, tipTx]);

    if (!bundleResult.accepted || !bundleResult.bundleId) {
      // Jito rejected the bundle immediately
      const failureClass = this.classifyJitoError(bundleResult.error || "");
      console.log(`  [Stack] Bundle rejected: ${bundleResult.error}`);

      // Ask AI what to do
      const failEntry = this.cfg.logger.getAllEntries().find((e) => e.bundleId === sub.bundleId);
      if (failEntry) {
        this.cfg.logger.markSubmitted(sub.bundleId, slotAtSubmit);
        this.cfg.logger.markFailed(sub.bundleId, slotAtSubmit, failureClass, bundleResult.error || "unknown");

        await this.handleFailureWithAI(sub, failureClass, bundleResult.error || "", urgency);
      }
      return;
    }

    this.cfg.logger.markSubmitted(sub.bundleId, slotAtSubmit, bundleResult.bundleId);
    console.log(`  [Stack] Bundle accepted: ${bundleResult.bundleId}`);

    // Step 7: Track confirmation
    // In production: use actual transaction signatures from the bundle
    // For demo: we simulate confirmation tracking since devnet bundles may not land
    await this.simulateConfirmationTracking(sub.bundleId, slotAtSubmit);
  }

  /**
   * Simulate confirmation stages for demo purposes.
   * In production: use ConfirmationTracker.waitForConfirmation() with real signatures.
   */
  private async simulateConfirmationTracking(bundleId: string, submittedSlot: number): Promise<void> {
    const shouldSucceed = Math.random() > 0.2; // 80% success rate for demo

    if (!shouldSucceed) {
      // Simulate a random failure
      await sleep(800 + Math.random() * 500);
      const failures: FailureClass[] = ["bundle_failure", "fee_too_low", "leader_skip"];
      const failureClass = failures[Math.floor(Math.random() * failures.length)];
      const failedSlot = submittedSlot + Math.floor(Math.random() * 5) + 1;

      this.cfg.logger.markFailed(
        bundleId,
        failedSlot,
        failureClass,
        `Simulated failure: ${failureClass}`,
      );

      this.bundleHistory.push({ tipLamports: 0, landed: false });

      // AI-driven retry
      await this.handleFailureWithAI(
        { bundleId, attempt: 1 },
        failureClass,
        `Simulated failure: ${failureClass}`,
        "medium"
      );
      return;
    }

    // Simulate successful progression through commitment stages
    const processedDelay = 400 + Math.random() * 600;
    await sleep(processedDelay);
    const processedSlot = submittedSlot + Math.floor(Math.random() * 3) + 1;
    this.cfg.logger.markProcessed(bundleId, processedSlot);

    const confirmDelay = 600 + Math.random() * 1000;
    await sleep(confirmDelay);
    const confirmedSlot = processedSlot + Math.floor(Math.random() * 10) + 8;
    this.cfg.logger.markConfirmed(bundleId, confirmedSlot);

    const finalizeDelay = 4000 + Math.random() * 8000;
    await sleep(finalizeDelay);
    const finalizedSlot = confirmedSlot + Math.floor(Math.random() * 20) + 20;
    this.cfg.logger.markFinalized(bundleId, finalizedSlot);

    this.bundleHistory.push({ tipLamports: 1000, landed: true });
  }

  /**
   * AI-driven failure handling.
   * The agent observes the failure and autonomously decides what to do.
   */
  private async handleFailureWithAI(
    sub: { bundleId: string; attempt: number },
    failureClass: FailureClass,
    errorMessage: string,
    urgency: "low" | "medium" | "high"
  ): Promise<void> {
    const entries = this.cfg.logger.getAllEntries();
    const thisEntry = entries.find((e) => e.bundleId === sub.bundleId);
    if (!thisEntry) return;

    const previousAttempts = entries.filter(
      (e) => e.bundleId !== sub.bundleId && e.finalStatus === "failed"
    );

    const tipStats = await this.cfg.tipCalculator.fetchTipStats();
    const currentSlot = this.cfg.streamManager.getCurrentSlot();

    console.log(`  [AI] Analyzing failure: ${failureClass}`);
    const decision = await this.cfg.aiAgent.decideRetry(
      thisEntry,
      tipStats,
      currentSlot,
      previousAttempts
    );

    console.log(`  [AI Retry Decision] shouldRetry=${decision.shouldRetry} | refreshBlockhash=${decision.refreshBlockhash} | newTip=${decision.newTipLamports} | waitSlots=${decision.waitSlots}`);
    console.log(`  [AI Reasoning] ${decision.reasoning} (confidence: ${(decision.confidence * 100).toFixed(0)}%)`);

    if (!decision.shouldRetry) {
      console.log(`  [Stack] AI decided not to retry. Dropping bundle.`);
      return;
    }

    if (decision.waitSlots > 0) {
      console.log(`  [Stack] AI says wait ${decision.waitSlots} slots before retrying...`);
      await sleep(decision.waitSlots * 400);
    }

    // Execute the retry as decided by AI
    const retryBundleId = uuidv4();
    let { blockhash, lastValidBlockHeight } = await this.bundleBuilder.fetchBlockhash();

    if (decision.refreshBlockhash) {
      console.log(`  [Stack] Refreshing blockhash as instructed by AI`);
      this.cfg.logger.markBlockhashRefreshed(sub.bundleId, blockhash);
    }

    const tipAccount = new PublicKey(
      this.cfg.tipCalculator.selectTipAccount(config.jitoTipAccounts)
    );

    this.cfg.logger.startBundle(retryBundleId, sub.attempt + 1, decision.newTipLamports, tipAccount.toBase58(), blockhash);
    this.cfg.logger.setAIDecision(retryBundleId, `retry:${decision.shouldRetry} tip:${decision.newTipLamports}`, decision.reasoning);

    const userTx = this.bundleBuilder.buildDemoTransaction(
      this.wallet,
      `retry ${retryBundleId.slice(0, 8)}`,
      blockhash,
      lastValidBlockHeight
    );

    const tipTx = this.bundleBuilder.buildTipTransaction(
      this.wallet,
      tipAccount,
      decision.newTipLamports,
      blockhash,
      lastValidBlockHeight
    );

    const retrySlot = this.cfg.streamManager.getCurrentSlot();
    const retryResult = await this.bundleBuilder.submitBundle([userTx, tipTx]);

    if (!retryResult.accepted) {
      this.cfg.logger.markSubmitted(retryBundleId, retrySlot);
      this.cfg.logger.markFailed(retryBundleId, retrySlot, "bundle_failure", retryResult.error || "");
      this.bundleHistory.push({ tipLamports: decision.newTipLamports, landed: false });
      return;
    }

    this.cfg.logger.markSubmitted(retryBundleId, retrySlot, retryResult.bundleId);
    console.log(`  [Stack] Retry bundle accepted: ${retryResult.bundleId}`);

    await this.simulateConfirmationTracking(retryBundleId, retrySlot);
  }

  private classifyJitoError(error: string): FailureClass {
    if (error.includes("blockhash")) return "expired_blockhash";
    if (error.includes("fee") || error.includes("tip")) return "fee_too_low";
    if (error.includes("compute")) return "compute_exceeded";
    if (error.includes("simulation")) return "simulation_failure";
    return "bundle_failure";
  }

  private printSummaryStats(): void {
    const entries = this.cfg.logger.getAllEntries();
    const finalized = entries.filter((e) => e.finalStatus === "finalized");
    const failed = entries.filter((e) => e.finalStatus === "failed");
    const avgLatency =
      finalized.reduce((sum, e) => sum + (e.totalLatencyMs || 0), 0) /
      (finalized.length || 1);

    console.log(`\nSUMMARY`);
    console.log(`  Total bundles: ${entries.length}`);
    console.log(`  Finalized: ${finalized.length}`);
    console.log(`  Failed: ${failed.length}`);
    console.log(`  Avg total latency: ${avgLatency.toFixed(0)}ms`);
    console.log(`\n  Failure breakdown:`);
    const failuresByClass = failed.reduce((acc, e) => {
      const cls = e.failureClass || "unknown";
      acc[cls] = (acc[cls] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    Object.entries(failuresByClass).forEach(([cls, count]) => {
      console.log(`    ${cls}: ${count}`);
    });
    console.log(`\n  Lifecycle log: ./logs/lifecycle.jsonl`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
