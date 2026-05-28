import { TransactionStack } from "./bundle/TransactionStack";
import { GeyserStreamManager } from "./stream/GeyserStreamManager";
import { LifecycleLogger } from "./lifecycle/LifecycleLogger";
import { AIAgent } from "./agent/AIAgent";
import { TipCalculator } from "./bundle/TipCalculator";
import { config } from "./utils/config";

async function main() {
  console.log("🚀 Solana Smart Transaction Stack starting...");

  const logger = new LifecycleLogger("./logs/lifecycle.jsonl");
  const streamManager = new GeyserStreamManager(config.geyserEndpoint, config.geyserToken);
  const tipCalculator = new TipCalculator();
  const aiAgent = new AIAgent(config.anthropicApiKey);

  const stack = new TransactionStack({
    rpcEndpoint: config.rpcEndpoint,
    jitoEndpoint: config.jitoEndpoint,
    streamManager,
    logger,
    tipCalculator,
    aiAgent,
  });

  // Start Geyser stream
  await streamManager.connect();
  console.log("✅ Geyser stream connected");

  // Run 10+ bundle submissions (including fault injection)
  await stack.runDemonstration();

  console.log("✅ Demonstration complete. Logs written to ./logs/lifecycle.jsonl");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
