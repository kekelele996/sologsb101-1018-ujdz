/**
 * /coats 髹涂道次编排（管理员侧）
 * 拖拽调整道次先后、批量改漆种与状态、同器型自动带出上次漆种与间隔建议。
 * 管理员只管道次编排与推进：荫干时长建议随漆种 / 厚度改动失效重算；
 * 荫房越界挂起的复检项由管理员填写结论，值守侧不得改写。
 * 消费 Coat、Body、Recheck；复用 <StageTag>、<FilterBar>、<StatBadge>、<EmptyPanel>。
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
  Radio,
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
  ExperimentOutlined,
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
import { useRecheckStore } from '@/stores/recheckStore';
import {
  COAT_STATE_LABEL,
  COAT_STATE_OPTIONS,
  COLOR_NAME_OPTIONS,
  PAINT_TYPE_LABEL,
  PAINT_TYPE_OPTIONS,
  createEmptyCoatDraft,
  isDryingAdviceStale,
  type Coat,
  type CoatDraft,
  type CoatState,
  type PaintType,
} from '@/types/coat';
import { BODY_SHAPE_LABEL } from '@/types/body';
import {
  RECHECK_REASON_LABEL,
  RECHECK_STATUS_COLOR,
  RECHECK_STATUS_LABEL,
  type Recheck,
  type RecheckStatus,
} from '@/types/recheck';
import { computeDryingHours, suggestIntervalHours } from '@/utils/humidity';

const FILTER_KEYS = ['paintType', 'state'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'paintType', label: '漆种', options: PAINT_TYPE_OPTIONS },
  { key: 'state', label: '状态', options: COAT_STATE_OPTIONS },
];

export default function CoatBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<CoatDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const createCoat = useCoatStore((state) => state.createCoat);
  const updateCoat = useCoatStore((state) => state.updateCoat);
  const removeCoat = useCoatStore((state) => state.removeCoat);
  const batchUpdate = useCoatStore((state) => state.batchUpdate);
  const advanceState = useCoatStore((state) => state.advanceState);
  const reorderCoats = useCoatStore((state) => state.reorderCoats);
  const nextSeq = useCoatStore((state) => state.nextSeq);
  const suggestForBody = useCoatStore((state) => state.suggestForBody);
  const recomputeDryingAdvice = useCoatStore((state) => state.recomputeDryingAdvice);

  const rechecks = useRecheckStore((state) => state.rechecks);
  const resolveRecheck = useRecheckStore((state) => state.resolveRecheck);
  const reconcileDryingWindows = useRecheckStore((state) => state.reconcileDryingWindows);

  const { progressOf, currentCoatText, totals } = useCoatProgress();
  const url = useFilterQuery(FILTER_KEYS);

  const [editing, setEditing] = useState<Coat | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchPaint, setBatchPaint] = useState<PaintType>('color');
  const [batchState, setBatchState] = useState<CoatState>('coated');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  // 复检结论弹窗（管理员侧）
  const [recheckOpen, setRecheckOpen] = useState(false);
  const [recheckCoat, setRecheckCoat] = useState<Coat | null>(null);
  const [recheckStatus, setRecheckStatus] = useState<Exclude<RecheckStatus, 'pending'>>('passed');
  const [recheckConclusion, setRecheckConclusion] = useState('');
  const [recheckInspector, setRecheckInspector] = useState('');

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  useEffect(() => {
    if (!currentBodyId && bodies.length > 0) setCurrentBodyId(bodies[0]!.id);
  }, [bodies, currentBodyId, setCurrentBodyId]);

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  /** 道次 → 未决挂起数 */
  const pendingByCoat = useMemo(() => {
    const map = new Map<string, number>();
    rechecks.forEach((recheck) => {
      if (recheck.status === 'pending') map.set(recheck.coatId, (map.get(recheck.coatId) ?? 0) + 1);
    });
    return map;
  }, [rechecks]);

  /** 道次 → 最近一条挂起项（用于回显复检状态） */
  const latestByCoat = useMemo(() => {
    const map = new Map<string, Recheck>();
    rechecks.forEach((recheck) => {
      const prev = map.get(recheck.coatId);
      if (!prev || recheck.updatedAt > prev.updatedAt) map.set(recheck.coatId, recheck);
    });
    return map;
  }, [rechecks]);

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

  // 表单内荫干建议实时试算（保存时按漆种 + 厚度落库）
  const watchedPaintType = Form.useWatch('paintType', form) as PaintType | undefined;
  const watchedThickness = Form.useWatch('thicknessUm', form) as number | undefined;
  const liveDryingHours =
    watchedPaintType && typeof watchedThickness === 'number'
      ? computeDryingHours(watchedPaintType, watchedThickness)
      : null;

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
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const draft: CoatDraft = {
      bodyId,
      seq: values.seq,
      paintType: values.paintType,
      colorName: values.colorName,
      coatDate: values.coatDate,
      thicknessUm: values.thicknessUm,
      state: values.state,
      needRecheck: false,
      dryingHours: computeDryingHours(values.paintType, values.thicknessUm),
      dryingHoursPaintType: values.paintType,
    };
    if (editing) {
      await updateCoat(editing.id, draft);
      message.success(`已更新第 ${draft.seq} 道工序`);
    } else {
      await createCoat(draft);
      message.success(`已新增第 ${draft.seq} 道工序`);
    }
    setOpen(false);
  };

  /** 拖拽重排：按落点重排并落库重编号 */
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
    message.success('道次顺序已更新并重编号');
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

  /** 打开复检结论弹窗：列出该道次未决挂起项，管理员统一填写结论 */
  const openRecheck = (coat: Coat): void => {
    const pending = rechecks.filter((recheck) => recheck.coatId === coat.id && recheck.status === 'pending');
    if (pending.length === 0) {
      message.info('该道次没有待复检项');
      return;
    }
    setRecheckCoat(coat);
    setRecheckStatus('passed');
    setRecheckConclusion('');
    setRecheckInspector('');
    setRecheckOpen(true);
  };

  const submitRecheck = async (): Promise<void> => {
    if (!recheckCoat) return;
    const pending = rechecks.filter(
      (recheck) => recheck.coatId === recheckCoat.id && recheck.status === 'pending',
    );
    if (pending.length === 0) {
      message.info('该道次没有待复检项');
      setRecheckOpen(false);
      return;
    }
    if (!recheckInspector.trim()) {
      message.warning('请填写复检人');
      return;
    }
    if (recheckStatus === 'failed' && !recheckConclusion.trim()) {
      message.warning('需返工必须填写复检结论');
      return;
    }
    await Promise.all(
      pending.map((recheck) =>
        resolveRecheck(
          recheck.id,
          recheckStatus,
          recheckConclusion.trim() || (recheckStatus === 'passed' ? '复检通过' : ''),
          recheckInspector.trim(),
        ),
      ),
    );
    message.success(`第 ${recheckCoat.seq} 道复检结论已登记：${RECHECK_STATUS_LABEL[recheckStatus]}`);
    setRecheckOpen(false);
  };

  /** 荫干时段对账：比对道次建议荫干时长与归属荫房记录实际在房时长 */
  const handleReconcile = async (): Promise<void> => {
    const result = await reconcileDryingWindows();
    if (result.mismatched === 0) {
      message.success(`对账完成：${result.checked} 个在制道次荫干时段均相符`);
    } else {
      message.warning(`对账完成：${result.checked} 个道次中 ${result.mismatched} 个时段不符，已新挂起 ${result.created} 条待核`);
    }
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
      width: 110,
      sorter: (a, b) => a.seq - b.seq,
      render: (seq: number, record) => (
        <StageTag state={record.state} seq={seq} needRecheck={(pendingByCoat.get(record.id) ?? 0) > 0} />
      ),
    },
    { title: '漆种', dataIndex: 'paintType', width: 100, render: (value: PaintType) => <Tag>{PAINT_TYPE_LABEL[value]}</Tag> },
    { title: '色名', dataIndex: 'colorName', width: 120 },
    { title: '涂刷日期', dataIndex: 'coatDate', width: 130, sorter: (a, b) => a.coatDate.localeCompare(b.coatDate) },
    {
      title: '湿膜厚度',
      dataIndex: 'thicknessUm',
      width: 110,
      render: (value: number) => `${value} μm`,
    },
    {
      title: '荫干建议',
      key: 'dryingAdvice',
      width: 170,
      render: (_value, record) => {
        const stale = isDryingAdviceStale(record);
        return (
          <Space size={4} wrap>
            <Typography.Text>{record.dryingHours} 小时</Typography.Text>
            {stale ? <Tag color="warning">已失效</Tag> : null}
            <Tooltip title="按当前漆种与湿膜厚度重算荫干时长建议">
              <Button
                size="small"
                type="text"
                icon={<ReloadOutlined />}
                onClick={() => {
                  void recomputeDryingAdvice(record.id).then(() => message.success('荫干时长建议已重算'));
                }}
              />
            </Tooltip>
          </Space>
        );
      },
    },
    {
      title: '复检状态',
      key: 'recheck',
      width: 120,
      render: (_value, record) => {
        const pending = pendingByCoat.get(record.id) ?? 0;
        const latest = latestByCoat.get(record.id);
        if (pending > 0) {
          return (
            <Tag color={RECHECK_STATUS_COLOR.pending} icon={<SafetyCertificateOutlined />}>
              待复检 {pending}
            </Tag>
          );
        }
        if (latest) {
          return <Tag color={RECHECK_STATUS_COLOR[latest.status]}>{RECHECK_STATUS_LABEL[latest.status]}</Tag>;
        }
        return <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 280,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => void handleAdvance(record)}>
            推进状态
          </Button>
          <Button
            size="small"
            type="link"
            icon={<SafetyCertificateOutlined />}
            danger={(pendingByCoat.get(record.id) ?? 0) > 0}
            onClick={() => openRecheck(record)}
          >
            复检{(pendingByCoat.get(record.id) ?? 0) > 0 ? `（${pendingByCoat.get(record.id)}）` : ''}
          </Button>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该道次"
            description="删除后其余道次会自动重编号。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeCoat(record.id).then(() => message.success('已删除该道次'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const totalPending = totals.recheck;

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>髹涂道次编排</h2>
          <p>逐道登记漆种与色名，拖拽调整先后顺序；批量改漆种或状态，同器型自动带出上次做法。荫干时长建议随漆种失效重算。</p>
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
          <Button icon={<ExperimentOutlined />} onClick={() => void handleReconcile()}>
            荫干时段对账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增道次
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="道次总数" value={stat?.coatTotal ?? 0} suffix="道" tone="primary" />
        <StatBadge label="完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="当前道次" value={stat?.currentSeq ? `第 ${stat.currentSeq} 道` : '已完工'} tone="warning" />
        <StatBadge label="待复检挂起" value={totalPending} suffix="项" tone="danger" />
        <StatBadge label="荫干等待" value={stat?.dryingHours ?? 0} suffix="小时" tone="info" />
      </div>

      {totalPending > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`当前有 ${totalPending} 项复检挂起待管理员处理`}
          description="荫房越界或时段对账异常已挂到对应道次，请在「复检」中填写结论；值守侧补录的记录不会改写已定结论。"
        />
      ) : null}

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
                message.success('已带出建议漆种');
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
                  message.success(`已批量改为${PAINT_TYPE_LABEL[batchPaint]}，荫干建议已重算`);
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
          <Alert
            type="info"
            showIcon
            message={
              liveDryingHours !== null
                ? `按当前漆种与湿膜厚度，荫干时长建议约 ${liveDryingHours} 小时；保存后漆种或厚度再改动会自动重算。`
                : `环境适宜时，${PAINT_TYPE_LABEL[form.getFieldValue('paintType') as PaintType] ?? '该漆种'}建议间隔约 ${
                    suggestion?.intervalHours ?? suggestIntervalHours('raw')
                  } 小时再进入下一道`
            }
          />
        </Form>
      </Modal>

      <Modal
        open={recheckOpen}
        title={recheckCoat ? `第 ${recheckCoat.seq} 道 · 复检结论` : '复检结论'}
        onCancel={() => setRecheckOpen(false)}
        onOk={() => void submitRecheck()}
        okText="登记结论"
        cancelText="取消"
        destroyOnClose
      >
        {recheckCoat
          ? rechecks
              .filter((recheck) => recheck.coatId === recheckCoat.id && recheck.status === 'pending')
              .map((recheck) => (
                <Alert
                  key={recheck.id}
                  type="warning"
                  showIcon
                  style={{ marginBottom: 12 }}
                  message={`${RECHECK_REASON_LABEL[recheck.reason]} · 挂起于 ${new Date(recheck.updatedAt).toLocaleString('zh-CN')}`}
                  description={
                    recheck.roomId
                      ? `触发记录：${recheck.roomId}`
                      : '荫干时段对账未通过，请核对建议荫干时长与实际在房时长。'
                  }
                />
              ))
          : null}
        <Form layout="vertical">
          <Form.Item label="复检结论" required>
            <Radio.Group
              value={recheckStatus}
              onChange={(event) => setRecheckStatus(event.target.value as Exclude<RecheckStatus, 'pending'>)}
              optionType="button"
              buttonStyle="solid"
            >
              <Radio.Button value="passed">复检合格</Radio.Button>
              <Radio.Button value="failed">需返工</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item label="复检人" required>
            <Input placeholder="如：周衡" value={recheckInspector} onChange={(event) => setRecheckInspector(event.target.value)} />
          </Form.Item>
          <Form.Item label="结论说明" required={recheckStatus === 'failed'}>
            <Input.TextArea
              rows={3}
              placeholder={recheckStatus === 'failed' ? '需返工必须填写说明' : '如：漆膜无起皱、无失光，可继续下一道'}
              value={recheckConclusion}
              onChange={(event) => setRecheckConclusion(event.target.value)}
            />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
