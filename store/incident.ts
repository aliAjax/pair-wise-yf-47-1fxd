import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行" | "已撤销";

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Role;
  action: string;
  detail: string;
  phase: "发现" | "响应" | "接驳" | "恢复";
}

export interface Station {
  id: string;
  name: string;
  section: string;
  status: StationStatus;
  passengerRisk: "低" | "中" | "高";
  note: string;
  updatedAt: string;
  /** 车站状态在中心快照上的单调版本，断网命令以发命令时的版本为基础版本 */
  version: number;
}

export interface ShuttlePlan {
  id: string;
  stations: string[];
  vehicles: number;
  interval: number;
  operator: string;
  status: PlanStatus;
  approvals: string[];
  note: string;
  /** 计划在中心快照上的单调版本，内容更新 / 撤销都会推进 */
  version: number;
}

export type CommandType =
  | "station.status"
  | "timeline.add"
  | "plan.add"
  | "plan.submit"
  | "plan.approve"
  | "plan.execute"
  | "plan.update"
  | "plan.revoke";

/** 命令负载：各处置动作携带的业务参数 */
export type CommandPayload =
  | { type: "station.status"; stationId: string; status: StationStatus; note?: string; planId?: string; planVersion?: number }
  | { type: "timeline.add"; action: string; detail: string; phase: TimelineEntry["phase"] }
  | { type: "plan.add"; planId: string; stations: string[]; vehicles: number; interval: number; operator: string; note: string }
  | { type: "plan.submit"; planId: string }
  | { type: "plan.approve"; planId: string; approver: Role }
  | { type: "plan.execute"; planId: string }
  | { type: "plan.update"; planId: string; stations?: string[]; vehicles?: number; interval?: number; operator?: string; note?: string }
  | { type: "plan.revoke"; planId: string; reason: string };

export interface Command {
  /** 客户端生成的命令编号，同一编号重复同步只生效一次（幂等） */
  id: string;
  type: CommandType;
  /** 目标对象，例如 station:s1 / plan:p1 / timeline */
  target: string;
  /** 发起岗位 */
  actor: Role;
  /** 发起时看到的中心快照版本，用于乐观并发控制 */
  baseVersion: number;
  /** 依赖的前置命令编号（同对象链：提交→确认→执行、限流→封闭等） */
  dependsOn?: string;
  /** 车站恢复额外依赖的接驳计划执行命令（plan:<id>#exec@<commandId>） */
  planDependsOn?: string;
  time: string;
  payload: CommandPayload;
}

/** 已被中心快照合并生效的命令（命令日志，重放它即可重建快照） */
export interface LoggedCommand extends Command {
  appliedAt: string;
  /** 因依赖的接驳计划更新 / 撤销而失效，重放时跳过 */
  invalidated?: boolean;
  invalidReason?: string;
}

export type QueueStatus = "pending" | "applied" | "blocked";
export type BlockReason =
  | "unauthorized"
  | "dependency-failed"
  | "stale-version"
  | "duplicate"
  | "target-missing"
  | "precondition"
  | "plan-invalidated";

/** 断网队列条目：恢复连接后与中心快照按命令依赖合并 */
export interface QueuedCommand extends Command {
  status: QueueStatus;
  /** 留在待处理里的原因（依赖未成功 / 岗位越权 / 基础版本过期等） */
  reason?: BlockReason;
  reasonDetail?: string;
  appliedAt?: string;
}

export interface MergeRecord {
  id: string;
  commandId: string;
  type: CommandType;
  actor: Role;
  result: "applied" | "skipped" | "blocked";
  detail: string;
  time: string;
}

export interface MaterialState {
  stations: Station[];
  plans: ShuttlePlan[];
  timeline: TimelineEntry[];
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
}

