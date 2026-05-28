import { EventEmitter } from "events";

export interface SlotInfo {
  slot: number;
  parent: number;
  status: "processed" | "confirmed" | "finalized";
  timestamp: number;
}

export interface LeaderWindow {
  leader: string;
  startSlot: number;
  endSlot: number;
}

/**
 * GeyserStreamManager
 *
 * Connects to a Yellowstone gRPC stream (or compatible Geyser provider)
 * and emits real-time slot + leader schedule events.
 *
 * In production: uses @triton-one/yellowstone-grpc client.
 * The stream handles backpressure via gRPC flow control.
 * Reconnects automatically with exponential backoff on disconnect.
 */
export class GeyserStreamManager extends EventEmitter {
  private endpoint: string;
  private token: string;
  private currentSlot: number = 0;
  private reconnectAttempts: number = 0;
  private maxReconnectDelay: number = 30000;
  private streamActive: boolean = false;
  private slotPoller: NodeJS.Timeout | null = null;

  // For demo purposes: simulated leader schedule
  // In production, derive from getLeaderSchedule() RPC call
  private leaderSchedule: Map<number, string> = new Map();

  constructor(endpoint: string, token: string) {
    super();
    this.endpoint = endpoint;
    this.token = token;
  }

  async connect(): Promise<void> {
    console.log(`[Geyser] Connecting to ${this.endpoint}`);

    // Production: initialize Yellowstone gRPC client
    // const client = new Client(this.endpoint, this.token, { "grpc.max_receive_message_length": -1 });
    // const stream = await client.subscribe();
    // stream.on("data", this.handleGeyserUpdate.bind(this));
    // stream.on("error", this.handleStreamError.bind(this));
    // stream.on("end", this.handleStreamEnd.bind(this));
    //
    // Subscribe to slots + blocks:
    // await stream.write({ slots: { "client": { filterByCommitment: true } }, commitment: CommitmentLevel.PROCESSED });

    // For demo: poll slot via standard RPC with simulated Geyser semantics
    this.streamActive = true;
    this.startSlotPolling();
    console.log(`[Geyser] Stream active (simulated via RPC polling for demo)`);
  }

  private startSlotPolling(): void {
    // Poll at ~400ms to approximate Geyser slot frequency (~2 slots/sec on Solana)
    this.slotPoller = setInterval(async () => {
      try {
        const response = await fetch(
          `https://api.devnet.solana.com`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "getSlot",
              params: [{ commitment: "processed" }],
            }),
          }
        );
        const data = await response.json();
        const slot: number = data.result;

        if (slot > this.currentSlot) {
          for (let s = this.currentSlot + 1; s <= slot; s++) {
            const slotInfo: SlotInfo = {
              slot: s,
              parent: s - 1,
              status: "processed",
              timestamp: Date.now(),
            };
            this.currentSlot = s;
            this.emit("slot", slotInfo);
          }
        }
      } catch (err) {
        this.handleStreamError(err as Error);
      }
    }, 400);
  }

  private handleStreamError(err: Error): void {
    console.error(`[Geyser] Stream error: ${err.message}`);
    this.reconnectWithBackoff();
  }

  private handleStreamEnd(): void {
    console.warn(`[Geyser] Stream ended unexpectedly`);
    this.reconnectWithBackoff();
  }

  private async reconnectWithBackoff(): Promise<void> {
    if (!this.streamActive) return;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;
    console.log(`[Geyser] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
    await new Promise((r) => setTimeout(r, delay));
    await this.connect();
  }

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  async waitForSlot(targetSlot: number, timeoutMs: number = 30000): Promise<boolean> {
    if (this.currentSlot >= targetSlot) return true;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.removeListener("slot", handler);
        resolve(false);
      }, timeoutMs);

      const handler = (info: SlotInfo) => {
        if (info.slot >= targetSlot) {
          clearTimeout(timeout);
          this.removeListener("slot", handler);
          resolve(true);
        }
      };
      this.on("slot", handler);
    });
  }

  /**
   * Determine if we are within the leader window for a given validator.
   * In production: fetch from getLeaderSchedule() and cross-reference current slot.
   * Each leader gets 4 consecutive slots per rotation.
   */
  async getUpcomingLeaderWindow(slotsAhead: number = 20): Promise<LeaderWindow | null> {
    // Production: fetch real leader schedule from RPC
    // const schedule = await connection.getLeaderSchedule(this.currentSlot);
    // Then find the next 4-slot window assigned to a Jito-enabled validator

    // Simplified: return a synthetic window for demonstration
    const startSlot = this.currentSlot + Math.floor(Math.random() * 8) + 2;
    return {
      leader: "JitoLeader" + startSlot.toString().slice(-4),
      startSlot,
      endSlot: startSlot + 3,
    };
  }

  disconnect(): void {
    this.streamActive = false;
    if (this.slotPoller) {
      clearInterval(this.slotPoller);
      this.slotPoller = null;
    }
  }
}
