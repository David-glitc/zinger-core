/**
 * Shared Core domain types (paper/live Polymarket bot).
 * Kept intentionally small — expand as modules are tightened.
 */

export type TradeMode = 'paper' | 'live';

export type AssetSymbol = 'BTC' | 'ETH' | string;

export type Side = 'UP' | 'DOWN' | 'YES' | 'NO' | string;

export interface PolyTrade {
  id?: string;
  mode?: TradeMode;
  asset?: AssetSymbol;
  side?: Side;
  entryPrice?: number;
  exitPrice?: number;
  sizeUsd?: number;
  pnl?: number;
  status?: string;
  openedAt?: string;
  closedAt?: string;
  [key: string]: unknown;
}

export interface PolyPosition {
  id?: string;
  mode?: TradeMode;
  asset?: AssetSymbol;
  side?: Side;
  entryPrice?: number;
  sizeUsd?: number;
  tokenId?: string;
  conditionId?: string;
  [key: string]: unknown;
}

export interface PolyBotState {
  running?: boolean;
  mode?: TradeMode;
  trades?: PolyTrade[];
  positions?: PolyPosition[];
  config?: Record<string, unknown>;
  readiness?: Record<string, unknown>;
  edgeGate?: Record<string, unknown>;
  account?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WalletFile {
  address: `0x${string}` | string;
  privateKey: `0x${string}` | string;
  createdAt?: string;
  [key: string]: unknown;
}
