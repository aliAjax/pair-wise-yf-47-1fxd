import { create } from "zustand";
import { persist } from "zustand/middleware";

export type Role = "调度员" | "车站值班员" | "公交接驳负责人" | "客服主管";
export type IncidentStatus = "处置中" | "控制中" | "已恢复";
export type StationStatus = "正常" | "限流" | "封闭" | "恢复中";
export type PlanStatus = "草稿" | "待确认" | "已确认" | "已执行";

/** 命令类型：四个岗位在弱网下可发起的处置动作 */
export type CommandKind =
  | "station.status"
  | "timeline.add"
  | "plan.add"
  | "plan.submit"
  | "plan.approve"
  | "plan.execute"
  | "plan.undoExecute";

/** 命令在合并后的最终状态 */
export type CommandStatus = "pending" | "applied" | "rejected" | "stale";

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
  /** 该对象最后一次被中心命令写入时的快照版本，用于合并时判断是否覆盖中心新状态 */
  lastModifiedVersion?: number;
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
  /** 最近一次生效的执行命令编号，车站恢复依赖它 */
  lastExecuteCommandId?: string;
  lastModifiedVersion?: number;
}

/**
 * 弱网命令队列中的一条命令。
 * 每项记录目标对象、发起岗位、基础版本和依赖命令。
 */
export interface QueuedCommand {
  id: string;
  kind: CommandKind;
  /** 目标对象：车站 id / 计划 id / 时间线临时 id */
  target: string;
  /** 发起岗位 */
  actor: Role;
  /** 基础版本：命令发起时所依据的中心快照版本 */
  baseVersion: number;
  /** 依赖命令编号：前置步骤未生效则本命令不套用 */
  dependsOn: string[];
  payload: Record<string, unknown>;
  time: string;
  status: CommandStatus;
  /** 未生效原因：依赖失败 / 岗位越权 / 版本过期 */
  reason?: string;
}

interface IncidentState {
  incident: { id: string; title: string; status: IncidentStatus; startedAt: string; section: string };
  stations: Station[];
  timeline: TimelineEntry[];
  plans: ShuttlePlan[];
  role: Role;
  online: boolean;
  /** 中心快照版本，仅在命令真正生效时递增 */
  version: number;
  /** 弱网命令队列（含已生效 / 待处理 / 拒绝 / 失效） */
  pendingActions: QueuedCommand[];
  setRole: (role: Role) => void;
  setOnline: (online: boolean) => void;
  setStationStatus: (id: string, status: StationStatus, note?: string) => void;
  addTimeline: (entry: Omit<TimelineEntry, "id" | "time">) => void;
  addPlan: (plan: Omit<ShuttlePlan, "id" | "status" | "approvals">) => void;
  submitPlan: (id: string) => void;
  approvePlan: (id: string, approver: string) => void;
  executePlan: (id: string) => void;
  undoPlan: (id: string) => void;
  queueAction: (action: string, detail: string) => void;
  syncActions: () => void;
}

const now = () => new Date().toISOString();

/** 各岗位允许发起的命令（岗位越权判定依据） */
const ROLE_PERMISSIONS: Record<Role, CommandKind[]> = {
  调度员: ["station.status", "timeline.add", "plan.add", "plan.submit", "plan.approve", "plan.execute", "plan.undoExecute"],
  车站值班员: ["station.status", "timeline.add"],
  公交接驳负责人: ["timeline.add", "plan.add", "plan.submit", "plan.approve"],
  客服主管: ["timeline.add"]
};

export const KIND_LABEL: Record<CommandKind, string> = {
  "station.status": "更新车站状态",
  "timeline.add": "添加处置记录",
  "plan.add": "新建接驳计划",
  "plan.submit": "提交接驳计划",
  "plan.approve": "确认接驳计划",
  "plan.execute": "执行接驳计划",
  "plan.undoExecute": "撤销计划执行"
};

