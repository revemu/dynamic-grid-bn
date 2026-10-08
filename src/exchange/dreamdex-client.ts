/**
 * DreamDEX On-Chain Exchange Adapter for Somnia Network
 * Implements IExchangeClient to allow dynamic-grid to trade directly
 * on DreamDEX SpotPool contracts using privateKey authentication via viem.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Account,
  formatUnits,
  parseUnits,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type {
  IExchangeClient,
  ExchangeSymbolInfo,
  ExchangeTopOfBook,
  ExchangeOrderResult,
  ExchangeOpenOrder,
  ExchangeAccountBalances,
  PlaceOrderParams,
} from "./types.js";
import { SomniaIndexerClient } from "../indexer.js";

export const SPOT_POOL_ABI = [
  {
    type: "function",
    name: "placeOrder",
    stateMutability: "payable",
    inputs: [
      { name: "isBid", type: "bool" },
      { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
      { name: "orderType", type: "uint8" },
      { name: "selfMatchingOption", type: "uint8" },
      { name: "builder", type: "address" },
      { name: "builderFeeBpsTimes1k", type: "uint96" },
    ],
    outputs: [
      { name: "success", type: "bool" },
      { name: "orderId", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "uint128" }],
    outputs: [],
  },
  {
    type: "function",
    name: "getPoolParams",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "baseToken_", type: "address" },
      { name: "quoteToken_", type: "address" },
      { name: "makerFeeBpsTimes1k_", type: "uint256" },
      { name: "takerFeeBpsTimes1k_", type: "uint256" },
      { name: "tickSize_", type: "uint256" },
      { name: "minQuantity_", type: "uint256" },
      { name: "lotSize_", type: "uint256" },
    ],
  },
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "remaining", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

export interface DreamDexMarketMeta {
  symbol: string;
  pool: `0x${string}`;
  baseAsset: string;
  quoteAsset: string;
  baseDecimals: number;
  quoteDecimals: number;
  baseIsNative: boolean;
  minQty: number;
  stepSize: number;
  tickSize: number;
  baseToken?: `0x${string}`;
  quoteToken?: `0x${string}`;
}

export const DREAMDEX_MARKETS: Record<string, DreamDexMarketMeta> = {
  "SOMI:USDSO": {
    symbol: "SOMI:USDSO",
    pool: "0x035De7403eac6872787779CCA7CCF1b4CDb61379",
    baseAsset: "SOMI",
    quoteAsset: "USDSO",
    baseDecimals: 18,
    quoteDecimals: 18,
    baseIsNative: true,
    minQty: 1.0,
    stepSize: 1.0,
    tickSize: 0.0001,
    baseToken: "0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00",
    quoteToken: "0x00000022dA000002656c64D9eA6011ea952D008A",
  },
  "USDC.E:USDSO": {
    symbol: "USDC.E:USDSO",
    pool: "0x47fD2f18426f67106DBaC82F6d21D446c5F2120b",
    baseAsset: "USDC.e",
    quoteAsset: "USDSO",
    baseDecimals: 6,
    quoteDecimals: 18,
    baseIsNative: false,
    minQty: 1.0,
    stepSize: 0.01,
    tickSize: 0.0001,
    baseToken: "0x28BEc7E30E6faee657a03e19Bf1128AaD7632A00",
    quoteToken: "0x00000022dA000002656c64D9eA6011ea952D008A",
  },
  "WBTC:USDSO": {
    symbol: "WBTC:USDSO",
    pool: "0x25bfF6B7B5E2243424F38E75de7ab03C0522a5EA",
    baseAsset: "WBTC",
    quoteAsset: "USDSO",
    baseDecimals: 8,
    quoteDecimals: 18,
    baseIsNative: false,
    minQty: 0.0001,
    stepSize: 0.0001,
    tickSize: 0.01,
    baseToken: "0xC5098b3cA516784323872F17235fa074E167D3D2",
    quoteToken: "0x00000022dA000002656c64D9eA6011ea952D008A",
  },
  "WETH:USDSO": {
    symbol: "WETH:USDSO",
    pool: "0xa936da11B57b50A344e1293AAaE5232885ea2bDE",
    baseAsset: "WETH",
    quoteAsset: "USDSO",
    baseDecimals: 18,
    quoteDecimals: 18,
    baseIsNative: false,
    minQty: 0.001,
    stepSize: 0.0001,
    tickSize: 0.01,
    baseToken: "0x936Ab8C674bcb567CD5dEB85D8A216494704E9D8",
    quoteToken: "0x00000022dA000002656c64D9eA6011ea952D008A",
  },
};

export interface DreamDexClientOptions {
  privateKey?: string;
  rpcUrl?: string;
  chainId?: number;
  indexerUrl?: string;
  log?: (msg: string) => void;
}

export class DreamDexClient implements IExchangeClient {
  public readonly exchangeName = "dreamdex";
  private privateKey?: `0x${string}`;
  private rpcUrl: string;
  private chainId: number;
  private account?: Account;
  private publicClient: any;
  private walletClient?: any;
  private indexer: SomniaIndexerClient;
  private log: (msg: string) => void;

  constructor(opts: DreamDexClientOptions = {}) {
    this.rpcUrl = opts.rpcUrl || "https://api.infra.mainnet.somnia.network";
    this.chainId = opts.chainId || 5031;
    this.log = opts.log ?? ((msg: string) => console.log(`[dreamdex-client] ${msg}`));
    this.indexer = new SomniaIndexerClient({
      indexerUrl: opts.indexerUrl || "https://prd.smk.somnia.host/v1/graphql",
      log: this.log,
    });

    this.publicClient = createPublicClient({
      transport: http(this.rpcUrl),
    });

    if (opts.privateKey) {
      this.setPrivateKey(opts.privateKey);
    }
  }

  public setPrivateKey(key: string): void {
    const cleanKey = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    if (cleanKey.length === 66) {
      this.privateKey = cleanKey;
      this.account = privateKeyToAccount(cleanKey);
      this.walletClient = createWalletClient({
        account: this.account,
        transport: http(this.rpcUrl),
      });
      this.log(`🔑 Initialized DreamDEX wallet: ${this.account.address}`);
    }
  }

  public updateCredentials(apiKey: string, _apiSecret?: string, rpcUrl?: string): void {
    if (apiKey) {
      this.setPrivateKey(apiKey);
    }
    if (rpcUrl) {
      this.rpcUrl = rpcUrl;
      this.publicClient = createPublicClient({
        transport: http(this.rpcUrl),
      });
    }
  }

  public hasCredentials(): boolean {
    return Boolean(this.account && this.walletClient);
  }

  public async syncTime(): Promise<number> {
    return 0;
  }

  private resolveMarket(symbol: string): DreamDexMarketMeta {
    const cleanSym = symbol.toUpperCase().replace(/[\/\-_]/g, ":");
    if (DREAMDEX_MARKETS[cleanSym]) return DREAMDEX_MARKETS[cleanSym]!;
    if (cleanSym.startsWith("SOMI")) return DREAMDEX_MARKETS["SOMI:USDSO"]!;
    if (cleanSym.startsWith("USDC")) return DREAMDEX_MARKETS["USDC.E:USDSO"]!;
    if (cleanSym.startsWith("WBTC") || cleanSym.startsWith("BTC")) return DREAMDEX_MARKETS["WBTC:USDSO"]!;
    if (cleanSym.startsWith("WETH") || cleanSym.startsWith("ETH")) return DREAMDEX_MARKETS["WETH:USDSO"]!;
    return DREAMDEX_MARKETS["SOMI:USDSO"]!;
  }

  public async getExchangeInfo(symbol: string): Promise<ExchangeSymbolInfo> {
    const market = this.resolveMarket(symbol);
    return {
      symbol: market.symbol,
      status: "TRADING",
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      baseAssetPrecision: market.baseDecimals,
      quotePrecision: market.quoteDecimals,
      minQty: market.minQty,
      maxQty: 1000000,
      stepSize: market.stepSize,
      qtyPrecision: 4,
      minPrice: market.tickSize,
      maxPrice: 1000000,
      tickSize: market.tickSize,
      pricePrecision: 6,
      minNotional: 0.1,
    };
  }

  public async getAccountBalances(symbol: string): Promise<ExchangeAccountBalances> {
    const market = this.resolveMarket(symbol);
    if (!this.account) {
      return {
        baseAsset: market.baseAsset,
        quoteAsset: market.quoteAsset,
        baseFree: 0,
        baseLocked: 0,
        baseTotal: 0,
        quoteFree: 0,
        quoteLocked: 0,
        quoteTotal: 0,
        allBalances: {},
      };
    }

    let baseBal = 0;
    try {
      if (market.baseIsNative) {
        const balRaw = await this.publicClient.getBalance({ address: this.account.address });
        baseBal = Number(formatUnits(balRaw, market.baseDecimals));
      } else if (market.baseToken) {
        const balRaw = await this.publicClient.readContract({
          address: market.baseToken,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [this.account.address],
        });
        baseBal = Number(formatUnits(balRaw as bigint, market.baseDecimals));
      }
    } catch (err) {
      this.log(`⚠️ Failed to read ${market.baseAsset} balance: ${(err as Error).message}`);
    }

    let quoteBal = 0;
    try {
      if (market.quoteToken) {
        const balRaw = await this.publicClient.readContract({
          address: market.quoteToken,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [this.account.address],
        });
        quoteBal = Number(formatUnits(balRaw as bigint, market.quoteDecimals));
      }
    } catch (err) {
      this.log(`⚠️ Failed to read ${market.quoteAsset} balance: ${(err as Error).message}`);
    }

    return {
      baseAsset: market.baseAsset,
      quoteAsset: market.quoteAsset,
      baseFree: baseBal,
      baseLocked: 0,
      baseTotal: baseBal,
      quoteFree: quoteBal,
      quoteLocked: 0,
      quoteTotal: quoteBal,
      allBalances: {
        [market.baseAsset]: { free: baseBal, locked: 0 },
        [market.quoteAsset]: { free: quoteBal, locked: 0 },
      },
    };
  }

  public async getOpenOrders(symbol: string): Promise<ExchangeOpenOrder[]> {
    if (!this.account) return [];
    const market = this.resolveMarket(symbol);
    const indexed = await this.indexer.getOpenOrders(this.account.address, market.pool);
    return indexed.map((o) => ({
      symbol: market.symbol,
      orderId: o.orderId,
      clientOrderId: o.id,
      price: o.price,
      origQty: o.fullQuantity,
      executedQty: o.filledQuantity,
      cummulativeQuoteQty: o.filledQuantity * o.price,
      status: o.status.toUpperCase(),
      timeInForce: "GTC",
      type: "LIMIT",
      side: o.isBid ? "BUY" : "SELL",
      time: o.placedAtTimestamp ? o.placedAtTimestamp * 1000 : Date.now(),
      updateTime: Date.now(),
      isWorking: o.status === "Open",
    }));
  }

  public async getOrder(symbol: string, orderId: string | number): Promise<ExchangeOpenOrder> {
    const market = this.resolveMarket(symbol);
    const idStr = String(orderId);
    const map = await this.indexer.getOrdersByIds(market.pool, [idStr]);
    const o = map.get(idStr);
    if (!o) {
      throw new Error(`Order ${idStr} not found on DreamDEX indexer`);
    }
    return {
      symbol: market.symbol,
      orderId: o.orderId,
      clientOrderId: o.id,
      price: o.price,
      origQty: o.fullQuantity,
      executedQty: o.filledQuantity,
      cummulativeQuoteQty: o.filledQuantity * o.price,
      status: o.status.toUpperCase(),
      timeInForce: "GTC",
      type: "LIMIT",
      side: o.isBid ? "BUY" : "SELL",
      time: o.placedAtTimestamp ? o.placedAtTimestamp * 1000 : Date.now(),
      updateTime: Date.now(),
      isWorking: o.status === "Open",
    };
  }

  public async getTopOfBook(symbol: string): Promise<ExchangeTopOfBook | undefined> {
    const market = this.resolveMarket(symbol);
    return {
      bestBid: 0,
      bestAsk: 0,
      mid: 0,
      bidQty: 0,
      askQty: 0,
      time: Date.now(),
    };
  }

  private async ensureAllowance(token: `0x${string}`, spender: `0x${string}`, amount: bigint): Promise<void> {
    if (!this.account || !this.walletClient) return;
    try {
      const current = await this.publicClient.readContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [this.account.address, spender],
      });
      if ((current as bigint) >= amount) return;
      this.log(`🔐 Approving token for pool ${spender.slice(0, 8)}...`);
      const hash = await this.walletClient.writeContract({
        address: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, amount * 100n],
        chain: {
          id: this.chainId,
          name: "Somnia",
          nativeCurrency: { name: "Somnia", symbol: "SOMI", decimals: 18 },
          rpcUrls: { default: { http: [this.rpcUrl] } },
        },
        account: this.account,
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
      this.log(`✅ Token approval confirmed: ${hash.slice(0, 10)}...`);
    } catch (err) {
      this.log(`⚠️ Token approval warning: ${(err as Error).message}`);
    }
  }

  public async placeOrder(params: PlaceOrderParams): Promise<ExchangeOrderResult> {
    if (!this.account || !this.walletClient) {
      throw new Error("Cannot place order on DreamDEX: Private key not configured");
    }

    const market = this.resolveMarket(params.symbol);
    const isBid = params.side === "BUY";
    const price = params.price || 0;
    const qty = params.qty;
    const priceRaw = parseUnits(price.toFixed(6), market.quoteDecimals);
    const qtyRaw = parseUnits(qty.toFixed(4), market.baseDecimals);

    // Ensure ERC-20 token allowance before placing order
    if (isBid && market.quoteToken) {
      const requiredQuoteRaw = (priceRaw * qtyRaw) / parseUnits("1", market.baseDecimals);
      await this.ensureAllowance(market.quoteToken, market.pool, requiredQuoteRaw);
    } else if (!isBid && !market.baseIsNative && market.baseToken) {
      await this.ensureAllowance(market.baseToken, market.pool, qtyRaw);
    }

    // orderType: 0 = Limit (Maker/Resting), 1 = IOC (ImmediateOrCancel)
    const orderType = params.type === "IOC" ? 1 : 0;
    const expireTimestampNs = BigInt(Date.now() + 24 * 3600 * 1000) * 1_000_000n;

    let value = 0n;
    if (isBid && market.baseIsNative) {
      value = 0n;
    } else if (!isBid && market.baseIsNative) {
      value = qtyRaw;
    }

    const hash = await this.walletClient.writeContract({
      address: market.pool,
      abi: SPOT_POOL_ABI,
      functionName: "placeOrder",
      args: [
        isBid,
        0n, // userData
        priceRaw,
        qtyRaw,
        expireTimestampNs,
        orderType,
        0, // selfMatchingOption
        zeroAddress,
        0n, // builderFee
      ],
      value,
      chain: {
        id: this.chainId,
        name: "Somnia",
        nativeCurrency: { name: "Somnia", symbol: "SOMI", decimals: 18 },
        rpcUrls: { default: { http: [this.rpcUrl] } },
      },
      account: this.account,
    });

    return {
      symbol: market.symbol,
      orderId: hash,
      clientOrderId: params.clientOrderId || hash,
      transactTime: Date.now(),
      price,
      origQty: qty,
      executedQty: 0,
      cummulativeQuoteQty: 0,
      status: "NEW",
      timeInForce: "GTC",
      type: params.type,
      side: params.side,
      txHash: hash,
    };
  }

  public async cancelOrder(symbol: string, orderId: string | number): Promise<any> {
    if (!this.account || !this.walletClient) {
      throw new Error("Cannot cancel order on DreamDEX: Private key not configured");
    }
    const market = this.resolveMarket(symbol);
    const idBigInt = BigInt(String(orderId).replace(/\D/g, "") || "0");

    const hash = await this.walletClient.writeContract({
      address: market.pool,
      abi: SPOT_POOL_ABI,
      functionName: "cancelOrder",
      args: [idBigInt],
      chain: {
        id: this.chainId,
        name: "Somnia",
        nativeCurrency: { name: "Somnia", symbol: "SOMI", decimals: 18 },
        rpcUrls: { default: { http: [this.rpcUrl] } },
      },
      account: this.account,
    });
    return hash;
  }

  public async cancelAllOpenOrders(symbol: string): Promise<any> {
    const open = await this.getOpenOrders(symbol);
    const results = [];
    for (const o of open) {
      try {
        const h = await this.cancelOrder(symbol, o.orderId);
        results.push(h);
      } catch (err) {
        this.log(`⚠️ Cancel order #${o.orderId} failed: ${(err as Error).message}`);
      }
    }
    return results;
  }
}
