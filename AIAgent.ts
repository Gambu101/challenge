import Anthropic from "@anthropic-ai/sdk";
import { FailureClass, LifecycleEntry } from "../lifecycle/LifecycleLogger";
import { TipRecommendation, TipStats } from "../bundle/TipCalculator";

export interface RetryDecision {
  shouldRetry: boolean;
  newTipLamports: number;
  refreshBlockhash: boolean;
  waitSlots: number;
  reasoning: string;
  confidence: number; // 0-1
}

export interface TimingDecision {
  submitNow: boolean;
  waitSlots: number;
  reasoning: string;
}

export interface TipDecision {
  lamports: number;
  reasoning: string;
  confidence: number;
}

/**
 * AIAgent
 *
 * Uses Claude claude-sonnet-4-20250514 to make autonomous operational decisions.
 * All retry logic, tip sizing, and submission timing flows through the agent.
 * The agent reasons about real observed data — not rules hardcoded by the developer.
 *
 * The agent is given:
 *   - Recent failure history for this bundle
 *   - Current network conditions (slot pressure, load)
 *   - Live tip statistics from Jito
 *   - The failure classification
 *
 * It reasons and decides:
 *   - Whether to retry
 *   - How much to tip on retry
 *   - Whether to refresh the blockhash
 *   - How many slots to wait before resubmitting
 */
