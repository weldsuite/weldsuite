/**
 * Projects Application Types
 * Project management and task tracking
 */

import { BaseEntity, User, DateRange, Attachment } from '../common.types';

export namespace Projects {
  /**
   * Project
   */
  /**
   * Task
   */
  /**
   * Milestone
   */
  /**
   * Sprint/Iteration
   */
  /**
   * Epic
   */
  /**
   * Board (Kanban/Scrum)
   */
  /**
   * Time Entry
   */
  /**
   * Team
   */
  /**
   * Risk
   */
  /**
   * Resource
   */
  // ==========================================
  // Supporting Types
  // ==========================================

  // ==========================================
  // Enums
  // ==========================================

  /**
   * Project Member
   */
  /**
   * Current user's permissions in a project
   */
  /**
   * Project File
   */
  /**
   * Project Message
   */
  /**
   * Workload
   */
  export interface WorkloadOverview {
    startDate: Date;
    endDate: Date;
    totalCapacity: number;
    totalAllocated: number;
    utilization: number;
    overallocatedCount: number;
    teamMembers: TeamMemberWorkload[];
  }

  /**
   * Project Task (from API)
   */
  export interface ProjectTask {
    id: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
    deletedAt?: string;
    projectId: string;
    sprintId?: string;
    milestoneId?: string;
    parentTaskId?: string;
    title: string;
    description?: string;
    key?: string;
    status: string;
    priority: string;
    progress: number;
    type?: string;
    category?: string;
    tags?: string[];
    labels?: string[];
    assigneeId?: string;
    assigneeIds?: string[];
    reporterId?: string;
    watchers?: string[];
    startDate?: string;
    dueDate?: string;
    completedDate?: string;
    estimatedHours?: number;
    actualHours?: number;
    storyPoints?: number;
    dependsOn?: string[];
    blocks?: string[];
    position: number;
    boardPosition?: number;
    acceptanceCriteria?: string;
    resolution?: string;
    isBillable: boolean;
    project?: { id: string; name: string; key?: string };
    sprint?: { id: string; name: string; status: string };
    milestone?: { id: string; name: string; status: string };
    assignee?: { id: string; name: string; email: string; avatar?: string };
    assignees?: { id: string; name: string; email: string; avatar?: string }[];
    reporter?: { id: string; name: string; email: string; avatar?: string };
  }
}