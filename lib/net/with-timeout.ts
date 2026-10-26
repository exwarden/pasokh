/**
 * Gives an optional Redis step a deadline. The shared connection queues
 * commands while Redis is unreachable and never gives up, so without this a
 * redirect or a rejected webhook would wait for ever for a counter it can do without.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
