export interface PageEnvelope<T> {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
}

/**
 * One page of a list. `for await (const item of page)` walks this page and every
 * following one; `items` is just this page; `toArray()` fetches everything.
 */
export class Page<T, TOriginal = T> implements AsyncIterable<T> {
  readonly items: T[];
  readonly total: number;
  readonly page: number;
  readonly size: number;
  readonly pages: number;

  constructor(
    envelope: PageEnvelope<TOriginal>,
    transform: (raw: TOriginal) => T,
    private readonly fetchPage: ((page: number) => Promise<Page<T, TOriginal>>) | null,
  ) {
    this.items = envelope.items.map(transform);
    this.total = envelope.total;
    this.page = envelope.page;
    this.size = envelope.size;
    this.pages = envelope.pages;
  }

  /** Items on this page. */
  get length(): number {
    return this.items.length;
  }

  get(index: number): T | undefined {
    return this.items[index];
  }

  get hasNextPage(): boolean {
    return this.fetchPage !== null && this.page < this.pages;
  }

  /** The following page, or null on the last one. */
  async getNextPage(): Promise<Page<T, TOriginal> | null> {
    if (!this.hasNextPage) return null;
    return this.fetchPage!(this.page + 1);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let current: Page<T, TOriginal> | null = this;
    while (current) {
      yield* current.items;
      current = await current.getNextPage();
    }
  }

  /** Every item from this page onwards. */
  async toArray(): Promise<T[]> {
    const out: T[] = [];
    for await (const item of this) out.push(item);
    return out;
  }
}