interface IncidentState extends MaterialState {
  role: Role;
  online: boolean;
  /** 命令日志：中心快照的权威来源 */
  commandLog: LoggedCommand[];
  queue: QueuedCommand[];
  mergeRecords: MergeRecord[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (stationId: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: { action: string; detail: string; phase: TimelineEntry["phase"] }) => void;
  addPlan: (plan: { stations: string[]; vehicles: number; interval: number; operator: string; note: string }) => void;
  submitPlan: (planId: string) => void;
  approvePlan: (planId: string) => void;
  executePlan: (planId: string) => void;
  /** 更新接驳计划内容：依赖它的车站恢复立即失效重算 */
  updatePlan: (planId: string, patch: Partial<Pick<ShuttlePlan, "stations" | "vehicles" | "interval" | "operator" | "note">>) => void;
  /** 撤销（撤回执行）接驳计划：下游动作不能继续套用旧结果 */
  revokePlan: (planId: string, reason: string) => void;
  /** 恢复连接后把断网动作与中心快照按命令依赖合并 */
  syncQueue: () => MergeReport;
  /** 基础版本过期 / 计划失效后，以最新快照为基础重发命令 */
  rebaseCommand: (queueId: string) => void;
  /** 放弃一条留在待处理里的命令 */
  discardCommand: (queueId: string) => void;
}

export interface MergeReport {
  applied: number;
  blocked: number;
  skipped: number;
}

const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(16).slice(2)}`);
const now = () => new Date().toISOString();

const STARTED_AT = new Date(Date.now() - 35 * 60000).toISOString();

function buildBaseline(): MaterialState {
  const t = now();
  return {
    incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: STARTED_AT, section: "中心站—东港站" },
    stations: [
      { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: t, version: 1 },
      { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: t, version: 1 },
      { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: t, version: 1 }
    ],
    plans: [
      { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客", version: 1 }
    ],
    timeline: [
      { id: "seed-e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
      { id: "seed-e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
    ]
  };
}

/** 各岗位对命令的操作权限（越权命令留在待处理里并标明原因） */
const COMMAND_AUTHORITY: Record<CommandType, Role[]> = {
  "station.status": ["调度员", "车站值班员"],
  "timeline.add": ["调度员", "车站值班员", "公交接驳负责人", "客服主管"],
  "plan.add": ["调度员", "公交接驳负责人"],
  "plan.submit": ["调度员", "公交接驳负责人"],
  "plan.approve": ["调度员", "车站值班员", "公交接驳负责人"],
  "plan.execute": ["调度员"],
  "plan.update": ["调度员", "公交接驳负责人"],
  "plan.revoke": ["调度员", "公交接驳负责人"]
};

export function isAuthorized(type: CommandType, actor: Role): boolean {
  return COMMAND_AUTHORITY[type].includes(actor);
}

/** 命令纯函数式重放：跳过被失效的命令，返回推进后的快照 */
function reduce(state: MaterialState, command: Command): MaterialState {
  const p = command.payload;
  switch (p.type) {
    case "station.status": {
      const station = state.stations.find((item) => item.id === p.stationId);
      if (!station) return state;
      const phase = p.status === "正常" || p.status === "恢复中" ? "恢复" : "响应";
      return {
        ...state,
        stations: state.stations.map((item) => item.id === p.stationId
          ? { ...item, status: p.status, note: p.note ?? item.note, updatedAt: command.time, version: item.version + 1 }
          : item),
        timeline: [{ id: command.id, time: command.time, actor: command.actor, action: "更新车站状态", detail: `${station.name} → ${p.status}`, phase }, ...state.timeline]
      };
    }
    case "timeline.add":
      return { ...state, timeline: [{ id: command.id, time: command.time, actor: command.actor, action: p.action, detail: p.detail, phase: p.phase }, ...state.timeline] };
    case "plan.add":
      if (state.plans.some((plan) => plan.id === p.planId)) return state;
      return {
        ...state,
        plans: [{ id: p.planId, stations: p.stations, vehicles: p.vehicles, interval: p.interval, operator: p.operator, status: "草稿", approvals: [], note: p.note, version: 1 }, ...state.plans],
        timeline: [{ id: command.id, time: command.time, actor: command.actor, action: "新建接驳计划", detail: `${p.stations.join(" → ")}，${p.vehicles} 辆`, phase: "接驳" }, ...state.timeline]
      };
    case "plan.submit":
      return {
        ...state,
        plans: state.plans.map((plan) => plan.id === p.planId ? { ...plan, status: "待确认" } : plan),
        timeline: state.plans.some((plan) => plan.id === p.planId)
          ? [{ id: command.id, time: command.time, actor: command.actor, action: "提交接驳计划", detail: `计划 ${p.planId} 等待跨岗位确认`, phase: "接驳" }, ...state.timeline]
          : state.timeline
      };
    case "plan.approve":
      return {
        ...state,
        plans: state.plans.map((plan) => {
          if (plan.id !== p.planId) return plan;
          const approvals = Array.from(new Set([...plan.approvals, p.approver]));
          // 确认不改内容版本（版本仅由计划内容更新推进）
          return { ...plan, approvals, status: approvals.length >= 2 ? "已确认" : plan.status };
        })
      };
    case "plan.execute":
      return {
        ...state,
        plans: state.plans.map((plan) => plan.id === p.planId ? { ...plan, status: "已执行" } : plan),
        timeline: state.plans.some((plan) => plan.id === p.planId)
          ? [{ id: command.id, time: command.time, actor: command.actor, action: "执行接驳计划", detail: "车辆和站点岗位已收到调度指令", phase: "接驳" }, ...state.timeline]
          : state.timeline
      };
    case "plan.update":
      return {
        ...state,
        plans: state.plans.map((plan) => plan.id === p.planId
          ? {
              ...plan,
              stations: p.stations ?? plan.stations,
              vehicles: p.vehicles ?? plan.vehicles,
              interval: p.interval ?? plan.interval,
              operator: p.operator ?? plan.operator,
              note: p.note ?? plan.note,
              // 计划内容更新：已执行的结果作废，需要重新确认执行
              status: plan.status === "草稿" ? "草稿" : "待确认",
              approvals: [],
              // 只有内容更新推进版本：依赖旧内容的车站恢复据此判定失效重算
              version: plan.version + 1
            }
          : plan),
        timeline: state.plans.some((plan) => plan.id === p.planId)
          ? [{ id: command.id, time: command.time, actor: command.actor, action: "更新接驳计划", detail: `计划 ${p.planId} 内容已调整，原执行结果与下游恢复作废重算`, phase: "接驳" }, ...state.timeline]
          : state.timeline
      };
    case "plan.revoke":
      return {
        ...state,
        // 撤销不推进版本：以「已撤销」状态本身阻断旧版本命令盖回
        plans: state.plans.map((plan) => plan.id === p.planId ? { ...plan, status: "已撤销" } : plan),
        timeline: state.plans.some((plan) => plan.id === p.planId)
          ? [{ id: command.id, time: command.time, actor: command.actor, action: "撤销接驳计划", detail: p.reason, phase: "接驳" }, ...state.timeline]
          : state.timeline
      };
  }
}

/** 从基线重放命令日志，重建中心快照（失效命令跳过） */
function materialize(log: LoggedCommand[]): MaterialState {
  return log.filter((entry) => !entry.invalidated).reduce<MaterialState>((acc, entry) => reduce(acc, entry), buildBaseline());
}

/** 离线本地视图：在中心快照之上乐观叠加本地待处理命令，供断网期间预览 */
export function projectLocalView(snapshot: MaterialState, queue: QueuedCommand[]): MaterialState {
  const local = queue
    .filter((item) => item.status === "pending")
    .sort((a, b) => a.time.localeCompare(b.time));
  return local.reduce<MaterialState>((acc, entry) => reduce(acc, entry), snapshot);
}

/** 在日志 + 队列里找目标对象最近一条指定类型的命令（已拦截的不作链锚点） */
function latestCommandFor(log: LoggedCommand[], queue: QueuedCommand[], target: string, types: CommandType[]): Command | undefined {
  const candidates: Command[] = [...log.filter((entry) => !entry.invalidated), ...queue.filter((item) => item.status === "pending" || item.status === "applied")];
  return candidates
    .filter((entry) => entry.target === target && types.includes(entry.type))
    .sort((a, b) => b.time.localeCompare(a.time))[0];
}

/** 依赖引用格式：plan:<planId>#exec@<commandId>，定位所依据的接驳计划执行命令 */
function parseExecDep(dependsOn: string | undefined): { planTarget: string; commandId: string } | undefined {
  if (!dependsOn || !dependsOn.includes("#exec@")) return undefined;
  const [planTarget, commandId] = dependsOn.split("#exec@");
  return { planTarget, commandId };
}

/** 收集所有（传递）依赖某个接驳计划结果的下游命令：计划更新 / 撤销时使其失效 */
function collectPlanDependents(entries: Command[], planTarget: string, selfId?: string): Set<string> {
  const affected = new Set<string>();
  const frontier: string[] = [];
  for (const entry of entries) {
    if (entry.id === selfId) continue;
    if (entry.target === planTarget && (entry.type === "plan.execute" || entry.type === "plan.approve" || entry.type === "plan.submit")) {
      frontier.push(entry.id);
      affected.add(entry.id);
    }
    // 直接依赖该计划执行结果的车站恢复
    const dep = parseExecDep(entry.planDependsOn ?? entry.dependsOn);
    if (entry.target.startsWith("station:") && entry.payload.type === "station.status"
      && (entry.payload.status === "恢复中" || entry.payload.status === "正常")
      && dep?.planTarget === planTarget) {
      frontier.push(entry.id);
      affected.add(entry.id);
    }
  }
  // 传递依赖（下游时间线等 dependsOn 链）
  let cursor = frontier;
  while (cursor.length) {
    const next: string[] = [];
    for (const entry of entries) {
      if (entry.id === selfId || affected.has(entry.id) || !entry.dependsOn) continue;
      if (affected.has(entry.dependsOn)) { affected.add(entry.id); next.push(entry.id); }
    }
    cursor = next;
  }
  return affected;
}

function describeCommand(type: CommandType, target: string, state: MaterialState): string {
  if (type === "station.status") return `车站状态更新（${state.stations.find((s) => s.id === target.split(":")[1])?.name ?? target}）`;
  if (type === "timeline.add") return "追加处置时间线";
  if (type.startsWith("plan.")) return `接驳计划 ${target.split(":")[1]}`;
  return type;
}

export const REASON_TEXT: Record<BlockReason, string> = {
  unauthorized: "岗位越权：该岗位无权执行此命令",
  "dependency-failed": "依赖未成功：前置命令未在中心快照生效",
  "stale-version": "基础版本过期：目标已被中心更新，需基于最新快照重发",
  duplicate: "重复命令：同一编号已同步生效，只生效一次",
  "target-missing": "目标对象不存在",
  precondition: "前置状态不满足",
  "plan-invalidated": "接驳计划已更新或撤销：旧结果失效，需重新计算后重发"
};

function repairPersisted(partial: Partial<IncidentState>): Partial<IncidentState> {
  const fixed = { ...partial };
  if (!Array.isArray(fixed.commandLog)) fixed.commandLog = [];
  if (!Array.isArray(fixed.queue)) fixed.queue = [];
  if (!Array.isArray(fixed.mergeRecords)) fixed.mergeRecords = [];
  if (fixed.stations) fixed.stations = fixed.stations.map((s) => ({ ...s, version: s.version ?? 1 }));
  if (fixed.plans) fixed.plans = fixed.plans.map((p) => ({ ...p, version: p.version ?? 1 }));
  // 旧版 pendingActions 队列已被命令队列取代
  delete (fixed as { pendingActions?: unknown }).pendingActions;
  return fixed;
}

export const useIncidentStore = create<IncidentState>()(persist((set, get) => {
  /** 生成命令时按业务关系补齐依赖命令与基础版本 */
  function buildCommand(type: CommandType, actor: Role, payload: CommandPayload): Command {
    const { stations, plans, commandLog, queue } = get();
    const id = uuid();
    const time = now();
    let target = "";
    let baseVersion = 0;
    let dependsOn: string | undefined;
    let planDependsOn: string | undefined;

    if (payload.type === "station.status") {
      const station = stations.find((item) => item.id === payload.stationId);
      target = `station:${payload.stationId}`;
      baseVersion = station?.version ?? 0;
      // 同一车站的连续处置（限流→封闭→恢复中）：锚定本会话最近一条同对象命令
      dependsOn = latestCommandFor(commandLog, queue, target, ["station.status"])?.id;
      if (payload.status === "恢复中" || payload.status === "正常") {
        // 车站恢复还依赖"覆盖该站、已成功执行"的接驳计划，并记录所基于的计划版本
        const plan = [...plans]
          .filter((item) => item.stations.includes(station?.name ?? ""))
          .sort((a, b) => b.version - a.version)[0];
        if (plan) {
          const executed = latestCommandFor(commandLog, queue, `plan:${plan.id}`, ["plan.execute"]);
          payload.planId = plan.id;
          payload.planVersion = plan.version;
          if (executed) planDependsOn = `plan:${plan.id}#exec@${executed.id}`;
        }
      }
    } else if (payload.type === "timeline.add") {
      target = "timeline";
      // 处置时间线随最终车站状态追加：无前置命令依赖，合并顺序保证落在所依赖的状态更新之后
    } else {
      const planId = payload.planId;
      target = `plan:${planId}`;
      const plan = plans.find((item) => item.id === planId);
      baseVersion = plan?.version ?? 0;
      if (payload.type === "plan.add") {
        baseVersion = 0;
      } else if (payload.type === "plan.submit") {
        dependsOn = latestCommandFor(commandLog, queue, target, ["plan.add"])?.id;
      } else if (payload.type === "plan.approve") {
        dependsOn = latestCommandFor(commandLog, queue, target, ["plan.submit", "plan.update"])?.id;
      } else if (payload.type === "plan.execute") {
        dependsOn = latestCommandFor(commandLog, queue, target, ["plan.approve"])?.id;
      } else if (payload.type === "plan.update" || payload.type === "plan.revoke") {
        dependsOn = latestCommandFor(commandLog, queue, target, ["plan.execute", "plan.approve", "plan.submit", "plan.add"])?.id;
      }
    }

    return { id, type, target, actor, baseVersion, dependsOn, planDependsOn, time, payload };
  }

  /** 在线：命令立即进入中心快照（命令日志）；离线：进待处理队列 */
  function dispatch(type: CommandType, payload: CommandPayload) {
    const state = get();
    const command = buildCommand(type, state.role, payload);
    if (!state.online) {
      set({ queue: [...state.queue, { ...command, status: "pending" }] });
      return;
    }
    const logged: LoggedCommand = { ...command, appliedAt: now() };
    const nextLog = [...state.commandLog, logged];
    const snapshot = materialize(nextLog);
    const records = [...state.mergeRecords, { id: uuid(), commandId: command.id, type, actor: state.role, result: "applied" as const, detail: "在线直接进入中心快照", time: now() }];
    set({ ...snapshot, commandLog: nextLog, mergeRecords: records });
  }

  /**
   * 接驳计划更新 / 撤销时：
   * 1) 命令日志里所有传递依赖旧计划结果的命令标记失效，重放重建快照（车站恢复回滚）；
   * 2) 待处理队列里的同类下游命令留在待处理并标明原因，其他不相干命令照常保留。
   */
  function invalidatePlanDownstream(log: LoggedCommand[], queue: QueuedCommand[], planTarget: string, selfId: string | undefined, reason: BlockReason, detail: string) {
    const dependentIds = collectPlanDependents([...log, ...queue], planTarget, selfId);
    const nextLog = log.map((entry) => dependentIds.has(entry.id)
      ? { ...entry, invalidated: true, invalidReason: REASON_TEXT[reason] }
      : entry);
    const nextQueue = queue.map((entry) => dependentIds.has(entry.id)
      ? { ...entry, status: "blocked" as const, reason, reasonDetail: detail }
      : entry);
    return { nextLog, nextQueue };
  }

  /** 带下游失效处理的在线命令提交（计划更新 / 撤销） */
  function dispatchPlanMutation(type: CommandType, payload: Extract<CommandPayload, { type: "plan.update" | "plan.revoke" }>) {
    const state = get();
    const command = buildCommand(type, state.role, payload);
    if (!state.online) {
      set({ queue: [...state.queue, { ...command, status: "pending" }] });
      return;
    }
    const planTarget = command.target;
    let nextLog = [...state.commandLog, { ...command, appliedAt: now() } as LoggedCommand];
    let nextQueue = state.queue;
    const detail = payload.type === "plan.revoke"
      ? "接驳计划已撤销：下游动作不能继续套用旧结果，需重新计算"
      : "接驳计划已更新：依赖它的车站恢复立即失效，需基于新计划重算";
    const invalidated = invalidatePlanDownstream(nextLog, nextQueue, planTarget, command.id, "plan-invalidated", detail);
    nextLog = invalidated.nextLog;
    nextQueue = invalidated.nextQueue;
    const snapshot = materialize(nextLog);
    const records = [...state.mergeRecords, { id: uuid(), commandId: command.id, type, actor: state.role, result: "applied" as const, detail: payload.type === "plan.revoke" ? "中心撤销接驳计划，下游旧结果作废" : "中心更新接驳计划，下游恢复失效重算", time: now() }];
    set({ ...snapshot, commandLog: nextLog, queue: nextQueue, mergeRecords: records });
  }

  return {
    ...buildBaseline(),
    role: "调度员",
    online: true,
    commandLog: [],
    queue: [],
    mergeRecords: [],

    setRole: (role) => set({ role }),
    setOnline: (online) => set({ online }),

    setStationStatus: (stationId, status, note) => dispatch("station.status", { type: "station.status", stationId, status, note }),

    addTimeline: (entry) => dispatch("timeline.add", { type: "timeline.add", action: entry.action, detail: entry.detail, phase: entry.phase }),

    addPlan: (plan) => {
      const planId = `p-${uuid().slice(0, 8)}`;
      dispatch("plan.add", { type: "plan.add", planId, ...plan });
    },

    submitPlan: (planId) => dispatch("plan.submit", { type: "plan.submit", planId }),
    approvePlan: (planId) => {
      const role = get().role;
      dispatch("plan.approve", { type: "plan.approve", planId, approver: role });
    },
    executePlan: (planId) => dispatch("plan.execute", { type: "plan.execute", planId }),
    updatePlan: (planId, patch) => dispatchPlanMutation("plan.update", { type: "plan.update", planId, ...patch }),
    revokePlan: (planId, reason) => dispatchPlanMutation("plan.revoke", { type: "plan.revoke", planId, reason }),

    syncQueue: () => {
      const state = get();
      const appliedIds = new Set(state.commandLog.map((entry) => entry.id));
      // 同编号在过往合并中已处理（含之前轮次），保证同一编号重复同步只生效一次
      const seenQueueIds = new Set(state.queue.filter((item) => item.status === "applied").map((item) => item.id));

      let log = [...state.commandLog];
      let queue = [...state.queue];
      const newRecords: MergeRecord[] = [];
      const report: MergeReport = { applied: 0, blocked: 0, skipped: 0 };

      // 多趟扫描：依赖的前置可能排在队列靠后，每趟让新成功的命令解锁后续
      let pending = queue
        .filter((item) => item.status === "pending")
        .sort((a, b) => a.time.localeCompare(b.time));

      let progress = true;
      while (pending.length && progress) {
        progress = false;
        const stillPending: QueuedCommand[] = [];

        for (const command of pending) {
          // 本趟内该条目可能已被改写（拦截 / 生效）；用对象身份判断，
          // 不能按 id 查找——重复同步的副本与已生效原件编号相同但应被当作重复处理
          if (!queue.includes(command)) { progress = true; continue; }

          const tag = describeCommand(command.type, command.target, materialize(log));
          const block = (reason: BlockReason, extra?: string): void => {
            queue = queue.map((item) => item.id === command.id ? { ...item, status: "blocked", reason, reasonDetail: extra ?? REASON_TEXT[reason] } : item);
            newRecords.push({ id: uuid(), commandId: command.id, type: command.type, actor: command.actor, result: "blocked", detail: extra ?? REASON_TEXT[reason], time: now() });
            report.blocked += 1;
          };

          // 1) 幂等：同一编号重复同步只生效一次
          if (appliedIds.has(command.id) || seenQueueIds.has(command.id)) {
            queue = queue.map((item) => item.id === command.id ? { ...item, status: "blocked", reason: "duplicate", reasonDetail: REASON_TEXT.duplicate } : item);
            newRecords.push({ id: uuid(), commandId: command.id, type: command.type, actor: command.actor, result: "skipped", detail: REASON_TEXT.duplicate, time: now() });
            report.skipped += 1;
            progress = true;
            continue;
          }

          // 2) 岗位越权
          if (!isAuthorized(command.type, command.actor)) {
            block("unauthorized");
            progress = true;
            continue;
          }

          const snapshot = materialize(log);
          const p = command.payload;

          // 3) 目标对象
          if (p.type.startsWith("station.")) {
            const stationId = (p as { stationId: string }).stationId;
            if (!snapshot.stations.some((item) => item.id === stationId)) { block("target-missing"); progress = true; continue; }
          } else if (p.type.startsWith("plan.") && p.type !== "plan.add") {
            const planId = (p as { planId: string }).planId;
            if (!snapshot.plans.some((item) => item.id === planId)) { block("target-missing"); progress = true; continue; }
          }

          // 4) 依赖命令必须已在中心快照成功（且未失效）
          //    - dependsOn：同对象前置链（提交→确认→执行、限流→封闭）
          //    - planDependsOn：车站恢复所依据的接驳计划执行结果
          const refs = [command.dependsOn, parseExecDep(command.planDependsOn)?.commandId].filter((value): value is string => !!value);
          let waitForDependency = false;
          let blockedNow = false;
          for (const ref of refs) {
            const depLogged = log.find((entry) => entry.id === ref);
            if (!depLogged) {
              // 前置还在本队列里：等后续趟次；前置已被拦截：依赖失败
              const depQueued = queue.find((item) => item.id === ref);
              if (depQueued && depQueued.status === "pending") { waitForDependency = true; continue; }
              block("dependency-failed", depQueued?.reasonDetail ?? `依赖命令 ${ref.slice(0, 8)} 未成功生效`);
              blockedNow = true;
              break;
            }
            if (depLogged.invalidated) {
              block("plan-invalidated", "依赖的前置命令所基于的接驳计划已更新或撤销，旧结果失效");
              blockedNow = true;
              break;
            }
          }
          if (blockedNow) { progress = true; continue; }
          if (waitForDependency) { stillPending.push(command); continue; }

          // 5) 乐观并发：基础版本与中心当前版本不一致即为过期；
          //    同对象依赖链上的命令（断网期间连续处置）由链锚定，放行版本比对
          const sameTargetChain = command.dependsOn
            ? log.find((entry) => entry.id === command.dependsOn && entry.target === command.target && !entry.invalidated)
            : undefined;
          if (p.type === "station.status") {
            const current = snapshot.stations.find((item) => item.id === p.stationId);
            if (current && current.version !== command.baseVersion && !sameTargetChain) { block("stale-version"); progress = true; continue; }
            // 车站恢复：必须基于"覆盖该站、已成功执行且版本一致"的接驳计划
            if (p.status === "恢复中" || p.status === "正常") {
              const plan = snapshot.plans.find((item) => item.id === p.planId);
              if (plan?.status === "已撤销") { block("plan-invalidated", "接驳计划已撤销，车站恢复不能套用旧结果，需重新编制计划"); progress = true; continue; }
              if (!plan) { block("dependency-failed", "没有找到覆盖该车站的接驳计划，车站恢复的前置依赖未满足"); progress = true; continue; }
              if (plan.status !== "已执行") { stillPending.push(command); continue; }
              if (p.planVersion !== undefined && plan.version !== p.planVersion) { block("plan-invalidated", "接驳计划已更新，车站恢复所依据的计划版本过期，需重新计算"); progress = true; continue; }
            }
          } else if (p.type.startsWith("plan.") && p.type !== "plan.add") {
            const planId = (p as { planId: string }).planId;
            const current = snapshot.plans.find((item) => item.id === planId);
            if (current && current.version !== command.baseVersion && !sameTargetChain) {
              // 中心已撤销：任何旧版本下游命令都不能盖回撤销
              if (current.status === "已撤销") { block("plan-invalidated", `中心已撤销该计划（v${current.version}），旧版本命令不得覆盖撤销`); progress = true; continue; }
              block("stale-version");
              progress = true;
              continue;
            }
          }

          // 6) 业务前置状态（防止命令越过前置步骤）
          const plan = p.type.startsWith("plan.") && p.type !== "plan.add"
            ? snapshot.plans.find((item) => item.id === (p as { planId: string }).planId)
            : undefined;
          if (p.type === "plan.submit" && plan && plan.status !== "草稿") { block("precondition", `计划当前为「${plan.status}」，不能重复提交`); progress = true; continue; }
          if (p.type === "plan.approve" && plan && plan.status !== "待确认") { block("precondition", `计划当前为「${plan.status}」，仅待确认计划可确认`); progress = true; continue; }
          if (p.type === "plan.execute" && plan && plan.status !== "已确认") { block("precondition", `计划当前为「${plan.status}」，需双方确认后才能执行`); progress = true; continue; }
          if (p.type === "plan.revoke" && plan && plan.status !== "已执行" && plan.status !== "已确认") { block("precondition", `计划当前为「${plan.status}」，仅已确认 / 已执行计划可撤销`); progress = true; continue; }
          if (p.type === "plan.update" && plan && plan.status === "已撤销") { block("precondition", "计划已撤销，请新建接驳计划"); progress = true; continue; }

          // 生效：写入命令日志并重放
          const logged: LoggedCommand = { ...command, appliedAt: now() };
          log = [...log, logged];
          appliedIds.add(command.id);
          queue = queue.map((item) => item.id === command.id ? { ...item, status: "applied", appliedAt: logged.appliedAt, reason: undefined, reasonDetail: undefined } : item);

          // 计划更新 / 撤销：下游旧结果立即失效重算（其他不相干命令照常保留）
          if (p.type === "plan.update" || p.type === "plan.revoke") {
            const detail = p.type === "plan.revoke"
              ? "接驳计划已撤销：下游动作不能继续套用旧结果，需重新计算"
              : "接驳计划已更新：依赖它的车站恢复立即失效，需基于新计划重算";
            const invalidated = invalidatePlanDownstream(log, queue, command.target, command.id, "plan-invalidated", detail);
            log = invalidated.nextLog;
            queue = invalidated.nextQueue;
          }

          const after = materialize(log);
          const versionText = p.type === "station.status" ? `v${after.stations.find((item) => item.id === p.stationId)?.version ?? ""}` : "";
          newRecords.push({ id: uuid(), commandId: command.id, type: command.type, actor: command.actor, result: "applied", detail: `${tag}已合并入中心快照 ${versionText}`.trim(), time: now() });
          report.applied += 1;
          progress = true;
        }

        pending = stillPending;
      }

      // 依赖始终无法满足（计划被撤销等）：仍 pending 的车站恢复转 blocked 并标明原因
      for (const command of pending) {
        const p = command.payload;
        let reason: BlockReason = "dependency-failed";
        let detail = REASON_TEXT["dependency-failed"];
        if (p.type === "station.status") {
          const snapshot = materialize(log);
          const plan = snapshot.plans.find((item) => item.id === p.planId);
          if (plan?.status === "已撤销") { reason = "plan-invalidated"; detail = "接驳计划已撤销，车站恢复不能套用旧结果，需重新编制计划"; }
          else if (p.planVersion !== undefined && plan && plan.version !== p.planVersion) { reason = "plan-invalidated"; detail = "接驳计划已更新，车站恢复需基于新计划重新计算"; }
          else if (plan?.status !== "已执行") { reason = "dependency-failed"; detail = "接驳计划未成功执行，车站恢复的前置依赖未满足"; }
        }
        queue = queue.map((item) => item.id === command.id ? { ...item, status: "blocked", reason, reasonDetail: detail } : item);
        newRecords.push({ id: uuid(), commandId: command.id, type: command.type, actor: command.actor, result: "blocked", detail, time: now() });
        report.blocked += 1;
      }

      const snapshot = materialize(log);
      set({ ...snapshot, commandLog: log, queue, mergeRecords: [...state.mergeRecords, ...newRecords] });
      return report;
    },

    rebaseCommand: (queueId) => {
      const state = get();
      const item = state.queue.find((q) => q.id === queueId);
      if (!item) return;
      const p = item.payload;
      let baseVersion = 0;
      let dependsOn = item.dependsOn;
      let planDependsOn = item.planDependsOn;
      let payload = p;
      if (p.type === "station.status") {
        const station = state.stations.find((s) => s.id === p.stationId);
        baseVersion = station?.version ?? 0;
        if (p.status === "恢复中" || p.status === "正常") {
          // 以覆盖该站、版本最新的计划重挂执行依赖
          const plan = [...state.plans]
            .filter((item) => item.stations.includes(station?.name ?? ""))
            .sort((a, b) => b.version - a.version)[0];
          if (plan) {
            const executed = latestCommandFor(state.commandLog, state.queue, `plan:${plan.id}`, ["plan.execute"]);
            payload = { ...p, planId: plan.id, planVersion: plan.version };
            planDependsOn = executed && plan.status === "已执行" ? `plan:${plan.id}#exec@${executed.id}` : undefined;
          }
        }
      } else if (p.type.startsWith("plan.") && p.type !== "plan.add") {
        baseVersion = state.plans.find((plan) => plan.id === (p as { planId: string }).planId)?.version ?? 0;
      }
      // 重发 = 新编号 + 最新基础版本；旧条目标记放弃，避免重复编号
      const replacement: QueuedCommand = {
        ...item,
        id: uuid(),
        baseVersion,
        dependsOn,
        planDependsOn,
        payload,
        time: now(),
        status: "pending",
        reason: undefined,
        reasonDetail: undefined,
        appliedAt: undefined
      };
      set({
        queue: state.queue.map((q): QueuedCommand => q.id === queueId ? { ...q, status: "blocked", reason: "duplicate", reasonDetail: `已基于最新快照重发为 ${replacement.id.slice(0, 8)}` } : q).concat(replacement)
      });
    },

    discardCommand: (queueId) => set({ queue: get().queue.filter((item) => item.id !== queueId) })
  };
}, {
  name: "pair-wise-yf-47/incident",
  version: 2,
  // 命令日志是权威来源：合并后统一重建 stations/plans/timeline；
  // 必须保留 current 上的 action 函数（持久化 JSON 不含函数）
  merge: (persisted, current) => ({ ...current, ...repairPersisted((persisted ?? {}) as Partial<IncidentState>) }) as IncidentState,
  onRehydrateStorage: () => (rehydrated) => {
    if (!rehydrated) return;
    // 快照可能落后于命令日志（旧持久化 / 失效标记变化），重放一次保证一致
    if (rehydrated.commandLog.length) {
      const snapshot = materialize(rehydrated.commandLog);
      useIncidentStore.setState({ ...snapshot });
    }
  }
}));
