"use client";

import { useEffect, useMemo, useState } from "react";
import { App as AntApp, Badge, Button, Card, Descriptions, Form, Input, InputNumber, Modal, Select, Segmented, Space, Statistic, Table, Tag, Timeline, Tooltip } from "antd";
import { format } from "date-fns";
import { useForm, Controller } from "react-hook-form";
import { z } from "zod";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnsType } from "antd/es/table";
import { fetchStations } from "../lib/query";
import { MapPanel } from "../components/MapPanel";
import {
  useIncidentStore,
  projectLocalView,
  type Role,
  type ShuttlePlan,
  type Station,
  type StationStatus,
  type QueuedCommand,
  type CommandType,
  type BlockReason
} from "../store/incident";

const planSchema = z.object({ stations: z.array(z.string()).min(1, "至少选择一个接驳站"), vehicles: z.number().min(1).max(80), interval: z.number().min(2).max(30), operator: z.string().min(2), note: z.string().min(2) });
type PlanForm = z.infer<typeof planSchema>;

const COMMAND_LABELS: Record<CommandType, string> = {
  "station.status": "更新车站状态",
  "timeline.add": "追加处置时间线",
  "plan.add": "新建接驳计划",
  "plan.submit": "提交接驳计划",
  "plan.approve": "跨岗位确认",
  "plan.execute": "执行接驳计划",
  "plan.update": "调整接驳计划",
  "plan.revoke": "撤销接驳计划"
};

const REASON_COLOR: Partial<Record<BlockReason, string>> = {
  unauthorized: "red",
  "dependency-failed": "volcano",
  "stale-version": "orange",
  duplicate: "default",
  "target-missing": "red",
  precondition: "orange",
  "plan-invalidated": "purple"
};

const REASON_LABEL: Record<BlockReason, string> = {
  unauthorized: "岗位越权",
  "dependency-failed": "依赖未成功",
  "stale-version": "基础版本过期",
  duplicate: "重复编号",
  "target-missing": "目标缺失",
  precondition: "前置不满足",
  "plan-invalidated": "计划已失效"
};

