/**
 * Shared TTL caches for verification hot paths (plan P1). Everything the
 * caches hold is public or non-secret material (published JWKs, resource
 * identifiers), so keeping them in-process is safe; a class change is seen by
 * every instance within the configured TTL (locked decision, no pub/sub in
 * phase 1).
 *
 * Fetches are deduplicated: concurrent getters share one flight, so a burst
 * cannot stampede the database. `forceRefresh` bypasses the TTL for the
 * unknown-`kid` retry and is itself capped by a cooldown so invalid-token
 * traffic cannot turn the cache into a query pump.
 */
export class VerificationCache<T> {
  private entry: {
    value: T;
    fetchedAt: number;
    freshUntil: number;
    generation: number;
  } | null = null;
  private inflight: Promise<T> | null = null;
  private generation = 0;
  private lastForcedAt = 0;

  constructor(
    readonly name: string,
    private readonly ttlMs: number,
    private readonly fetch: () => Promise<T>,
    private readonly refetchCooldownMs = 30_000,
  ) {}

  async get(): Promise<T> {
    const now = Date.now();
    if (
      this.entry &&
      this.entry.generation === this.generation &&
      now < this.entry.freshUntil
    ) {
      return this.entry.value;
    }
    // The generation is captured when the fetch starts: a flight that raced
    // an invalidation stays stale even though it lands afterwards.
    const generation = this.generation;
    this.inflight ??= this.fetch().then(
      (value) => {
        this.entry = {
          value,
          fetchedAt: Date.now(),
          // A zero TTL disables caching: the entry never counts as fresh.
          freshUntil: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0,
          generation,
        };
        this.inflight = null;
        return value;
      },
      (err: unknown) => {
        this.inflight = null;
        throw err;
      },
    );
    return this.inflight;
  }

  /** Drop the entry; the next `get` refetches from the source. */
  invalidate(): void {
    this.generation += 1;
  }

  /** Test seam: the cooldown is module-wide state shared across test cases. */
  resetRefetchCooldownForTests(): void {
    this.lastForcedAt = 0;
  }

  /**
   * Fetch past the TTL — storing the fresh result — at most once per cooldown
   * window. Used by the unknown-`kid` retry: without the cooldown,
   * invalid-token traffic could force a refetch per failure.
   */
  async forceRefresh(): Promise<T> {
    const now = Date.now();
    if (this.lastForcedAt + this.refetchCooldownMs > now) {
      throw new Error(
        `[verification-cache] ${this.name}: refetch is cooldown-bound`,
      );
    }
    this.lastForcedAt = now;
    const value = await this.fetch();
    this.entry = {
      value,
      fetchedAt: Date.now(),
      freshUntil: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0,
      generation: this.generation,
    };
    return value;
  }
}

export const REFETCH_COOLDOWN_MS = 30_000;