export class AIAgent {
  private client: Anthropic;
  private model = "claude-sonnet-4-20250514";

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
  }

  /**
   * Decide what to do after a bundle failure.
   * This is the core autonomous agent function — it MUST make real decisions
   * based on reasoning, not hardcoded rules.
   */
  async decideRetry(
    failure: LifecycleEntry,
    tipStats: TipStats,
    currentSlot: number,
    previousAttempts: LifecycleEntry[]
  ): Promise<RetryDecision> {
    const context = {
      failureClass: failure.failureClass,
      failureMessage: failure.failureMessage,
      attempt: failure.attempt,
      previousAttempts: previousAttempts.length,
      tipUsed: failure.tipLamports,
      networkLoad: failure.networkLoad,
      slotPressure: failure.slotPressure,
      currentSlot,
      slotsAfterSubmit: failure.failedSlot ? failure.failedSlot - (failure.submittedSlot || 0) : 0,
      tipStats: {
        p25: tipStats.p25,
        p50: tipStats.p50,
        p75: tipStats.p75,
        p90: tipStats.p90,
        sampleCount: tipStats.sampleCount,
      },
    };

    const prompt = `You are an autonomous Solana transaction infrastructure agent. A Jito bundle has failed. Analyze the failure and decide what to do.

FAILURE DATA:
${JSON.stringify(context, null, 2)}

FAILURE CLASSIFICATIONS:
- expired_blockhash: The blockhash is more than ~150 slots old. Must refresh before retrying.
- fee_too_low: Transaction fee was insufficient for inclusion. Increase tip.
- compute_exceeded: CU budget was exceeded. Cannot fix with tip alone; may need different transaction.
- bundle_failure: Jito bundle was rejected (tip too low, leader skip, or race condition).
- leader_skip: The scheduled Jito leader skipped their slot. Bundle is dropped. Must resubmit.
- simulation_failure: Transaction would fail on-chain. Fix the transaction itself.

RULES:
- A simulation_failure should NOT be retried (it will fail again).
- An expired_blockhash MUST refresh the blockhash before retrying.
- If we have tried 3+ times, be very conservative about retrying.
- Tip increases should be proportional to the problem (don't 100x for a marginal fee issue).
- For bundle_failure or leader_skip, a modest tip increase (1.5–2x) plus resubmit is usually right.

Respond ONLY with a valid JSON object. No markdown, no explanation outside the JSON:
{
  "shouldRetry": boolean,
  "newTipLamports": number,
  "refreshBlockhash": boolean,
  "waitSlots": number,
  "reasoning": "one or two sentence explanation of your decision",
  "confidence": number between 0 and 1
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");

      const clean = text.replace(/```json|```/g, "").trim();
      const decision = JSON.parse(clean) as RetryDecision;

      // Safety bounds — agent's lamport values must be sane
      decision.newTipLamports = Math.max(
        1000,
        Math.min(decision.newTipLamports, 10_000_000)
      );
      decision.waitSlots = Math.max(0, Math.min(decision.waitSlots, 50));

      return decision;
    } catch (err) {
      console.error(`[AI] Failed to get retry decision: ${(err as Error).message}`);
      // Fallback: safe defaults when AI is unavailable
      return {
        shouldRetry: failure.attempt < 3 && failure.failureClass !== "simulation_failure",
        newTipLamports: Math.ceil(failure.tipLamports * 1.5),
        refreshBlockhash: failure.failureClass === "expired_blockhash",
        waitSlots: 2,
        reasoning: "AI unavailable — using fallback heuristic: modest tip increase, refresh blockhash if needed.",
        confidence: 0.4,
      };
    }
  }

  /**
   * Decide optimal tip amount for a new submission.
   * Agent balances landing probability vs cost.
   */
  async decideTip(
    tipStats: TipStats,
    urgency: "low" | "medium" | "high",
    networkLoad: "low" | "medium" | "high",
    recentBundleHistory: { tipLamports: number; landed: boolean }[]
  ): Promise<TipDecision> {
    const successfulTips = recentBundleHistory
      .filter((h) => h.landed)
      .map((h) => h.tipLamports);
    const failedTips = recentBundleHistory
      .filter((h) => !h.landed)
      .map((h) => h.tipLamports);

    const prompt = `You are a Solana transaction cost optimizer. Decide the optimal Jito tip in lamports.

CONTEXT:
- Urgency: ${urgency} (high = time-critical, low = can wait)
- Network load: ${networkLoad}
- Recent successful tip amounts: ${successfulTips.length > 0 ? successfulTips.join(", ") : "no history yet"}
- Recent failed tip amounts: ${failedTips.length > 0 ? failedTips.join(", ") : "none"}
- Current tip market stats (lamports):
  p25=${tipStats.p25}, p50=${tipStats.p50}, p75=${tipStats.p75}, p90=${tipStats.p90}
  (based on ${tipStats.sampleCount} samples)

GOAL: Choose a tip that maximizes landing probability while minimizing unnecessary cost.
- For high urgency: land reliably even at higher cost
- For low urgency: land eventually at minimal cost
- Use recent history to calibrate: if p50 tips keep landing, don't go to p90

Respond ONLY with valid JSON:
{
  "lamports": number,
  "reasoning": "one sentence",
  "confidence": number between 0 and 1
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const clean = text.replace(/```json|```/g, "").trim();
      const decision = JSON.parse(clean) as TipDecision;
      decision.lamports = Math.max(1000, Math.min(decision.lamports, 5_000_000));
      return decision;
    } catch (err) {
      // Fallback
      const base = urgency === "high" ? tipStats.p90 : urgency === "medium" ? tipStats.p75 : tipStats.p50;
      return {
        lamports: base,
        reasoning: "AI unavailable — using percentile fallback.",
        confidence: 0.4,
      };
    }
  }

  /**
   * Decide whether to submit now or wait for better slot conditions.
   */
  async decideSubmitTiming(
    currentSlot: number,
    leaderWindow: { startSlot: number; endSlot: number; leader: string } | null,
    slotPressure: number
  ): Promise<TimingDecision> {
    const slotsUntilLeader = leaderWindow ? leaderWindow.startSlot - currentSlot : null;

    const prompt = `You are a Solana transaction timing agent. Decide if we should submit a Jito bundle now or wait.

CURRENT STATE:
- Current slot: ${currentSlot}
- Slot pressure (0=empty, 1=full): ${slotPressure.toFixed(2)}
- Next Jito leader window: ${leaderWindow ? `starts at slot ${leaderWindow.startSlot} (${slotsUntilLeader} slots away, leader=${leaderWindow.leader})` : "unknown"}

RULES:
- Bundles should be submitted 1-2 slots before the leader window to allow propagation
- If pressure > 0.8, the chain is congested — consider waiting 2-5 slots
- If the leader window is more than 10 slots away, submit now to maximize propagation time
- If the leader window is 0-1 slots away, submit immediately

Respond ONLY with valid JSON:
{
  "submitNow": boolean,
  "waitSlots": number,
  "reasoning": "one sentence"
}`;

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 256,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      const clean = text.replace(/```json|```/g, "").trim();
      return JSON.parse(clean) as TimingDecision;
    } catch (err) {
      // Fallback
      return {
        submitNow: true,
        waitSlots: 0,
        reasoning: "AI unavailable — submitting immediately.",
      };
    }
  }
}
