/**
 * App-API WeldStash carrier shipping domain client: `/api/carriers/*`,
 * `/api/parcels/*` and the label routes of `/api/pick-lists/:id`.
 * Served by the Rust backend only (the Kubernetes editions); Global answers 404.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  CarrierAccount,
  CarrierCatalogEntry,
  CarrierProduct,
  CarrierQuote,
  CarrierTestResult,
  CreateCarrierInput,
  CreateLabelsInput,
  CreateLabelsResult,
  CreateReturnLabelInput,
  ListCarrierProductsQuery,
  ListParcelsQuery,
  ListServicePointsQuery,
  Parcel,
  ParcelDetail,
  PickListShipping,
  QuoteInput,
  ServicePoint,
  UpdateCarrierInput,
  VoidLabelsResult,
} from '../schemas/shipping';

const qs = (params: object) => buildQueryString(params as Record<string, unknown>);

export function createShippingApi(api: ClientApi) {
  return {
    // ── Carrier accounts ──────────────────────────────────────────────────
    getCatalog(): Promise<DataResponse<CarrierCatalogEntry[]>> {
      return api.get<DataResponse<CarrierCatalogEntry[]>>('/carriers/catalog');
    },
    listCarriers(): Promise<DataResponse<CarrierAccount[]>> {
      return api.get<DataResponse<CarrierAccount[]>>('/carriers');
    },
    createCarrier(data: CreateCarrierInput): Promise<DataResponse<CarrierAccount>> {
      return api.post<DataResponse<CarrierAccount>>('/carriers', data);
    },
    updateCarrier(id: string, data: UpdateCarrierInput): Promise<DataResponse<CarrierAccount>> {
      return api.patch<DataResponse<CarrierAccount>>(`/carriers/${id}`, data);
    },
    deleteCarrier(id: string): Promise<void> {
      return api.delete<void>(`/carriers/${id}`);
    },
    testCarrier(id: string): Promise<DataResponse<CarrierTestResult>> {
      return api.post<DataResponse<CarrierTestResult>>(`/carriers/${id}/test`, {});
    },
    listProducts(id: string, params: ListCarrierProductsQuery = {}): Promise<DataResponse<CarrierProduct[]>> {
      return api.get<DataResponse<CarrierProduct[]>>(`/carriers/${id}/products${qs(params)}`);
    },
    listServicePoints(id: string, params: ListServicePointsQuery): Promise<DataResponse<ServicePoint[]>> {
      return api.get<DataResponse<ServicePoint[]>>(`/carriers/${id}/service-points${qs(params)}`);
    },
    quote(id: string, data: QuoteInput): Promise<DataResponse<CarrierQuote>> {
      return api.post<DataResponse<CarrierQuote>>(`/carriers/${id}/quote`, data);
    },

    // ── Labels on a packed pick list ──────────────────────────────────────
    getPickListShipping(pickListId: string): Promise<DataResponse<PickListShipping>> {
      return api.get<DataResponse<PickListShipping>>(`/pick-lists/${pickListId}/shipping`);
    },
    createLabels(pickListId: string, data: CreateLabelsInput): Promise<DataResponse<CreateLabelsResult>> {
      return api.post<DataResponse<CreateLabelsResult>>(`/pick-lists/${pickListId}/labels`, data);
    },
    voidLabels(pickListId: string): Promise<DataResponse<VoidLabelsResult>> {
      return api.delete<DataResponse<VoidLabelsResult>>(`/pick-lists/${pickListId}/labels`);
    },

    // ── Parcels ───────────────────────────────────────────────────────────
    listParcels(params: ListParcelsQuery = {}): Promise<ListResponse<Parcel>> {
      return api.get<ListResponse<Parcel>>(`/parcels${qs(params)}`);
    },
    getParcel(id: string): Promise<DataResponse<ParcelDetail>> {
      return api.get<DataResponse<ParcelDetail>>(`/parcels/${id}`);
    },
    refreshTracking(id: string): Promise<DataResponse<Parcel>> {
      return api.post<DataResponse<Parcel>>(`/parcels/${id}/refresh-tracking`, {});
    },
    createReturnLabel(id: string, data: CreateReturnLabelInput = {}): Promise<DataResponse<Parcel>> {
      return api.post<DataResponse<Parcel>>(`/parcels/${id}/return-label`, data);
    },

    /** The label file (PDF, or ZPL). Needs the platform's auth, so it is fetched as a blob. */
    async getLabelBlob(id: string): Promise<Blob> {
      return (await api.getRaw(`/parcels/${id}/label`)).blob();
    },
    async getCustomsDocumentBlob(id: string): Promise<Blob> {
      return (await api.getRaw(`/parcels/${id}/customs-document`)).blob();
    },
  };
}
