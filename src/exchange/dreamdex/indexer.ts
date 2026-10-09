/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export interface IndexedOrder {
  /** Composite indexer ID: `${poolAddress}_${orderId}` */
  id: string;
  /** Raw uint128 on-chain order ID string */
  orderId: string;
  /** Pool address (market ID) */
  marketId: string;
  /** Owner wallet address */
  owner: string;
  /** true = BUY / BID, false = SELL / ASK */
  isBid: boolean;
  /** Human price (e.g. 0.2122 USDso) */
  price: number;
  /** Raw price string */
  rawPrice: string;
  /** Remaining unfilled quantity (e.g. SOMI) */
  quantityRemaining: number;
  /** Initial full quantity */
  fullQuantity: number;
  /** Cumulative filled quantity */
  filledQuantity: number;
  /** Order lifecycle status: "Open" | "Filled" | "Cancelled" | "Expired" */
  status: "Open" | "Filled" | "Cancelled" | "Expired" | string;
  /** Whether the order rested on the CLOB book (true = Maker limit) or executed immediately (false = Taker IOC) */
  rested?: boolean;
  /** Indexer cancellation or failure reason if available */
  cancelReason?: string;
  /** Tx hash where the order was placed */
  placedTxHash?: string;
  /** Unix timestamp in seconds when placed */
  placedAtTimestamp?: number;
  /** Expiration timestamp in nanoseconds */
  expireTimestampNs?: string;
}

export interface IndexerClientOptions {
  indexerUrl?: string;
  baseDecimals?: number;
  quoteDecimals?: number;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

export class SomniaIndexerClient {
  readonly indexerUrl: string;
  private readonly baseDecimals: number;
  private readonly quoteDecimals: number;
  private readonly timeoutMs: number;
  private readonly log?: (msg: string) => void;

  constructor(opts: IndexerClientOptions = {}) {
    // Default to the user's specified production indexer endpoint: https://prd.smk.somnia.host/v1/graphql
    this.indexerUrl = opts.indexerUrl || process.env.INDEXER_URL || "https://prd.smk.somnia.host/v1/graphql";
    this.baseDecimals = opts.baseDecimals ?? 18;
    this.quoteDecimals = opts.quoteDecimals ?? 18;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.log = opts.log;
  }

  private parseRawUnits(raw: string | undefined, decimals: number): number {
    if (!raw) return 0;
    try {
      const bi = BigInt(raw);
      const factor = 10n ** BigInt(decimals);
      const whole = Number(bi / factor);
      const frac = Number(bi % factor) / Number(factor);
      return whole + frac;
    } catch {
      return Number(raw) / 10 ** decimals;
    }
  }

  private mapOrder(o: any): IndexedOrder {
    const price = this.parseRawUnits(o.price, this.quoteDecimals);
    const quantityRemaining = this.parseRawUnits(o.quantityRemaining, this.baseDecimals);
    const fullQuantity = this.parseRawUnits(o.fullQuantity, this.baseDecimals);
    const filledQuantity = this.parseRawUnits(o.filledQuantity, this.baseDecimals);

    return {
      id: o.id,
      orderId: o.orderId,
      marketId: o.market_id || (o.id ? o.id.split("_")[0] : ""),
      owner: (o.owner || "").toLowerCase(),
      isBid: Boolean(o.isBid),
      price,
      rawPrice: o.price,
      quantityRemaining,
      fullQuantity,
      filledQuantity,
      status: o.status,
      rested: o.rested !== undefined ? Boolean(o.rested) : undefined,
      cancelReason: o.cancelReason || undefined,
      placedTxHash: o.placedTxHash || undefined,
      placedAtTimestamp: o.placedAtTimestamp ? Number(o.placedAtTimestamp) : undefined,
      expireTimestampNs: o.expireTimestampNs || undefined,
    };
  }

