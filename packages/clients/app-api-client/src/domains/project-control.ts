/**
 * App-API WeldFlow project-control client: the RAID log (`/api/project-raid`)
 * and the links between register items, tasks and milestones
 * (`/api/project-control-links`). Served by flow-api.
 *
 * Request and response shapes are the shared Zod schemas in
 * `../schemas/project-control`, which flow-api validates against.
 */

import type { ClientApi, DataResponse, ListResponse } from '../types';
import { buildQueryString } from '../types';
import type {
  AssessRiskInput,
  ControlLink,
  ControlLinkType,
  ConvertRaidItemInput,
  CreateControlLinkInput,
  CreateRaidItemInput,
  CreateRaidTaskInput,
  LinkedObject,
  RaidAssessResult,
  RaidConvertResult,
  RaidItem,
  RaidItemDetail,
  RaidKind,
  RaidMatrix,
  RaidTaskResult,
  RiskBand,
  UpdateRaidItemInput,
} from '../schemas/project-control';

export type {
  AssessRiskInput,
  ControlLink,
  ControlLinkRelation,
  ControlLinkType,
  ConvertRaidItemInput,
  CreateControlLinkInput,
  CreateRaidItemInput,
  CreateRaidTaskInput,
  LinkedObject,
  RaidAssessResult,
  RaidAssessment,
  RaidConvertResult,
  RaidItem,
  RaidItemDetail,
  RaidKind,
  RaidMatrix,
  RaidTaskResult,
  RiskBand,
  UpdateRaidItemInput,
} from '../schemas/project-control';

export interface ListRaidItemsQuery {
  projectId?: string;
  kind?: RaidKind;
  status?: string;
  ownerId?: string;
  /** Risks in this band only. */
  band?: RiskBand;
  /** True: items not yet in a closed status. */
  open?: boolean;
  search?: string;
  cursor?: string;
  /** 1 to 100, 25 by default. */
  limit?: number;
}

export interface RaidMatrixQuery {
  projectId?: string;
  /** True counts each risk in its after-mitigation cell. */
  residual?: boolean;
}

/** One end of a link: the object's type and id. */
export interface ControlLinkEnd {
  type: ControlLinkType;
  id: string;
}

/**
 * The links of one object, by its `from` end or its `to` end. At least one of
 * the two is required.
 */
export interface ListControlLinksQuery {
  from?: ControlLinkEnd;
  to?: ControlLinkEnd;
}

const raidBase = '/project-raid';
const linksBase = '/project-control-links';

export function createProjectControlApi(api: ClientApi) {
  return {
    // RAID items -----------------------------------------------------------
    listRaidItems(params: ListRaidItemsQuery = {}): Promise<ListResponse<RaidItem>> {
      return api.get(`${raidBase}${buildQueryString({ ...params })}`);
    },

    /** The 5x5 counts of open risks, current or after mitigation. */
    getRaidMatrix(params: RaidMatrixQuery = {}): Promise<DataResponse<RaidMatrix>> {
      return api.get(`${raidBase}/matrix${buildQueryString({ ...params })}`);
    },

    /** The item with its assessments (newest first), its links and its task progress. */
    getRaidItem(id: string): Promise<DataResponse<RaidItemDetail>> {
      return api.get(`${raidBase}/${id}`);
    },

    createRaidItem(input: CreateRaidItemInput): Promise<DataResponse<RaidItem>> {
      return api.post(raidBase, input);
    },

    /** The body is validated against the schema of the stored kind. */
    updateRaidItem(id: string, input: UpdateRaidItemInput): Promise<DataResponse<RaidItem>> {
      return api.patch(`${raidBase}/${id}`, input);
    },

    /** Soft delete; the item's links go with it. */
    deleteRaidItem(id: string): Promise<void> {
      return api.delete(`${raidBase}/${id}`);
    },

    /** Reassess a risk: updates it, appends an assessment and moves the next review. */
    assessRisk(id: string, input: AssessRiskInput): Promise<DataResponse<RaidAssessResult>> {
      return api.post(`${raidBase}/${id}/assess`, input);
    },

    /** Assumption to risk, or risk to issue. The source is closed and kept. */
    convertRaidItem(id: string, input: ConvertRaidItemInput): Promise<DataResponse<RaidConvertResult>> {
      return api.post(`${raidBase}/${id}/convert`, input);
    },

    /** A new mitigation task (risk) or resolution task (issue), linked to the item. */
    createRaidTask(id: string, input: CreateRaidTaskInput): Promise<DataResponse<RaidTaskResult>> {
      return api.post(`${raidBase}/${id}/tasks`, input);
    },

    // Links ----------------------------------------------------------------
    listControlLinks(query: ListControlLinksQuery): Promise<DataResponse<LinkedObject[]>> {
      const params: Record<string, unknown> = {
        fromType: query.from?.type,
        fromId: query.from?.id,
        toType: query.to?.type,
        toId: query.to?.id,
      };
      return api.get(`${linksBase}${buildQueryString(params)}`);
    },

    createControlLink(input: CreateControlLinkInput): Promise<DataResponse<ControlLink>> {
      return api.post(linksBase, input);
    },

    deleteControlLink(id: string): Promise<void> {
      return api.delete(`${linksBase}/${id}`);
    },
  };
}
