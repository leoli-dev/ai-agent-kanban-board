import type {
  AgentRole,
  AgentRun,
  AppNotification,
  EngineId,
  FailureClass,
  InputKind,
  NotificationType,
  PlanDocument,
  PlannerMessage,
  Project,
  ProjectInput,
  ProjectStatus,
  ProviderProfile,
  RunStatus,
  Task,
  TaskStatus,
} from '@akb/shared';
import type { schema } from './index.js';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export function toProject(r: Row<typeof schema.projects>): Project {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    status: r.status as ProjectStatus,
    workspacePath: r.workspacePath,
    targetRepoPath: r.targetRepoPath,
    gitBranch: r.gitBranch,
    freshRepo: r.freshRepo === 1,
    baseCommit: r.baseCommit,
    liveUrl: r.liveUrl,
    runPid: r.runPid,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
  };
}

export function toProjectInput(r: Row<typeof schema.projectInputs>): ProjectInput {
  return {
    id: r.id,
    projectId: r.projectId,
    kind: r.kind as InputKind,
    pathOrUrl: r.pathOrUrl,
    originalName: r.originalName,
    mime: r.mime,
    size: r.size,
  };
}

export function toPlanDocument(r: Row<typeof schema.planDocuments>): PlanDocument {
  return {
    id: r.id,
    projectId: r.projectId,
    version: r.version,
    mdPath: r.mdPath,
    jsonPath: r.jsonPath,
    status: r.status as PlanDocument['status'],
    approvedAt: r.approvedAt,
  };
}

export function toTask(r: Row<typeof schema.tasks>, dependsOn: string[]): Task {
  return {
    id: r.id,
    projectId: r.projectId,
    planStepId: r.planStepId,
    title: r.title,
    description: r.description,
    acceptanceCriteria: JSON.parse(r.acceptanceCriteriaJson) as string[],
    status: r.status as TaskStatus,
    orderIndex: r.orderIndex,
    retryCount: r.retryCount,
    bounceCount: r.bounceCount,
    blockedReason: r.blockedReason,
    dependsOn,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toProviderProfile(r: Row<typeof schema.providerProfiles>): ProviderProfile {
  return {
    id: r.id,
    name: r.name,
    engine: r.engine as EngineId,
    env: JSON.parse(r.envJson) as Record<string, string>,
    modelLabel: r.modelLabel,
    tier: (r.tier as ProviderProfile['tier']) ?? 'low',
    enabled: r.enabled === 1,
    cooldownUntil: r.cooldownUntil,
    disabledReason: r.disabledReason,
    lastOkAt: r.lastOkAt,
    notes: r.notes,
  };
}

export function toAgentRun(r: Row<typeof schema.agentRuns>): AgentRun {
  return {
    id: r.id,
    taskId: r.taskId,
    projectId: r.projectId,
    role: r.role as AgentRole,
    providerProfileId: r.providerProfileId,
    engineSessionId: r.engineSessionId,
    status: r.status as RunStatus,
    failureClass: r.failureClass as FailureClass | null,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    lastEventAt: r.lastEventAt,
    logPath: r.logPath,
    pid: r.pid,
    numTurns: r.numTurns,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    exitCode: r.exitCode,
    resultText: r.resultText,
  };
}

export function toNotification(r: Row<typeof schema.notifications>): AppNotification {
  return {
    id: r.id,
    type: r.type as NotificationType,
    title: r.title,
    body: r.body,
    projectId: r.projectId,
    read: r.read === 1,
    channelsSent: JSON.parse(r.channelsSentJson) as string[],
    createdAt: r.createdAt,
  };
}

export function toPlannerMessage(r: Row<typeof schema.plannerMessages>): PlannerMessage {
  return {
    id: r.id,
    sessionId: r.sessionId,
    role: r.role as PlannerMessage['role'],
    content: JSON.parse(r.contentJson),
    createdAt: r.createdAt,
  };
}