  private async fetchGql<T = any>(query: string, variables: Record<string, any> = {}): Promise<T | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.indexerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`GraphQL HTTP ${res.status}: ${res.statusText}`);
      }
      const json = (await res.json()) as any;
      if (json.errors && json.errors.length > 0) {
        throw new Error(`GraphQL query error: ${json.errors[0]?.message || "unknown"}`);
      }
      return json.data as T;
    } catch (err) {
      this.log?.(`⚠️ [Indexer] request failed: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Health check ping to verify indexer responsiveness
   */
  async isHealthy(): Promise<boolean> {
    const query = `
      query HealthCheck {
        Order(limit: 1) {
          id
        }
      }
    `;
    const res = await this.fetchGql(query);
    return res != null;
  }

  /**
   * Fetch a single order by poolAddress and orderId
   */
  async getOrderById(poolAddress: string, orderId: string): Promise<IndexedOrder | null> {
    const compositeId = `${poolAddress.toLowerCase()}_${orderId}`;
    const query = `
      query GetOrderById($id: String!) {
        Order_by_pk(id: $id) {
          id
          orderId
          market_id
          owner
          isBid
          price
          quantityRemaining
          fullQuantity
          filledQuantity
          status
          rested
          cancelReason
          placedTxHash
          placedAtTimestamp
          expireTimestampNs
        }
      }
    `;
    const data = await this.fetchGql<{ Order_by_pk: any }>(query, { id: compositeId });
    if (!data?.Order_by_pk) return null;
    return this.mapOrder(data.Order_by_pk);
  }

  /**
   * Batch fetch multiple orders by their on-chain order IDs
   * Returns a Map where key is orderId string
   */
  async getOrdersByIds(poolAddress: string, orderIds: string[]): Promise<Map<string, IndexedOrder>> {
    const map = new Map<string, IndexedOrder>();
    if (!orderIds || orderIds.length === 0) return map;

    const lowerPool = poolAddress.toLowerCase();
    const compositeIds = orderIds.map((id) => `${lowerPool}_${id}`);

    const query = `
      query GetOrdersByIds($ids: [String!]!) {
        Order(where: { id: { _in: $ids } }) {
          id
          orderId
          market_id
          owner
          isBid
          price
          quantityRemaining
          fullQuantity
          filledQuantity
          status
          rested
          cancelReason
          placedTxHash
          placedAtTimestamp
          expireTimestampNs
        }
      }
    `;

    const data = await this.fetchGql<{ Order: any[] }>(query, { ids: compositeIds });
    if (data?.Order) {
      for (const row of data.Order) {
        const order = this.mapOrder(row);
        map.set(order.orderId, order);
      }
    }
    return map;
  }

  /**
   * Query all resting Open orders for an owner, optionally scoped to a pool
   */
  async getOpenOrders(owner: string, poolAddress?: string): Promise<IndexedOrder[]> {
    const where: Record<string, any> = {
      owner: { _eq: owner.toLowerCase() },
      status: { _eq: "Open" },
    };
    if (poolAddress) {
      where.market_id = { _eq: poolAddress.toLowerCase() };
    }

    const query = `
      query GetOpenOrders($where: Order_bool_exp!) {
        Order(where: $where, order_by: { placedAtTimestamp: desc }, limit: 100) {
          id
          orderId
          market_id
          owner
          isBid
          price
          quantityRemaining
          fullQuantity
          filledQuantity
          status
          rested
          cancelReason
          placedTxHash
          placedAtTimestamp
          expireTimestampNs
        }
      }
    `;

    const data = await this.fetchGql<{ Order: any[] }>(query, { where });
    if (!data?.Order) return [];
    return data.Order.map((row) => this.mapOrder(row));
  }

  /**
   * Query recent orders for an owner (any status: Open, Filled, Cancelled)
   */
  async getRecentOrders(owner: string, poolAddress?: string, limit = 50): Promise<IndexedOrder[]> {
    const where: Record<string, any> = {
      owner: { _eq: owner.toLowerCase() },
    };
    if (poolAddress) {
      where.market_id = { _eq: poolAddress.toLowerCase() };
    }

    const query = `
      query GetRecentOrders($where: Order_bool_exp!, $limit: Int!) {
        Order(where: $where, order_by: { placedAtTimestamp: desc }, limit: $limit) {
          id
          orderId
          market_id
          owner
          isBid
          price
          quantityRemaining
          fullQuantity
          filledQuantity
          status
          rested
          cancelReason
          placedTxHash
          placedAtTimestamp
          expireTimestampNs
        }
      }
    `;

    const data = await this.fetchGql<{ Order: any[] }>(query, { where, limit });
    if (!data?.Order) return [];
    return data.Order.map((row) => this.mapOrder(row));
  }

  /**
   * Query top of book (best bid, best ask, mid price) for a pool from open orders
   */
  async getTopOfBook(
    poolAddress: string
  ): Promise<{ bestBid: number; bestAsk: number; mid: number; bidQty: number; askQty: number } | null> {
    const marketId = poolAddress.toLowerCase();
    const query = `
      query GetTopOfBook($marketId: String!) {
        bids: Order(
          where: { market_id: { _eq: $marketId }, status: { _eq: "Open" }, isBid: { _eq: true } }
          limit: 100
        ) {
          price
          quantityRemaining
        }
        asks: Order(
          where: { market_id: { _eq: $marketId }, status: { _eq: "Open" }, isBid: { _eq: false } }
          limit: 100
        ) {
          price
          quantityRemaining
        }
      }
    `;

    const data = await this.fetchGql<{ bids: any[]; asks: any[] }>(query, { marketId });
    if (!data) return null;

    let bestBid = 0;
    let bidQty = 0;
    if (data.bids && data.bids.length > 0) {
      for (const b of data.bids) {
        const p = this.parseRawUnits(b.price, this.quoteDecimals);
        const q = this.parseRawUnits(b.quantityRemaining, this.baseDecimals);
        if (p > bestBid) {
          bestBid = p;
          bidQty = q;
        }
      }
    }

    let bestAsk = 0;
    let askQty = 0;
    if (data.asks && data.asks.length > 0) {
      for (const a of data.asks) {
        const p = this.parseRawUnits(a.price, this.quoteDecimals);
        const q = this.parseRawUnits(a.quantityRemaining, this.baseDecimals);
        if (bestAsk === 0 || p < bestAsk) {
          bestAsk = p;
          askQty = q;
        }
      }
    }

    let mid = 0;
    if (bestBid > 0 && bestAsk > 0) {
      mid = (bestBid + bestAsk) / 2;
    } else if (bestBid > 0) {
      mid = bestBid;
    } else if (bestAsk > 0) {
      mid = bestAsk;
    }

    return { bestBid, bestAsk, mid, bidQty, askQty };
  }
}
