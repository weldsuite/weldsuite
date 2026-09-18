import { WeldApi } from './core/api';
import { WeldAppBridge } from './core/bridge';
import type { WeldAppBridgeOptions } from './core/local-dev';

export { WeldAppBridge } from './core/bridge';
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
  BridgeRequestMethod,
  CreateProductInput,
  EventMessage,
  HostMessage,
  InitMessage,
  InitPayload,
  KvClient,
  ListPagination,
  ListResponse,
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
  SingleResponse,
  TicketSummary,
  TicketsClient,
  PeopleClient,
  ToastVariant,
  UpdateProductInput,
  WeldAppUser,
  WeldLocale,
  WeldTheme,
  WeldTokenInfo,
} from './core/types';

export type CreateWeldAppOptions = WeldAppBridgeOptions;

/** Convenience factory: one bridge + one API client, ready to connect. */
export function createWeldApp(options: CreateWeldAppOptions = {}): { bridge: WeldAppBridge; api: WeldApi } {
  const bridge = new WeldAppBridge(options);
  return { bridge, api: new WeldApi(bridge) };
}
