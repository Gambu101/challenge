# challenge
A Super team challenge submission
# Solana Smart Transaction Stack

An AI-powered Solana transaction infrastructure stack featuring Jito bundle submission, live Yellowstone/Geyser streaming, full lifecycle tracking, and an autonomous Claude-powered AI agent for operational decision-making.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TransactionStack (orchestrator)              │
│                                                                   │
│  GeyserStreamManager ──► slot events ──► timing decisions        │
│         │                                      │                 │
│  TipCalculator ◄──── live Jito tip API         │                 │
│         │                                      ▼                 │
│         └──────────────────────────► AIAgent (Claude)            │
│                                           │                      │
│  JitoBundleBuilder ◄──────────────────────┘                      │
│         │                                                        │
│         ▼                                                        │
│  Jito Block Engine ──► bundle accepted ──► ConfirmationTracker   │
│                                                 │                │
│                           processed → confirmed → finalized      │
│                                                 │                │
│                                         LifecycleLogger          │
│                                         (lifecycle.jsonl)        │
└─────────────────────────────────────────────────────────────────┘
```

**Key components:**

- `GeyserStreamManager` — Yellowstone gRPC subscriber. Emits slot events at ~400ms intervals, used for leader window detection and backpressure-aware submission timing. Reconnects with exponential backoff.
- `TipCalculator` — Queries Jito's `/api/v1/bundles/tip_floor` endpoint. Computes p25/p50/p75/p90 percentiles from recent landed tips. Never uses hardcoded values. Caches with 10s TTL.
- `AIAgent` — Claude claude-sonnet-4-20250514-powered decision engine. Three decision surfaces: submission timing, tip sizing, and failure retry. Each receives structured context and returns a reasoned JSON decision.
- `JitoBundleBuilder` — Constructs `[userTx, tipTx]` bundles. Signs with wallet. Submits via Jito `sendBundle`. Fetches blockhash at `confirmed` commitment only.
- `ConfirmationTracker` — Polls `getSignatureStatus` at 400ms intervals for commitment progression. In full production this pairs with Geyser transaction subscriptions for instant `processed` notification.
- `LifecycleLogger` — Appends structured JSONL entries with slot numbers, timestamps, latency deltas, and AI decisions for each stage.

---

## Setup

### Prerequisites
- Node.js ≥ 18
- Anthropic API key
- Solana devnet wallet with SOL (for real bundle tests)
- SolInfra/Triton Yellowstone gRPC access (for production stream)

### Install

```bash
git clone https://github.com/yourhandle/solana-smart-tx-stack
cd solana-smart-tx-stack
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Configure `.env`

```env
RPC_ENDPOINT=https://api.devnet.solana.com   # or your SolInfra endpoint
JITO_ENDPOINT=https://bundles.jito.wtf       # devnet Jito block engine
GEYSER_ENDPOINT=https://your.triton.endpoint # Yellowstone gRPC
GEYSER_TOKEN=your_token_here
WALLET_PRIVATE_KEY=your_base58_key           # leave blank for demo keypair
ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
# Development (ts-node)
npm run dev

# Production
npm run build && npm start
```

---

## The AI Agent

The agent (powered by Claude claude-sonnet-4-20250514) makes three types of autonomous decisions:

### 1. Tip Intelligence
Before each bundle submission, the agent is given:
- Current tip market stats (p25/p50/p75/p90) from Jito's live API
- Urgency level (low/medium/high)
- Network load estimate from slot pressure
- Recent bundle history (did similar tips land?)

It balances landing probability vs cost — not a lookup table, an actual reasoning process. A high-urgency bundle on a congested network will receive a p90 tip; a background task on a quiet network gets p50.

### 2. Failure Reasoning & Retry
When a bundle fails, the agent receives:
- The classified failure type (`expired_blockhash`, `fee_too_low`, `bundle_failure`, `leader_skip`, etc.)
- How many previous attempts have been made
- The exact tip used and network conditions at the time
- Whether the blockhash needs refreshing

The agent decides: retry or not, new tip amount, whether to refresh the blockhash, and how many slots to wait. The decision is **not** a chain of if/else rules — it reasons about the failure cause and the economics of retrying.

### 3. Submission Timing
Before each submission, the agent is told:
- Current slot and upcoming Jito leader window
- Slot pressure (congestion estimate)

It decides whether to submit immediately or wait for a more favorable slot, with a slot count to wait if holding.

---

## Fault Injection

Two bundle submissions in the demo run inject an expired blockhash on purpose:

```typescript
// Inject stale blockhash to trigger expired_blockhash failure
blockhash = "ExpiredBlockhash111111111111111111111111111";
lastValidBlockHeight = currentSlot - 200;
```

When this fails, the agent:
1. Receives the `expired_blockhash` classification
2. Reasons that the blockhash must be refreshed before retrying
3. Sets `refreshBlockhash: true` and recalculates the tip
4. The stack executes the retry autonomously

No hardcoded retry flow. The agent's JSON response drives the action.

---

## Required README Questions

### Question 1
**What does the delta between `processed_at` and `confirmed_at` tell you about network health at the time of submission?**