const hasPermission = (role: Role, kind: CommandKind) => ROLE_PERMISSIONS[role]?.includes(kind) ?? false;

const seedStations: Station[] = [
  { id: "s1", name: "滨江站", section: "中心-滨江", status: "封闭", passengerRisk: "高", note: "站台积水，已启动公交接驳", updatedAt: now(), lastModifiedVersion: 1 },
  { id: "s2", name: "会展中心站", section: "会展-滨江", status: "限流", passengerRisk: "中", note: "出入口单向组织", updatedAt: now(), lastModifiedVersion: 1 },
  { id: "s3", name: "东港站", section: "滨江-东港", status: "正常", passengerRisk: "低", note: "做好接班车准备", updatedAt: now(), lastModifiedVersion: 1 }
];

const seedPlans: ShuttlePlan[] = [
  { id: "p1", stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", status: "待确认", approvals: ["调度员"], note: "优先疏运站外滞留乘客", lastModifiedVersion: 1 }
];

/** 深拷贝可变草稿，避免在合并过程中污染 state */
function cloneDraft(state: IncidentState) {
  return {
    incident: structuredClone(state.incident),
    stations: structuredClone(state.stations),
    timeline: structuredClone(state.timeline),
    plans: structuredClone(state.plans),
    pendingActions: structuredClone(state.pendingActions),
    version: state.version,
    role: state.role,
    online: state.online
  };
}

type Draft = ReturnType<typeof cloneDraft>;

/** 构造一条命令，自动记录基础版本 */
function makeCommand(
  get: () => IncidentState,
  kind: CommandKind,
  target: string,
  actor: Role,
  payload: Record<string, unknown>,
  dependsOn: string[] = []
): QueuedCommand {
  return {
    id: crypto.randomUUID(),
    kind,
    target,
    actor,
    baseVersion: get().version,
    dependsOn,
    payload,
    time: now(),
    status: "pending"
  };
}

/** 在队列中查找某类目标的最近一条命令（用于串联依赖） */
function findCmd(queue: QueuedCommand[], kind: CommandKind, target: string) {
  return queue.find((c) => c.kind === kind && c.target === target);
}

/**
 * 查找覆盖某车站的接驳计划的执行命令编号（用于车站恢复依赖）。
 * 计划可能已在 state.plans 中，也可能只在弱网队列里（plan.add 尚未生效）。
 * 优先返回已生效的执行命令，其次返回任意执行命令。
 */
function findExecuteForStation(state: { stations: Station[]; plans: ShuttlePlan[]; pendingActions: QueuedCommand[] }, stationName: string): string | undefined {
  const planIds = new Set<string>();
  for (const p of state.plans) if (p.stations.includes(stationName)) planIds.add(p.id);
  for (const cmd of state.pendingActions) {
    if (cmd.kind === "plan.add") {
      const plan = cmd.payload.plan as ShuttlePlan;
      if (plan.stations.includes(stationName)) planIds.add(cmd.target);
    }
  }
  const execs = state.pendingActions.filter((c) => c.kind === "plan.execute" && planIds.has(c.target));
  return execs.find((c) => c.status === "applied")?.id ?? execs[0]?.id;
}

/**
 * 命令生效函数：在草稿上应用命令。
 * 成功时递增快照版本并写入对象 lastModifiedVersion；失败时不改动草稿。
 * snapshotLMV 为合并开始时各对象的中心快照版本（key: `station:<id>` / `plan:<id>`），
 * 用于判定命令是否会覆盖中心在其基础版本之后写入的新状态；不传时（在线即时生效）取对象实时版本。
 */
function applyCommand(d: Draft, cmd: QueuedCommand, snapshotLMV?: Map<string, number>): { ok: boolean; reason?: string } {
  if (!hasPermission(cmd.actor, cmd.kind)) {
    return { ok: false, reason: `岗位越权：${cmd.actor} 无权${KIND_LABEL[cmd.kind]}` };
  }
  switch (cmd.kind) {
    case "station.status": {
      const station = d.stations.find((s) => s.id === cmd.target);
      if (!station) return { ok: false, reason: "目标车站不存在" };
      const status = cmd.payload.status as StationStatus;
      const note = cmd.payload.note as string | undefined;
      const isRecovery = status === "恢复中" || status === "正常";
      if (isRecovery) {
        const covering = d.plans.find((p) => p.stations.includes(station.name) && p.status === "已执行");
        if (!covering) return { ok: false, reason: "车站恢复需依赖已执行的接驳计划，当前无覆盖该站的已执行计划" };
        for (const depId of cmd.dependsOn) {
          const dep = d.pendingActions.find((c) => c.id === depId);
          if (!dep || dep.status !== "applied") {
            return { ok: false, reason: `依赖命令 ${depId.slice(0, 6)} 未生效，恢复不能套用旧结果` };
          }
        }
      }
      const stationLMV = snapshotLMV ? snapshotLMV.get(`station:${station.id}`) : station.lastModifiedVersion;
      if (stationLMV !== undefined && stationLMV > cmd.baseVersion) {
        return { ok: false, reason: `目标车站在基础版本 v${cmd.baseVersion} 后已被中心更新至 v${stationLMV}，命令过期，不覆盖中心状态` };
      }
      station.status = status;
      if (note !== undefined) station.note = note;
      station.updatedAt = now();
      d.version += 1;
      station.lastModifiedVersion = d.version;
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: cmd.actor,
        action: "更新车站状态",
        detail: `${station.name} → ${status}`,
        phase: isRecovery ? "恢复" : "响应"
      });
      return { ok: true };
    }
    case "timeline.add": {
      d.version += 1;
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: cmd.actor,
        action: cmd.payload.action as string,
        detail: cmd.payload.detail as string,
        phase: cmd.payload.phase as TimelineEntry["phase"]
      });
      return { ok: true };
    }
    case "plan.add": {
      const plan = cmd.payload.plan as Omit<ShuttlePlan, "id" | "status" | "approvals" | "lastExecuteCommandId" | "lastModifiedVersion">;
      d.version += 1;
      d.plans.unshift({ ...plan, id: cmd.target, status: "草稿", approvals: [], lastModifiedVersion: d.version });
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: cmd.actor,
        action: "新建接驳计划",
        detail: `计划 ${cmd.target.slice(0, 6)} 保存为草稿`,
        phase: "接驳"
      });
      return { ok: true };
    }
    case "plan.submit": {
      const plan = d.plans.find((p) => p.id === cmd.target);
      if (!plan) return { ok: false, reason: "目标计划不存在" };
      if (plan.status !== "草稿") return { ok: false, reason: `计划 ${plan.id.slice(0, 6)} 状态为「${plan.status}」，仅草稿可提交` };
      const planLMV = snapshotLMV ? snapshotLMV.get(`plan:${plan.id}`) : plan.lastModifiedVersion;
      if (planLMV !== undefined && planLMV > cmd.baseVersion) {
        return { ok: false, reason: `目标计划在基础版本 v${cmd.baseVersion} 后已被中心更新至 v${planLMV}，命令过期` };
      }
      plan.status = "待确认";
      d.version += 1;
      plan.lastModifiedVersion = d.version;
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: cmd.actor,
        action: "提交接驳计划",
        detail: `计划 ${plan.id.slice(0, 6)} 等待跨岗位确认`,
        phase: "接驳"
      });
      return { ok: true };
    }
    case "plan.approve": {
      const plan = d.plans.find((p) => p.id === cmd.target);
      if (!plan) return { ok: false, reason: "目标计划不存在" };
      if (plan.status !== "待确认") return { ok: false, reason: `计划 ${plan.id.slice(0, 6)} 状态为「${plan.status}」，仅待确认可确认` };
      const planLMV = snapshotLMV ? snapshotLMV.get(`plan:${plan.id}`) : plan.lastModifiedVersion;
      if (planLMV !== undefined && planLMV > cmd.baseVersion) {
        return { ok: false, reason: `目标计划在基础版本 v${cmd.baseVersion} 后已被中心更新至 v${planLMV}，命令过期` };
      }
      plan.approvals = Array.from(new Set([...plan.approvals, cmd.payload.approver as string]));
      plan.status = plan.approvals.length >= 1 ? "已确认" : plan.status;
      d.version += 1;
      plan.lastModifiedVersion = d.version;
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: cmd.actor,
        action: "确认接驳计划",
        detail: `计划 ${plan.id.slice(0, 6)} 已确认`,
        phase: "接驳"
      });
      return { ok: true };
    }
    case "plan.execute": {
      const plan = d.plans.find((p) => p.id === cmd.target);
      if (!plan) return { ok: false, reason: "目标计划不存在" };
      if (plan.status !== "已确认") return { ok: false, reason: `计划 ${plan.id.slice(0, 6)} 状态为「${plan.status}」，仅已确认可执行` };
      const planLMV = snapshotLMV ? snapshotLMV.get(`plan:${plan.id}`) : plan.lastModifiedVersion;
      if (planLMV !== undefined && planLMV > cmd.baseVersion) {
        return { ok: false, reason: `目标计划在基础版本 v${cmd.baseVersion} 后已被中心更新至 v${planLMV}（可能已撤销），命令过期，不覆盖中心状态` };
      }
      plan.status = "已执行";
      plan.lastExecuteCommandId = cmd.id;
      d.version += 1;
      plan.lastModifiedVersion = d.version;
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: cmd.actor,
        action: "执行接驳计划",
        detail: "车辆和站点岗位已收到调度指令",
        phase: "接驳"
      });
      recalcRecoveries(d, plan.id, "executed");
      return { ok: true };
    }
    case "plan.undoExecute": {
      const plan = d.plans.find((p) => p.id === cmd.target);
      if (!plan) return { ok: false, reason: "目标计划不存在" };
      if (plan.status !== "已执行") return { ok: false, reason: `计划 ${plan.id.slice(0, 6)} 状态为「${plan.status}」，仅已执行可撤销` };
      const planLMV = snapshotLMV ? snapshotLMV.get(`plan:${plan.id}`) : plan.lastModifiedVersion;
      if (planLMV !== undefined && planLMV > cmd.baseVersion) {
        return { ok: false, reason: `目标计划在基础版本 v${cmd.baseVersion} 后已被中心更新至 v${planLMV}，命令过期` };
      }
      plan.status = "已确认";
      plan.lastExecuteCommandId = undefined;
      d.version += 1;
      plan.lastModifiedVersion = d.version;
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: cmd.actor,
        action: "撤销计划执行",
        detail: `计划 ${plan.id.slice(0, 6)} 撤回确认状态，下游恢复不得套用旧结果`,
        phase: "接驳"
      });
      recalcRecoveries(d, plan.id, "undone");
      return { ok: true };
    }
  }
  return { ok: false, reason: "未知命令" };
}

