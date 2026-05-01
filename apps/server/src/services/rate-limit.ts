export class RateLimitError extends Error {
  constructor(message = "Rate limited") {
    super(message);
    this.name = "RateLimitError";
  }
}

export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

function isRateLimit(error: unknown): boolean {
  if (error instanceof RateLimitError) return true;
  if (typeof error === "object" && error !== null && "status" in error) return (error as { status?: number }).status === 429;
  return error instanceof Error && /429|rate.?limit|quota|resource_exhausted/i.test(error.message);
}

function retryDelayMs(error: unknown, fallbackMs: number): number {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  const retryIn = /retry in ([0-9.]+)s/i.exec(message);
  if (retryIn?.[1]) return Math.ceil(Number(retryIn[1]) * 1000);
  const tryAgain = /try again in ([0-9.]+)s/i.exec(message);
  if (tryAgain?.[1]) return Math.ceil(Number(tryAgain[1]) * 1000);
  const retryDelay = /"retryDelay":"([0-9.]+)s"/i.exec(message);
  if (retryDelay?.[1]) return Math.ceil(Number(retryDelay[1]) * 1000);
  return fallbackMs;
}

export async function withRateLimitBackoff<T>(task: () => Promise<T>, maxRetries = 4): Promise<T> {
  let delayMs = 700;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!isRateLimit(error) || attempt === maxRetries) throw error;
      await Bun.sleep(retryDelayMs(error, delayMs));
      delayMs *= 2;
    }
  }
  throw new Error("unreachable");
}
