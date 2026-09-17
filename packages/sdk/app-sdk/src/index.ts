import { WeldApi } from './core/api';
import { WeldAppBridge } from './core/bridge';

export { WeldAppBridge } from './core/bridge';
export { WeldApi, WeldApiError } from './core/api';
export type {
  AppMessage,
  AppRecord,
  BridgeEventName,
  BridgeRequestMethod,
  EventMessage,
  HostMessage,
  InitMessage,
  InitPayload,
  KvClient,
  ListPagination,
  ListResponse,
  PersonSummary,
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
  WeldAppUser,
  WeldLocale,
  WeldTheme,
  WeldTokenInfo,
} from './core/types';

/** Convenience factory: one bridge + one API client, ready to connect. */
export function createWeldApp(): { bridge: WeldAppBridge; api: WeldApi } {
  const bridge = new WeldAppBridge();
  return { bridge, api: new WeldApi(bridge) };
}