/**
 * 接驳计划更新后，对依赖它的车站恢复进行失效重算。
 * - 计划已执行：恢复命令保持待处理，时间线随最终车站状态追加；
 * - 计划被撤销：依赖它的恢复命令置为失效，不得继续套用旧结果；
 * - 其他不相干命令不受影响。
 */
function recalcRecoveries(d: Draft, planId: string, mode: "executed" | "undone") {
  const plan = d.plans.find((p) => p.id === planId);
  if (!plan) return;
  const affected = d.stations.filter((s) => plan.stations.includes(s.name));
  for (const cmd of d.pendingActions) {
    if (cmd.kind !== "station.status" || cmd.status !== "pending") continue;
    const station = affected.find((s) => s.id === cmd.target);
    if (!station) continue;
    const isRecovery = cmd.payload.status === "恢复中" || cmd.payload.status === "正常";
    if (!isRecovery) continue;
    const dependsOnPlan = cmd.dependsOn.some((depId) => d.pendingActions.find((c) => c.id === depId)?.target === planId);
    if (!dependsOnPlan) continue;
    if (mode === "executed") {
      cmd.reason = undefined;
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: "调度员",
        action: "恢复重算",
        detail: `接驳计划已执行，${station.name} 恢复按最终状态重算为 ${cmd.payload.status}`,
        phase: "恢复"
      });
    } else {
      cmd.status = "stale";
      cmd.reason = "接驳计划已撤销执行，依赖它的车站恢复失效，需按最终状态重算";
      d.timeline.unshift({
        id: crypto.randomUUID(),
        time: now(),
        actor: "调度员",
        action: "恢复失效",
        detail: `接驳计划撤销执行，${station.name} 维持 ${station.status}`,
        phase: "恢复"
      });
    }
  }
}