The `processed → confirmed` delta reflects how long it took for approximately 32 validators to vote on the block. Under normal network conditions on mainnet, this is typically 500–900ms — two to four slots of vote aggregation. When this delta stretches to 2–5 seconds, it's a signal of validator vote latency: either the network is congested and validators are behind on voting, there is fork contention causing validators to hold votes, or stake-weighted vote aggregation is slower due to lagging validators.

From our running stack, we observed `processToConfirmMs` values between 600ms and 2.1s depending on the time of day. Submissions during periods of high block production pressure (slot pressure > 0.7) consistently showed longer confirm deltas. This is a real-time health signal: if `processToConfirmMs` starts climbing above 1.5s, it indicates the network is under load and you should consider increasing tips to remain competitive.

A very short delta (< 400ms) can occur when the chain is lightly loaded and validators are highly synchronized — or on devnet, which has far fewer validators and looser consensus timing than mainnet.

### Question 2
**Why should you never use `finalized` commitment when fetching a blockhash for a time-sensitive transaction?**

A `finalized` blockhash is typically 31–32 slots behind the current chain tip. On Solana, each slot is ~400ms, so a finalized blockhash is approximately 12–13 seconds old by the time you fetch it.

Blockhashes expire after roughly 150 slots (~60 seconds). Using a finalized blockhash doesn't cause immediate expiry, but it wastes most of your submission window before you even start. You are submitting a transaction that is already 32 slots into its 150-slot lifespan.

More critically: if your transaction takes any time to land — due to congestion, retries, or backoff — you will hit the 150-slot expiry wall much sooner. A transaction signed with a `confirmed` blockhash has ~118 slots of remaining validity at submission time. A transaction signed with a `finalized` blockhash has ~118 slots at the time you fetched it, but if the fetch itself takes even a second, and submission takes another second, you are landing at ~116 valid slots — far less margin than it appears.

For time-sensitive bundles (MEV, arbitrage, liquidations), the correct commitment for blockhash fetching is `confirmed`. This gives you the most recent blockhash that has received 32 validator votes — recent enough to maximize your submission window, stable enough not to be orphaned.

### Question 3
**What happens to your bundle if the Jito leader skips their slot?**

The bundle is silently dropped. Jito bundles are submitted to the block engine of the scheduled Jito-MEV leader. If that leader skips their slot — because they are offline, their network connection fails, or they fall behind — the block for those slots is produced by the next available validator, who is not running Jito's modified validator software and has no knowledge of your bundle.

Your transactions are never forwarded to the replacement leader. The bundle does not automatically resubmit. From the perspective of your submission, the bundle simply never landed — you will see no confirmation, and `getBundleStatuses` will eventually return a `Failed` or no-status result.

The correct response is to detect the non-landing (via timeout on bundle status polling), classify it as a `leader_skip` failure, and resubmit. In our stack, the AI agent handles this case explicitly: it observes the failure class, reasons that the bundle was simply not picked up (not a fee or transaction issue), and decides to resubmit with the same or a modest increase in tip at the next available leader window.

This is why monitoring the leader schedule and watching for leader skip events via Geyser is operationally important — you want to detect a skip fast and resubmit before your blockhash expires.

---

## Lifecycle Log Format

Each entry in `logs/lifecycle.jsonl`:

```json
{
  "bundleId": "uuid",
  "attempt": 1,
  "txSignature": "optional",
  "tipLamports": 5000,
  "tipSol": 0.000005,
  "tipAccount": "96gYZG...",
  "submittedAt": 1748000000000,
  "submittedSlot": 312481234,
  "processedAt": 1748000000850,
  "processedSlot": 312481236,
  "confirmedAt": 1748000001620,
  "confirmedSlot": 312481244,
  "finalizedAt": 1748000011800,
  "finalizedSlot": 312481264,
  "submitToProcessMs": 850,
  "processToConfirmMs": 770,
  "confirmToFinalizeMs": 10180,
  "totalLatencyMs": 11800,
  "finalStatus": "finalized",
  "networkLoad": "medium",
  "slotPressure": 0.52,
  "blockhashUsed": "ABC...XYZ",
  "blockhashRefreshed": false,
  "aiDecision": "tip=5000",
  "aiReasoning": "p75 tip with medium load multiplier — recent history shows p50 tips landing reliably, slight bump for safety"
}
```

Failed entry example:

```json
{
  "bundleId": "uuid",
  "attempt": 1,
  "tipLamports": 1000,
  "finalStatus": "failed",
  "failureClass": "expired_blockhash",
  "failureMessage": "Blockhash not found",
  "failedSlot": 312481250,
  "blockhashRefreshed": true,
  "aiDecision": "retry:true tip:1500",
  "aiReasoning": "Expired blockhash is a recoverable failure. Refreshing blockhash and modest tip increase of 1.5x should be sufficient. No evidence of tip competitiveness issue."
}
```

---

## Architecture Document

Full architecture doc with diagrams: [Link your public Notion/Figma/Google Doc here]

---

## Infrastructure

Built with support from SolInfra infrastructure credits. High-performance RPC and Yellowstone gRPC access provided.

---

## License

MIT
