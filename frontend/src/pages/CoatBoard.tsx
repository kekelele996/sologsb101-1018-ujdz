/**
 * /coats 髹涂道次编排 ——工序管理员侧
 * 拖拽调整道次先后、批量改漆种与状态、同器型自动带出上次漆种与间隔建议；
 * 对挂到道次的超标荫房记录做复检并定结论；记账本道次荫干时段与值守侧对账；重算荫干时长建议。
 * 跨侧只读 Room；本页只写 Coat（改漆种 / 重排 / 推进均不触碰荫房与打磨表）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  HolderOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import {
  COAT_RECHECK_COLOR,
  COAT_RECHECK_LABEL,
  COAT_RECHECK_OPTIONS,
  COAT_STATE_LABEL,
  COAT_STATE_OPTIONS,
  COLOR_NAME_OPTIONS,
  PAINT_TYPE_LABEL,
  PAINT_TYPE_OPTIONS,
  createEmptyCoatDraft,
  dryingAdviceValid,
  type Coat,
  type CoatDraft,
  type CoatRecheckConclusion,
  type CoatState,
  type PaintType,
} from '@/types/coat';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { RECONCILE_COLOR, RECONCILE_LABEL } from '@/types/room';
import { suggestIntervalHours } from '@/utils/humidity';
import { coatRecheckView, effectiveReconcile, type CoatRecheckView } from '@/utils/reconcile';

const FILTER_KEYS = ['paintType', 'state'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'paintType', label: '漆种', options: PAINT_TYPE_OPTIONS },
  { key: 'state', label: '状态', options: COAT_STATE_OPTIONS },
];

interface RecheckFormValues {
  conclusion: Exclude<CoatRecheckConclusion, 'none'>;
  note: string;
}

export default function CoatBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CoatDraft>();
  const [recheckForm] = Form.useForm<RecheckFormValues>();

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const rooms = useRoomStore((state) => state.rooms);
  const createCoat = useCoatStore((state) => state.createCoat);
  const updateCoat = useCoatStore((state) => state.updateCoat);
  const removeCoat = useCoatStore((state) => state.removeCoat);
  const batchUpdate = useCoatStore((state) => state.batchUpdate);
  const advanceState = useCoatStore((state) => state.advanceState);
  const setRecheck = useCoatStore((state) => state.setRecheck);
  const recomputeDryingAdvice = useCoatStore((state) => state.recomputeDryingAdvice);
  const reorderCoats = useCoatStore((state) => state.reorderCoats);
  const nextSeq = useCoatStore((state) => state.nextSeq);
  const suggestForBody = useCoatStore((state) => state.suggestForBody);

  const { progressOf, currentCoatText, totals } = useCoatProgress();
  const url = useFilterQuery(FILTER_KEYS);

  const [editing, setEditing] = useState<Coat | null>(null);
  const [open, setOpen] = useState(false);
  const [recheckTarget, setRecheckTarget] = useState<Coat | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchPaint, setBatchPaint] = useState<PaintType>('color');
  const [batchState, setBatchState] = useState<CoatState>('coated');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  useEffect(() => {
    if (!currentBodyId && bodies.length > 0) setCurrentBodyId(bodies[0]!.id);
  }, [bodies, currentBodyId, setCurrentBodyId]);

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  /** 道次复检视图：挂在本道次的超标荫房记录 + 管理员复检结论，全部只读派生 */
  const recheckMap = useMemo(() => {
    const map = new Map<string, CoatRecheckView>();
    const grouped = new Map<string, typeof rooms>();
    rooms.forEach((room) => {
      if (!room.coatId) return;
      const list = grouped.get(room.coatId) ?? [];
      list.push(room);
      grouped.set(room.coatId, list);
    });
    coats.forEach((coat) => map.set(coat.id, coatRecheckView(coat, grouped.get(coat.id) ?? [])));
    return map;
  }, [coats, rooms]);

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const paintTypes = url.values.paintType ?? [];
    const states = url.values.state ?? [];
    return bodyCoats.filter((coat) => {
      if (keyword.length > 0) {
        const haystack = `${coat.colorName}${coat.coatDate}${coat.thicknessUm}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (paintTypes.length > 0 && !paintTypes.includes(coat.paintType)) return false;
      if (states.length > 0 && !states.includes(coat.state)) return false;
      return true;
    });
  }, [bodyCoats, url.keyword, url.values]);

  const suggestion = bodyId.length > 0 ? suggestForBody(bodyId) : null;
  const stat = bodyId.length > 0 ? progressOf(bodyId) : null;
  const bodySuspended = useMemo(() => {
    const ids = new Set(bodyCoats.map((coat) => coat.id));
    return rooms.filter(
      (room) => room.coatId !== null && ids.has(room.coatId) &&
        effectiveReconcile(room, coats.find((coat) => coat.id === room.coatId)) === 'suspended',
    ).length;
  }, [bodyCoats, coats, rooms]);

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先选择或新建胎体');
      return;
    }
    setEditing(null);
    form.setFieldsValue({
      ...createEmptyCoatDraft(bodyId, nextSeq(bodyId)),
      paintType: suggestion?.paintType ?? 'raw',
    });
    setOpen(true);
  };

  const openEdit = (coat: Coat): void => {
    setEditing(coat);
    form.setFieldsValue({
      bodyId: coat.bodyId,
      seq: coat.seq,
      paintType: coat.paintType,
      colorName: coat.colorName,
      coatDate: coat.coatDate,
      thicknessUm: coat.thicknessUm,
      state: coat.state,
      dryingFrom: coat.dryingFrom,
      dryingTo: coat.dryingTo,
      // 复检结论 / 荫干建议不在编辑表单内：只能由专用动作修改，避免被表单整体冲掉
      recheckStatus: coat.recheckStatus,
      recheckNote: coat.recheckNote,
      recheckAt: coat.recheckAt,
      dryingAdviceHours: coat.dryingAdviceHours,
      dryingAdvicePaintType: coat.dryingAdvicePaintType,
      dryingAdviceAt: coat.dryingAdviceAt,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      // 只提交编排字段；updateCoat 与存量记录合并，复检结论 / 建议不会被冲掉
      await updateCoat(editing.id, {
        seq: values.seq,
        paintType: values.paintType,
        colorName: values.colorName,
        coatDate: values.coatDate,
        thicknessUm: values.thicknessUm,
        state: values.state,
        dryingFrom: values.dryingFrom,
        dryingTo: values.dryingTo,
      });
      message.success(
        values.paintType !== editing.paintType
          ? `已更新第 ${values.seq} 道；漆种改动后荫干建议已失效，请重新计算`
          : `已更新第 ${values.seq} 道工序`,
      );
    } else {
      const draft: CoatDraft = { ...createEmptyCoatDraft(bodyId, nextSeq(bodyId)), ...values, bodyId };
      await createCoat(draft);
      message.success(`已新增第 ${draft.seq} 道工序（可在保存后重算荫干建议）`);
    }
    setOpen(false);
  };

  const openRecheck = (coat: Coat): void => {
    setRecheckTarget(coat);
    recheckForm.setFieldsValue({
      conclusion: coat.recheckStatus === 'none' ? 'pass' : coat.recheckStatus,
      note: coat.recheckNote,
    });
  };

  const submitRecheck = async (): Promise<void> => {
    if (!recheckTarget) return;
    const values = await recheckForm.validateFields();
    await setRecheck(recheckTarget.id, values.conclusion, values.note);
    message.success(`已记录第 ${recheckTarget.seq} 道复检结论：${COAT_RECHECK_LABEL[values.conclusion]}`);
    setRecheckTarget(null);
  };

  const handleRecompute = async (coat: Coat): Promise<void> => {
    const ok = await recomputeDryingAdvice(coat.id);
    if (ok) message.success(`已按最近荫房记录重算第 ${coat.seq} 道荫干建议`);
    else message.warning('该胎体还没有荫房记录，无法重算；请先由值守登记温湿度');
  };

  /** 拖拽重排：按落点重排并落库重编号（不动打磨 / 荫房） */
  const handleDrop = async (targetId: string): Promise<void> => {
    setOverId(null);
    if (!dragId || dragId === targetId || !bodyId) {
      setDragId(null);
      return;
    }
    const ids = bodyCoats.map((coat) => coat.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved as string);
    await reorderCoats(bodyId, ids);
    setDragId(null);
    message.success('道次顺序已更新并重编号（打磨与荫房记录按道次 id 挂接，不受影响）');
  };

  /** 状态推进校验：前一道未完成时禁止进入下一道 */
  const handleAdvance = async (coat: Coat): Promise<void> => {
    const previous = bodyCoats.find((item) => item.seq === coat.seq - 1);
    if (previous && previous.state !== 'done') {
      message.warning(`第 ${previous.seq} 道尚未完成，禁止进入第 ${coat.seq} 道`);
      return;
    }
    await advanceState(coat.id);
  };

  /** 道次荫干时段对账汇总（只读派生） */
  const reconcileSummary = (coat: Coat): { matched: number; suspended: number; pending: number } => {
    const result = { matched: 0, suspended: 0, pending: 0 };
    rooms
      .filter((room) => room.coatId === coat.id)
      .forEach((room) => {
        result[effectiveReconcile(room, coat)] += 1;
      });
    return result;
  };

  const columns: ColumnsType<Coat> = [
    {
      title: '',
      dataIndex: 'drag',
      width: 44,
      render: (_value, record) => (
        <Tooltip title="按住拖动可调整道次先后">
          <span
            className="gb-drag-handle"
            draggable
            onDragStart={() => setDragId(record.id)}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
          >
            <HolderOutlined />
          </span>
        </Tooltip>
      ),
    },
    {
      title: '道次',
      dataIndex: 'seq',
      width: 150,
      sorter: (a, b) => a.seq - b.seq,
      render: (seq: number, record) => (
        <StageTag state={record.state} seq={seq} recheckView={recheckMap.get(record.id)} />
      ),
    },
    { title: '漆种', dataIndex: 'paintType', width: 90, render: (value: PaintType) => <Tag>{PAINT_TYPE_LABEL[value]}</Tag> },
    { title: '色名', dataIndex: 'colorName', width: 100 },
    { title: '涂刷日期', dataIndex: 'coatDate', width: 110, sorter: (a, b) => a.coatDate.localeCompare(b.coatDate) },
    {
      title: '湿膜厚度',
      dataIndex: 'thicknessUm',
      width: 100,
      render: (value: number) => `${value} μm`,
    },
    {
      title: '荫干建议',
      key: 'advice',
      width: 170,
      render: (_value, record) => {
        const valid = dryingAdviceValid(record);
        return (
          <Space size={4} direction="vertical" style={{ rowGap: 0 }}>
            {record.dryingAdviceHours === null ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>尚无建议</Typography.Text>
            ) : valid ? (
              <Typography.Text style={{ fontSize: 12 }}>建议荫干 {record.dryingAdviceHours} 小时</Typography.Text>
            ) : (
              <Tooltip title="漆种已改动，旧建议依据的是原漆种，需重新计算">
                <Tag color="warning">建议已失效（漆种已改）</Tag>
              </Tooltip>
            )}
            <Button size="small" type="link" style={{ padding: 0, height: 18, fontSize: 12 }} onClick={() => void handleRecompute(record)}>
              <ReloadOutlined /> 重新计算
            </Button>
          </Space>
        );
      },
    },
    {
      title: '时段对账',
      key: 'reconcile',
      width: 150,
      render: (_value, record) => {
        const summary = reconcileSummary(record);
        const total = summary.matched + summary.suspended + summary.pending;
        if (total === 0) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>无挂接记录</Typography.Text>;
        return (
          <Space size={2} wrap>
            {summary.matched > 0 ? <Tag color={RECONCILE_COLOR.matched}>{RECONCILE_LABEL.matched} {summary.matched}</Tag> : null}
            {summary.suspended > 0 ? <Tag color={RECONCILE_COLOR.suspended}>{RECONCILE_LABEL.suspended} {summary.suspended}</Tag> : null}
            {summary.pending > 0 ? <Tag color={RECONCILE_COLOR.pending}>{RECONCILE_LABEL.pending} {summary.pending}</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 250,
      render: (_value, record) => {
        const view = recheckMap.get(record.id);
        return (
          <Space size={4} wrap>
            <Button size="small" type="link" onClick={() => void handleAdvance(record)}>
              推进状态
            </Button>
            <Tooltip
              title={
                view?.pending
                  ? `挂到本道次的 ${view.overCount} 条超标荫房记录待复检，复检结论由管理员定`
                  : record.recheckStatus === 'none'
                    ? '本道次暂无超标荫房记录'
                    : `复检结论：${COAT_RECHECK_LABEL[record.recheckStatus]}`
              }
            >
              <Button
                size="small"
                type="link"
                danger={Boolean(view?.pending)}
                icon={<SafetyCertificateOutlined />}
                onClick={() => openRecheck(record)}
              >
                {view?.pending ? '复检' : record.recheckStatus === 'none' ? '登记复检' : '改复检'}
              </Button>
            </Tooltip>
            <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Popconfirm
              title="删除该道次"
              description="删除后其余道次自动重编号；已挂接的荫房 / 打磨记录保留留底。"
              okText="确认"
              cancelText="取消"
              onConfirm={() => void removeCoat(record.id).then(() => message.success('已删除该道次'))}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const watchedPaint = Form.useWatch('paintType', form) as PaintType | undefined;
  const modalCoat = editing ? coats.find((coat) => coat.id === editing.id) ?? editing : null;

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>髹涂道次编排（管理员）</h2>
          <p>逐道登记漆种与色名，拖拽调整先后；对越界挂起的荫房记录复检定结论，记账荫干时段并对账。</p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 220 }}
            placeholder="选择胎体"
            value={bodyId || undefined}
            options={bodies.map((body) => ({
              value: body.id,
              label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
            }))}
            onChange={(value: string) => setCurrentBodyId(value)}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增道次
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="道次总数" value={stat?.coatTotal ?? 0} suffix="道" tone="primary" />
        <StatBadge label="完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="当前道次" value={stat?.currentSeq ? `第 ${stat.currentSeq} 道` : '已完工'} tone="warning" />
        <StatBadge label="待复检" value={totals.recheck} suffix="道" tone="danger" />
        <StatBadge label="对账挂起" value={totals.suspended} suffix="条" tone="danger" />
        <StatBadge label="当前胎体挂起" value={bodySuspended} suffix="条" tone="warning" />
        <StatBadge label="荫干等待" value={stat?.dryingHours ?? 0} suffix="小时" tone="info" />
      </div>

      {suggestion && suggestion.sourceCode ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 14 }}
          message={`同器型参考：${suggestion.sourceCode} 上次采用${suggestion.sourceColor || '同漆种'}，建议下一道用「${
            PAINT_TYPE_LABEL[suggestion.paintType]
          }」，间隔约 ${suggestion.intervalHours} 小时`}
          action={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              onClick={() => {
                form.setFieldsValue({ paintType: suggestion.paintType });
                message.success('已带出建议漆种（保存后旧荫干建议会失效，可重新计算）');
              }}
            >
              带出建议
            </Button>
          }
        />
      ) : null}

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={url.reset}
        keywordPlaceholder="搜索色名 / 日期 / 厚度…"
        actions={
          <Space size={6} wrap>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchPaint}
              options={[...PAINT_TYPE_OPTIONS]}
              onChange={(value: PaintType) => setBatchPaint(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { paintType: batchPaint }).then(() => {
                  message.success(`已批量改为${PAINT_TYPE_LABEL[batchPaint]}；这些道次的荫干建议已失效，请重算`);
                  setSelectedIds([]);
                })
              }
            >
              批量改漆种
            </Button>
            <Select
              size="small"
              style={{ width: 120 }}
              value={batchState}
              options={[...COAT_STATE_OPTIONS]}
              onChange={(value: CoatState) => setBatchState(value)}
            />
            <Button
              size="small"
              disabled={selectedIds.length === 0}
              onClick={() =>
                void batchUpdate(selectedIds, { state: batchState }).then(() => {
                  message.success(`已批量改为${COAT_STATE_LABEL[batchState]}`);
                  setSelectedIds([]);
                })
              }
            >
              批量改状态
            </Button>
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={bodyCoats.length === 0 ? '该胎体尚未编排髹涂道次' : '当前筛选条件下没有道次'}
            description={
              bodyCoats.length === 0
                ? '从第一道生漆打底开始，逐道登记漆种、色名与湿膜厚度。'
                : '试着调整漆种或状态筛选条件。'
            }
            actionText="新增道次"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={url.reset}
            size="small"
          />
        ) : (
          <Table<Coat>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={filtered}
            onRow={(record) => ({
              onDragOver: (event) => {
                event.preventDefault();
                setOverId(record.id);
              },
              onDrop: () => void handleDrop(record.id),
              className: overId === record.id && dragId !== record.id ? 'gb-row-drop-target' : undefined,
            })}
            rowSelection={{
              selectedRowKeys: selectedIds,
              onChange: (keys) => setSelectedIds(keys.map((key) => String(key))),
            }}
            rowClassName={(record) => (record.id === dragId ? 'gb-row-dragging' : '')}
          />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        当前胎体进度：{bodyId ? currentCoatText(bodyId) : '未选择胎体'}
      </Typography.Text>

      <Modal
        open={open}
        title={editing ? `编辑第 ${editing.seq} 道` : '新增髹涂道次'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="seq" label="道次序号" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="paintType" label="漆种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...PAINT_TYPE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="colorName" label="色名" rules={[{ required: true, message: '请填写色名' }]} style={{ flex: 1 }}>
              <Select
                showSearch
                options={COLOR_NAME_OPTIONS.map((name) => ({ value: name, label: name }))}
                placeholder="如：朱红"
              />
            </Form.Item>
            <Form.Item name="coatDate" label="涂刷日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="thicknessUm" label="湿膜厚度（μm）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={500} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="state" label="状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...COAT_STATE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="dryingFrom" label="记账入荫时间（与值守对账用）" style={{ flex: 1 }}>
              <Input type="datetime-local" />
            </Form.Item>
            <Form.Item name="dryingTo" label="记账出荫时间" style={{ flex: 1 }}>
              <Input type="datetime-local" />
            </Form.Item>
          </Space>
          {modalCoat ? (
            <Alert
              type={dryingAdviceValid(modalCoat) ? 'success' : 'warning'}
              showIcon
              style={{ marginBottom: 10 }}
              message={
                dryingAdviceValid(modalCoat)
                  ? `当前建议荫干 ${modalCoat.dryingAdviceHours ?? '-'} 小时（依据${PAINT_TYPE_LABEL[modalCoat.paintType]}）`
                  : '漆种已改动，荫干时长建议已失效'
              }
              action={
                <Button size="small" icon={<ReloadOutlined />} onClick={() => void handleRecompute(modalCoat)}>
                  重新计算
                </Button>
              }
            />
          ) : null}
          <Alert
            type="info"
            showIcon
            message={`${PAINT_TYPE_LABEL[watchedPaint ?? 'raw']}在环境适宜时建议间隔约 ${suggestIntervalHours(
              watchedPaint ?? 'raw',
            )} 小时再进入下一道`}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
            复检结论由「复检」按钮单独登记，不在本表单内，改道次信息不会冲掉已定结论。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        open={recheckTarget !== null}
        title={recheckTarget ? `第 ${recheckTarget.seq} 道复检结论（管理员）` : ''}
        onCancel={() => setRecheckTarget(null)}
        onOk={() => void submitRecheck()}
        okText="保存结论"
        cancelText="取消"
        destroyOnClose
      >
        {recheckTarget ? (
          <Form form={recheckForm} layout="vertical" preserve={false}>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`本道次挂接 ${recheckMap.get(recheckTarget.id)?.overCount ?? 0} 条超标荫房记录；
                ${recheckTarget.recheckStatus === 'none' ? '尚未复检。' : `当前结论：${COAT_RECHECK_LABEL[recheckTarget.recheckStatus]}。`}
                结论保存后，值守后补的超标记录只会再挂「待复检」，不会改写本结论。`}
            />
            <Form.Item name="conclusion" label="复检结论" rules={[{ required: true, message: '请选择复检结论' }]}>
              <Select options={[...COAT_RECHECK_OPTIONS]} />
            </Form.Item>
            <Form.Item name="note" label="复检说明">
              <Input.TextArea rows={3} placeholder="如：表面成膜正常，偏干未造成缺陷" />
            </Form.Item>
            <Tag color={COAT_RECHECK_COLOR[recheckTarget.recheckStatus]}>
              原结论：{COAT_RECHECK_LABEL[recheckTarget.recheckStatus]}
            </Tag>
          </Form>
        ) : null}
      </Modal>
    </div>
  );
}