/** 拓扑排序：依赖命令优先入列，检测依赖环 */
function topoSort(pending: QueuedCommand[], byId: Map<string, QueuedCommand>) {
  const ids = new Set(pending.map((c) => c.id));
  const sorted: QueuedCommand[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (c: QueuedCommand) => {
    if (visited.has(c.id) || visiting.has(c.id)) return;
    visiting.add(c.id);
    for (const depId of c.dependsOn) {
      const dep = byId.get(depId);
      if (dep && ids.has(dep.id)) visit(dep);
    }
    visiting.delete(c.id);
    visited.add(c.id);
    sorted.push(c);
  };
  pending.forEach(visit);
  return sorted;
}

export const useIncidentStore = create<IncidentState>()(
  persist(
    (set, get) => ({
      incident: { id: "INC-20260929-03", title: "滨江站区间积水停运", status: "处置中", startedAt: new Date(Date.now() - 35 * 60000).toISOString(), section: "中心站—东港站" },
      stations: seedStations,
      timeline: [
        { id: "e1", time: new Date(Date.now() - 35 * 60000).toISOString(), actor: "调度员", action: "启动事件", detail: "监测到滨江站区间水位超限，暂停双向行车", phase: "发现" },
        { id: "e2", time: new Date(Date.now() - 27 * 60000).toISOString(), actor: "车站值班员", action: "封闭车站", detail: "滨江站双向入口封闭并组织乘客出站", phase: "响应" }
      ],
      plans: seedPlans,
      role: "调度员",
      online: true,
      version: 1,
      pendingActions: [],
      setRole: (role) => set({ role }),
      setOnline: (online) => set({ online }),
      setStationStatus: (id, status, note) => {
        const state = get();
        const station = state.stations.find((s) => s.id === id);
        const isRecovery = status === "恢复中" || status === "正常";
        const dependsOn: string[] = [];
        if (isRecovery && station) {
          const execId = findExecuteForStation(state, station.name);
          if (execId) dependsOn.push(execId);
        }
        const cmd = makeCommand(get, "station.status", id, state.role, { status, note }, dependsOn);
        dispatch(cmd);
      },
      addTimeline: (entry) => {
        const cmd = makeCommand(get, "timeline.add", crypto.randomUUID(), get().role, {
          action: entry.action,
          detail: entry.detail,
          phase: entry.phase
        });
        dispatch(cmd);
      },
      addPlan: (plan) => {
        const cmd = makeCommand(get, "plan.add", crypto.randomUUID(), get().role, { plan });
        dispatch(cmd);
      },
      submitPlan: (id) => {
        const state = get();
        const dependsOn = [findCmd(state.pendingActions, "plan.add", id)?.id].filter(Boolean) as string[];
        dispatch(makeCommand(get, "plan.submit", id, state.role, {}, dependsOn));
      },
      approvePlan: (id, approver) => {
        const state = get();
        const dependsOn = [findCmd(state.pendingActions, "plan.submit", id)?.id].filter(Boolean) as string[];
        dispatch(makeCommand(get, "plan.approve", id, state.role, { approver }, dependsOn));
      },
      executePlan: (id) => {
        const state = get();
        const dependsOn = [findCmd(state.pendingActions, "plan.approve", id)?.id].filter(Boolean) as string[];
        dispatch(makeCommand(get, "plan.execute", id, state.role, {}, dependsOn));
      },
      undoPlan: (id) => {
        const state = get();
        dispatch(makeCommand(get, "plan.undoExecute", id, state.role, {}));
      },
      queueAction: (action, detail) => {
        dispatch(makeCommand(get, "timeline.add", crypto.randomUUID(), get().role, { action, detail, phase: "响应" }));
      },
      syncActions: () => {
        const d = cloneDraft(get());
        // 中心快照：合并开始时各对象的最后写入版本，用于判定命令是否覆盖中心新状态
        const snapshotLMV = new Map<string, number>();
        for (const s of d.stations) if (s.lastModifiedVersion) snapshotLMV.set(`station:${s.id}`, s.lastModifiedVersion);
        for (const p of d.plans) if (p.lastModifiedVersion) snapshotLMV.set(`plan:${p.id}`, p.lastModifiedVersion);
        const byId = new Map(d.pendingActions.map((c) => [c.id, c]));
        const appliedIds = new Set(d.pendingActions.filter((c) => c.status === "applied").map((c) => c.id));
        const pending = d.pendingActions.filter((c) => c.status === "pending");
        const order = topoSort(pending, byId);
        for (const cmd of order) {
          if (cmd.status !== "pending") continue;
          // 同一编号重复同步只生效一次
          if (appliedIds.has(cmd.id)) {
            cmd.status = "applied";
            continue;
          }
          let dep: QueuedCommand | undefined;
          let depFailed = false;
          for (const depId of cmd.dependsOn) {
            const dc = byId.get(depId);
            if (!dc) {
              depFailed = true;
              cmd.reason = `依赖命令 ${depId.slice(0, 6)} 不存在`;
              break;
            }
            if (dc.status === "applied") continue;
            if (dc.status === "pending") {
              dep = dc;
              break;
            }
            depFailed = true;
            cmd.reason = `依赖命令 ${depId.slice(0, 6)} 未生效（${dc.status === "stale" ? "已失效" : "已拒绝"}）`;
            break;
          }
          if (depFailed) {
            cmd.status = "stale";
            continue;
          }
          if (dep) {
            cmd.reason = `等待依赖命令 ${dep.id.slice(0, 6)} 先生效`;
            continue;
          }
          if (!hasPermission(cmd.actor, cmd.kind)) {
            cmd.status = "rejected";
            cmd.reason = `岗位越权：${cmd.actor} 无权${KIND_LABEL[cmd.kind]}`;
            continue;
          }
          const r = applyCommand(d, cmd, snapshotLMV);
          if (r.ok) {
            cmd.status = "applied";
            cmd.reason = undefined;
            appliedIds.add(cmd.id);
          } else {
            cmd.status = "stale";
            cmd.reason = r.reason;
          }
        }
        set({ ...d });
      }
    }),
    { name: "pair-wise-yf-47/incident", partialize: (s) => ({ ...s, pendingActions: s.pendingActions, version: s.version }) }
  )
);

/** 在线立即生效；弱网进入本地队列，等待恢复连接后按依赖合并 */
function dispatch(cmd: QueuedCommand) {
  const d = cloneDraft(useIncidentStore.getState());
  if (d.online) {
    const r = applyCommand(d, cmd);
    if (r.ok) {
      cmd.status = "applied";
      cmd.reason = undefined;
    } else {
      cmd.status = "rejected";
      cmd.reason = r.reason;
    }
  }
  d.pendingActions = [cmd, ...d.pendingActions];
  useIncidentStore.setState({ ...d });
}
