import { WeldApi } from './core/api';
import { WeldAppBridge } from './core/bridge';
import type { WeldAppBridgeOptions } from './core/local-dev';

export { BRIDGE_PROTOCOL, WeldAppBridge } from './core/bridge';
export { DESIGN_TOKEN_NAMES, applyDesignTokens, applyTheme } from './core/appearance';
export { WeldApi, WeldApiError } from './core/api';
export {
  LOCAL_DEV_QUERY_PARAM,
  LOCAL_DEV_WINDOW_FLAG,
  LocalMemoryStore,
  buildLocalInitPayload,
  isLocalPreviewInit,
  shouldUseLocalDev,
} from './core/local-dev';
export type { LocalDevOptions, WeldAppBridgeOptions } from './core/local-dev';
export type {
  AppMessage,
  AppRecord,
  BridgeEventName,
  BridgeFetchRequest,
  BridgeFetchResponse,
  BridgeRequestMethod,
  ConfirmOptions,
  CreateProductInput,
  EventMessage,
  HostMessage,
  InitMessage,
  InitPayload,
  KvClient,
  ListPagination,
  ListResponse,
  ModalResult,
  NotifyMessage,
  OpenModalOptions,
  PersonSummary,
  ProductListOptions,
  ProductSummary,
  ProductsClient,
  ReadyMessage,
  RecordListOptions,
  RecordsClient,
  RequestMessage,
  ResourceListOptions,
  ResponseMessage,
  ShortcutPayload,
  SingleResponse,
  TicketSummary,
  TicketsClient,
  PeopleClient,
  ToastVariant,
  UpdateProductInput,
  WeldAppUser,
  WeldBreadcrumb,
  WeldDesignTokens,
  WeldLocale,
  WeldSurface,
  WeldTheme,
  WeldTokenInfo,
} from './core/types';

export type CreateWeldAppOptions = WeldAppBridgeOptions;

/** Convenience factory: one bridge + one API client, ready to connect. */
export function createWeldApp(options: CreateWeldAppOptions = {}): { bridge: WeldAppBridge; api: WeldApi } {
  const bridge = new WeldAppBridge(options);
  return { bridge, api: new WeldApi(bridge) };
}