function Dashboard() {
  const t = useTranslations();
  const { message } = AntApp.useApp();
  const queryClient = useQueryClient();
  const state = useIncidentStore();
  const { data: cachedStations } = useQuery({ queryKey: ["stations"], queryFn: fetchStations, enabled: state.online });
  const [modalOpen, setModalOpen] = useState(false);
  const [panel, setPanel] = useState<string>("总览");
  const [revokeTarget, setRevokeTarget] = useState<ShuttlePlan | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [updateTarget, setUpdateTarget] = useState<ShuttlePlan | null>(null);
  const [updateForm] = Form.useForm<{ vehicles: number; interval: number; note: string }>();
  const { control, handleSubmit, reset, formState: { errors } } = useForm<PlanForm>({ defaultValues: { stations: ["滨江站", "会展中心站"], vehicles: 8, interval: 6, operator: "东城公交", note: "优先疏运站外滞留乘客" } });

  useEffect(() => { if (!state.online) queryClient.cancelQueries({ queryKey: ["stations"] }); }, [state.online, queryClient]);

  // 断网期间把本地待处理命令乐观叠加到中心快照上；恢复后 syncQueue 按依赖合并
  const view = useMemo(() => (
    state.online
      ? { stations: state.stations, plans: state.plans, timeline: state.timeline }
      : projectLocalView({ stations: state.stations, plans: state.plans, timeline: state.timeline, incident: state.incident }, state.queue)
  ), [state.online, state.stations, state.plans, state.timeline, state.queue, state.incident]);

  const pendingCount = state.queue.filter((item) => item.status === "pending").length;
  const blockedCount = state.queue.filter((item) => item.status === "blocked").length;

  const targetName = (target: string): string => {
    if (target.startsWith("station:")) return view.stations.find((item) => item.id === target.split(":")[1])?.name ?? target;
    if (target.startsWith("plan:")) return `计划 ${target.split(":")[1].slice(0, 6)}`;
    return "处置时间线";
  };

  const stationColumns: ColumnsType<Station> = [
    { title: "车站", dataIndex: "name" },
    { title: "区段", dataIndex: "section" },
    { title: "状态", dataIndex: "status", render: (value: StationStatus) => <Tag color={value === "封闭" ? "red" : value === "限流" ? "orange" : value === "恢复中" ? "blue" : "green"}>{value}</Tag> },
    { title: "滞留风险", dataIndex: "passengerRisk", render: (value) => <Badge status={value === "高" ? "error" : value === "中" ? "warning" : "success"} text={value} /> },
    { title: "现场说明", dataIndex: "note" },
    { title: "版本 / 更新", dataIndex: "version", width: 120, render: (value: number, record) => <Tooltip title={`基础版本 v${value}，断网命令按此版本做并发校验`}><Tag>v{value}</Tag><span className="ts">{format(new Date(record.updatedAt), "HH:mm:ss")}</span></Tooltip> },
    { title: "处置", render: (_, record) => <Space><Button size="small" disabled={state.role === "客服主管"} onClick={() => state.setStationStatus(record.id, "限流")}>限流</Button><Button size="small" disabled={state.role === "客服主管"} danger={record.status !== "封闭"} onClick={() => state.setStationStatus(record.id, record.status === "封闭" ? "恢复中" : "封闭")}>{record.status === "封闭" ? "恢复中" : "封闭"}</Button></Space> }
  ];

  const submitPlan = (values: PlanForm) => { const parsed = planSchema.safeParse(values); if (!parsed.success) return; state.addPlan(parsed.data); setModalOpen(false); reset(); message.success(state.online ? "计划草稿已保存" : "计划已进入断网队列，恢复后按依赖合并"); };

  const openUpdate = (plan: ShuttlePlan) => { setUpdateTarget(plan); updateForm.setFieldsValue({ vehicles: plan.vehicles, interval: plan.interval, note: plan.note }); };
  const submitUpdate = async () => {
    if (!updateTarget) return;
    const values = await updateForm.validateFields();
    state.updatePlan(updateTarget.id, values);
    setUpdateTarget(null);
    message.success(state.online ? "接驳计划已更新，依赖它的车站恢复已失效重算" : "调整命令已进入断网队列");
  };
  const submitRevoke = () => {
    if (!revokeTarget || revokeReason.trim().length < 2) { message.warning("请填写撤销原因"); return; }
    state.revokePlan(revokeTarget.id, revokeReason.trim());
    setRevokeTarget(null);
    setRevokeReason("");
    message.success(state.online ? "接驳计划已撤销，下游动作不再套用旧结果" : "撤销命令已进入断网队列");
  };

  const onSync = () => {
    const report = state.syncQueue();
    if (report.applied) message.success(`合并完成：${report.applied} 条生效，${report.blocked} 条留在待处理，${report.skipped} 条重复跳过`);
    else message.info(`合并完成：${report.blocked} 条留在待处理，${report.skipped} 条重复跳过`);
  };

  const queueColumns: ColumnsType<QueuedCommand> = [
    { title: "编号", dataIndex: "id", width: 92, render: (value: string) => <Tooltip title={value}><code>{value.slice(0, 8)}</code></Tooltip> },
    { title: "动作 / 目标", render: (_, record) => <div className="cell-stack"><b>{COMMAND_LABELS[record.type]}</b><span className="ts">{targetName(record.target)}</span></div> },
    { title: "发起岗位", dataIndex: "actor", width: 110, render: (value: Role) => <Tag>{value}</Tag> },
    { title: "基础版本", dataIndex: "baseVersion", width: 90, render: (value: number) => <Tag>v{value}</Tag> },
    { title: "依赖命令", dataIndex: "dependsOn", width: 120, render: (value?: string) => value ? <Tooltip title={value}><code>{(value.includes("#exec@") ? value.split("#exec@")[1] : value).slice(0, 8)}</code></Tooltip> : <span className="ts">无</span> },
    { title: "状态", dataIndex: "status", width: 100, render: (value: QueuedCommand["status"], record) => value === "applied" ? <Tag color="green">已生效</Tag> : value === "blocked" ? <Tooltip title={record.reasonDetail}><Tag color={REASON_COLOR[record.reason ?? "precondition"]}>{REASON_LABEL[record.reason ?? "precondition"]}</Tag></Tooltip> : <Tag color="blue">待处理</Tag> },
    { title: "拦截原因", dataIndex: "reasonDetail", render: (value?: string) => value ? <span className="reason">{value}</span> : <span className="ts">—</span> },
    { title: "时间", dataIndex: "time", width: 92, render: (value: string) => format(new Date(value), "HH:mm:ss") },
    {
      title: "操作", width: 150, render: (_, record) => record.status === "applied"
        ? <span className="ts">已入中心快照</span>
        : <Space>
            {record.status === "blocked" && <Button size="small" type="link" onClick={() => { state.rebaseCommand(record.id); message.loading("已基于最新快照重发该命令"); }}>重发</Button>}
            <Button size="small" type="link" danger onClick={() => state.discardCommand(record.id)}>放弃</Button>
          </Space>
    }
  ];

  return <div className="shell">
    <aside className="side">
      <div className="brand"><b>RAIL OPS</b><span>应急协同</span></div>
      <nav>{["总览", "事件时间线", "接驳计划", "确认中心"].map((item) => <button className={panel === item ? "active" : ""} key={item} onClick={() => setPanel(item)}>{item}{item === "确认中心" && pendingCount > 0 ? `（${pendingCount}）` : ""}</button>)}</nav>
      <div className="side-status"><small>系统连接</small><b className={state.online ? "ok" : "warn"}>{state.online ? "在线" : "弱网降级"}</b><span>命令日志 {state.commandLog.length} 条</span></div>
    </aside>
    <main>
      <header><div><small>{state.incident.id} · 启动于 {format(new Date(state.incident.startedAt), "HH:mm")}</small><h1>{t("title")}</h1><p>{t("subtitle")}</p></div><Space><Segmented value={state.online} onChange={(value) => state.setOnline(Boolean(value))} options={[{ label: "在线", value: true }, { label: "弱网", value: false }]} /><Select<Role> value={state.role} onChange={state.setRole} options={["调度员", "车站值班员", "公交接驳负责人", "客服主管"].map((value) => ({ value: value as Role, label: `角色：${value}` }))} /></Space></header>
      <section className="metrics"><Card><Statistic title="事件状态" value={state.incident.status} /></Card><Card><Statistic title="受影响车站" value={view.stations.filter((item) => item.status !== "正常").length} suffix="座" /></Card><Card><Statistic title="待确认计划" value={view.plans.filter((item) => item.status === "待确认").length} /></Card><Card><Statistic title="待处理 / 已拦截" value={pendingCount} suffix={`/ ${blockedCount}`} /></Card></section>
      {!state.online && <div className="degrade">当前处于弱网降级模式，视图由中心缓存叠加本地待处理命令生成。每条命令记录目标对象、发起岗位、基础版本与依赖命令；恢复连接后按命令依赖合并，同编号只生效一次。</div>}
      {panel === "总览" && <section className="overview">
        <Card title={t("stations")} className="wide"><Table rowKey="id" dataSource={state.online && cachedStations?.length ? cachedStations : view.stations} columns={stationColumns} pagination={false} size="small" scroll={{ x: 820 }} /></Card>
        <Card title="受影响区段" className="map-card"><MapPanel stations={view.stations} plans={view.plans.filter((plan) => plan.status === "待确认" || plan.status === "已确认" || plan.status === "已执行")} /></Card>
      </section>}
      {panel === "事件时间线" && <Card title="处置时间线（随最终车站状态追加）" extra={<Space><Select value="响应" options={[{value:"响应"},{value:"接驳"},{value:"恢复"}]} /><Button type="primary" onClick={() => state.addTimeline({ action: "更新处置", detail: "现场处置信息已同步至协同工作台", phase: "响应" })}>添加处置记录</Button></Space>}><div className="timeline-grid"><Timeline items={view.timeline.map((item) => ({ color: item.phase === "恢复" ? "green" : item.phase === "接驳" ? "blue" : "red", children: <div><b>{item.action}</b><Tag>{item.actor}</Tag><p>{item.detail}</p><small>{format(new Date(item.time), "MM-DD HH:mm:ss")} · {item.phase}</small></div> }))} /><Card size="small" title="处置检查"><p>车站封闭与广播口径已确认。</p><p>接驳车辆到场后需调度员和公交负责人双方确认。</p><p>恢复行车前检查区间水位和站台安全；车站恢复依赖接驳计划成功执行。</p></Card></div></Card>}
      {panel === "接驳计划" && <Card title="公交接驳计划" extra={<Button type="primary" disabled={state.role !== "公交接驳负责人" && state.role !== "调度员"} onClick={() => setModalOpen(true)}>新建计划</Button>}><Table rowKey="id" pagination={false} dataSource={view.plans} columns={[{title:"接驳站",dataIndex:"stations",render:(v:string[])=>v.join(" → ")},{title:"车辆",dataIndex:"vehicles"},{title:"间隔",dataIndex:"interval",render:(v:number)=>`${v} 分钟`},{title:"运营方",dataIndex:"operator"},{title:"确认",dataIndex:"approvals",render:(v:string[])=>v.length? v.map((x)=><Tag key={x} color="green">{x}</Tag>) : <Tag>未确认</Tag>},{title:"版本",dataIndex:"version",render:(v:number)=><Tag>v{v}</Tag>},{title:"状态",dataIndex:"status",render:(v)=> <Tag color={v==="已确认"||v==="已执行"?"green":v==="待确认"?"orange":v==="已撤销"?"red":"default"}>{v}</Tag>},{title:"操作",render:(_,record:ShuttlePlan)=><Space><Button size="small" disabled={record.status!=="草稿"} onClick={()=>state.submitPlan(record.id)}>提交确认</Button><Button size="small" disabled={record.status!=="待确认"||state.role==="客服主管"} onClick={()=>state.approvePlan(record.id)}>确认</Button><Button size="small" type="primary" disabled={record.status!=="已确认"} onClick={()=>state.executePlan(record.id)}>执行</Button><Button size="small" disabled={record.status==="草稿"||record.status==="已撤销"||(state.role!=="调度员"&&state.role!=="公交接驳负责人")} onClick={()=>openUpdate(record)}>调整</Button><Button size="small" danger disabled={(record.status!=="已确认"&&record.status!=="已执行")||(state.role!=="调度员"&&state.role!=="公交接驳负责人")} onClick={()=>setRevokeTarget(record)}>撤销</Button></Space>}]} /></Card>}
      {panel === "确认中心" && <Space direction="vertical" size={16} style={{ display: "flex" }}>
        <Card title="跨岗位确认"><Timeline items={view.plans.map((plan) => ({ children: <div className="approval"><b>{plan.stations.join(" → ")}</b><Tag color={plan.status === "已撤销" ? "red" : undefined}>{plan.status}</Tag><Tag>v{plan.version}</Tag><p>{plan.vehicles} 辆，间隔 {plan.interval} 分钟，{plan.note}</p><small>已确认：{plan.approvals.join("、") || "暂无"}</small></div> }))} /></Card>
        <Card title="断网命令队列（与中心快照按命令依赖合并）" extra={<Space><Descriptions size="small" column={3} items={[{ key: "pending", label: "待处理", children: pendingCount }, { key: "blocked", label: "已拦截", children: blockedCount }, { key: "applied", label: "已生效", children: state.queue.filter((item) => item.status === "applied").length }]} /><Button type="primary" disabled={pendingCount === 0} onClick={onSync}>{state.online ? "按命令依赖合并断网队列" : "恢复连接并合并"}</Button></Space>}>
          <Table rowKey="id" pagination={false} size="small" dataSource={[...state.queue].sort((a, b) => b.time.localeCompare(a.time))} columns={queueColumns} scroll={{ x: 1080 }} locale={{ emptyText: "暂无断网命令" }} />
        </Card>
        {state.mergeRecords.length > 0 && <Card size="small" title={`最近合并记录（${state.mergeRecords.length}）`}><Timeline items={state.mergeRecords.slice(0, 8).map((record) => ({ color: record.result === "applied" ? "green" : record.result === "skipped" ? "gray" : "red", children: <div><b>{COMMAND_LABELS[record.type]}</b><Tag>{record.actor}</Tag><p>{record.detail}</p><small>{format(new Date(record.time), "MM-dd HH:mm:ss")} · {record.commandId.slice(0, 8)}</small></div> }))} /></Card>}
      </Space>}
    </main>
    <Modal title="新建接驳计划" open={modalOpen} onCancel={() => setModalOpen(false)} onOk={handleSubmit(submitPlan)} okText="保存草稿"><Form layout="vertical"><Form.Item label="接驳站" validateStatus={errors.stations ? "error" : ""} help={errors.stations?.message}><Controller name="stations" control={control} render={({ field }) => <Select mode="multiple" {...field} options={state.stations.map((item) => ({ value: item.name, label: item.name }))} />} /></Form.Item><Space><Form.Item label="车辆数"><Controller name="vehicles" control={control} render={({ field }) => <InputNumber {...field} min={1} />} /></Form.Item><Form.Item label="发车间隔"><Controller name="interval" control={control} render={({ field }) => <InputNumber {...field} min={2} addonAfter="分钟" />} /></Form.Item></Space><Form.Item label="运营方"><Controller name="operator" control={control} render={({ field }) => <Input {...field} />} /></Form.Item><Form.Item label="计划说明"><Controller name="note" control={control} render={({ field }) => <Input.TextArea {...field} />} /></Form.Item></Form></Modal>
    <Modal title="调整接驳计划（更新后下游恢复立即失效重算）" open={!!updateTarget} onCancel={() => setUpdateTarget(null)} onOk={submitUpdate} okText="提交调整">
      <Form form={updateForm} layout="vertical">
        <Space><Form.Item label="车辆数" name="vehicles" rules={[{ required: true }]}><InputNumber min={1} max={80} /></Form.Item><Form.Item label="发车间隔（分钟）" name="interval" rules={[{ required: true }]}><InputNumber min={2} max={30} /></Form.Item></Space>
        <Form.Item label="调整说明" name="note" rules={[{ required: true, message: "请填写调整说明" }, { min: 2 }]}><Input.TextArea /></Form.Item>
      </Form>
    </Modal>
    <Modal title="撤销接驳计划" open={!!revokeTarget} onCancel={() => { setRevokeTarget(null); setRevokeReason(""); }} onOk={submitRevoke} okText="确认撤销" okButtonProps={{ danger: true }}>
      <p>计划 <b>{revokeTarget?.stations.join(" → ")}</b> 撤销后，基于它的车站恢复等下游动作不能继续套用旧结果，将留在待处理队列标明原因；其他不相干命令保留。</p>
      <Input.TextArea rows={3} placeholder="请填写撤销原因（至少 2 个字）" value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} />
    </Modal>
  </div>;
}

export default function Page() { return <AntApp><Dashboard /></AntApp>; }
