/**
 * /rooms 荫房温湿度记录 ——荫房值守侧
 * 按天登记温湿度并判定适宜度，记录挂到具体道次；越界记录只作为复检线索挂起，不回写道次。
 * 支持发起两侧荫干时段对账（对不上挂起等核）、日期区间与判定 / 对账筛选（同步 URL query）。
 * 跨侧只读 Coat；本页只写 Room。
 */
import { useMemo, useState } from 'react';
import {
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
import { DeleteOutlined, EditOutlined, PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import FilterBar, { useFilterQuery, type FilterSelectConfig } from '@/components/common/FilterBar';
import StatBadge from '@/components/common/StatBadge';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useRoomStore } from '@/stores/roomStore';
import {
  RECONCILE_COLOR,
  RECONCILE_LABEL,
  RECONCILE_OPTIONS,
  ROOM_VERDICT_COLOR,
  ROOM_VERDICT_LABEL,
  ROOM_VERDICT_OPTIONS,
  createEmptyRoomDraft,
  type Room,
  type RoomDraft,
  type RoomVerdict,
} from '@/types/room';
import { PAINT_TYPE_LABEL } from '@/types/coat';
import { BODY_SHAPE_LABEL } from '@/types/body';
import { dewPoint, dryingAdvice, dryingHours, judgeVerdict, rangeHint, roomStayHours } from '@/utils/humidity';
import { effectiveReconcile, isOverRoom } from '@/utils/reconcile';

const FILTER_KEYS = ['verdict', 'reconcile'] as const;

const FILTER_SELECTS: ReadonlyArray<FilterSelectConfig> = [
  { key: 'verdict', label: '判定', options: ROOM_VERDICT_OPTIONS },
  { key: 'reconcile', label: '对账', options: RECONCILE_OPTIONS },
];

export default function RoomLog() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<RoomDraft>();

  const bodies = useBodyStore((state) => state.bodies);
  const coats = useCoatStore((state) => state.coats);
  const rooms = useRoomStore((state) => state.rooms);
  const createRoom = useRoomStore((state) => state.createRoom);
  const updateRoom = useRoomStore((state) => state.updateRoom);
  const removeRoom = useRoomStore((state) => state.removeRoom);
  const reconcileRoom = useRoomStore((state) => state.reconcileRoom);

  const url = useFilterQuery(FILTER_KEYS);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Room | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [draftTemp, setDraftTemp] = useState(24);
  const [draftHumidity, setDraftHumidity] = useState(75);

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;
  const coatById = useMemo(() => new Map(coats.map((coat) => [coat.id, coat])), [coats]);

  const coatLabel = (room: Room): string => {
    if (!room.coatId) return '未挂道次';
    const coat = coatById.get(room.coatId);
    return coat ? `第 ${coat.seq} 道 · ${PAINT_TYPE_LABEL[coat.paintType]}` : '道次已删除';
  };

  const filtered = useMemo(() => {
    const keyword = url.keyword.trim();
    const verdicts = url.values.verdict ?? [];
    const reconciles = url.values.reconcile ?? [];
    return rooms.filter((room) => {
      if (keyword.length > 0) {
        const haystack = `${bodyCode(room.bodyId)}${coatLabel(room)}${room.date}${room.tempC}${room.humidityPct}`;
        if (!haystack.includes(keyword)) return false;
      }
      if (verdicts.length > 0 && !verdicts.includes(room.verdict)) return false;
      if (reconciles.length > 0) {
        const status = effectiveReconcile(room, room.coatId ? coatById.get(room.coatId) : undefined);
        if (!reconciles.includes(status)) return false;
      }
      if (dateFrom.length > 0 && room.date < dateFrom) return false;
      if (dateTo.length > 0 && room.date > dateTo) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms, url.keyword, url.values, dateFrom, dateTo, bodies, coats]);

  const stat = useMemo(() => {
    const total = rooms.length;
    const suitable = rooms.filter((room) => room.verdict === 'suitable').length;
    const dry = rooms.filter((room) => room.verdict === 'dry').length;
    const wet = rooms.filter((room) => room.verdict === 'wet').length;
    const avgHumidity =
      total === 0 ? 0 : Math.round(rooms.reduce((sum, room) => sum + room.humidityPct, 0) / total);
    let suspended = 0;
    rooms.forEach((room) => {
      if (effectiveReconcile(room, room.coatId ? coatById.get(room.coatId) : undefined) === 'suspended') suspended += 1;
    });
    return {
      total,
      suitable,
      dry,
      wet,
      over: dry + wet,
      suitablePercent: total === 0 ? 0 : Math.round((suitable / total) * 100),
      avgHumidity,
      suspended,
    };
  }, [rooms, coatById]);

  const openCreate = (): void => {
    const body = bodies[0];
    if (!body) {
      message.warning('请先在胎体台账中登记胎体');
      return;
    }
    setEditing(null);
    const firstCoat = coats.find((coat) => coat.bodyId === body.id);
    const draft = createEmptyRoomDraft(body.id, firstCoat?.id ?? null);
    setDraftTemp(draft.tempC);
    setDraftHumidity(draft.humidityPct);
    form.setFieldsValue(draft);
    setOpen(true);
  };

  const openEdit = (room: Room): void => {
    setEditing(room);
    setDraftTemp(room.tempC);
    setDraftHumidity(room.humidityPct);
    form.setFieldsValue(room);
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const verdict = judgeVerdict(values.tempC, values.humidityPct);
    if (editing) {
      await updateRoom(editing.id, values);
      message.success(`已更新 ${values.date} 的荫房记录（判定：${ROOM_VERDICT_LABEL[verdict]}）`);
    } else {
      await createRoom(values);
      if (verdict === 'suitable') {
        message.success('已记录荫房温湿度，环境适宜');
      } else {
        message.warning(`判定为${ROOM_VERDICT_LABEL[verdict]}，已挂到关联道次等管理员复检（不回写道次状态）`);
      }
    }
    setOpen(false);
  };

  const handleReconcile = async (room: Room): Promise<void> => {
    const status = await reconcileRoom(room.id);
    if (status === 'matched') {
      message.success('对账一致：值守实测时段与道次记账时段相符');
    } else {
      message.warning('对不上，已挂起等核：请与管理员核对道次记账荫干时段');
    }
  };

  const columns: ColumnsType<Room> = [
    { title: '日期', dataIndex: 'date', width: 110, sorter: (a, b) => a.date.localeCompare(b.date) },
    {
      title: '胎体',
      dataIndex: 'bodyId',
      width: 110,
      render: (value: string) => <Tag color="#8c2f1f">{bodyCode(value)}</Tag>,
    },
    {
      title: '挂载道次',
      key: 'coat',
      width: 150,
      render: (_value, record) => <Typography.Text>{coatLabel(record)}</Typography.Text>,
    },
    { title: '温度', dataIndex: 'tempC', width: 80, render: (value: number) => `${value} ℃` },
    { title: '湿度', dataIndex: 'humidityPct', width: 80, render: (value: number) => `${value} %` },
    { title: '入房', dataIndex: 'inAt', width: 74 },
    { title: '出房', dataIndex: 'outAt', width: 74 },
    {
      title: '在房时长',
      key: 'stay',
      width: 100,
      render: (_value, record) => `${roomStayHours(record.inAt, record.outAt)} 小时`,
    },
    {
      title: '判定',
      dataIndex: 'verdict',
      width: 130,
      filters: ROOM_VERDICT_OPTIONS.map((item) => ({ text: item.label, value: item.value })),
      onFilter: (value, record) => record.verdict === value,
      render: (value: RoomVerdict, record) => (
        <Space size={4} wrap>
          <Tag color={ROOM_VERDICT_COLOR[value]}>{ROOM_VERDICT_LABEL[value]}</Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            露点 {dewPoint(record.tempC, record.humidityPct)}℃
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '时段对账',
      key: 'reconcile',
      width: 110,
      render: (_value, record) => {
        const status = effectiveReconcile(record, record.coatId ? coatById.get(record.coatId) : undefined);
        return (
          <Tooltip
            title={
              status === 'pending'
                ? '尚未对账，或对账后任一侧时段有改动'
                : status === 'matched'
                  ? '与道次记账荫干时段一致'
                  : '两侧时段对不上，已挂起等核'
            }
          >
            <Tag color={RECONCILE_COLOR[status]}>{RECONCILE_LABEL[status]}</Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '荫干建议',
      key: 'advice',
      render: (_value, record) => {
        const coat = record.coatId ? coatById.get(record.coatId) : undefined;
        const thickness = coat?.thicknessUm ?? 40;
        return (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dryingAdvice(record.tempC, record.humidityPct, thickness)}
            （预计 {dryingHours(record.tempC, record.humidityPct, thickness)} 小时）
          </Typography.Text>
        );
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 220,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Tooltip title="与道次记账荫干时段核对；对不上会挂起等核（只改本记录）">
            <Button size="small" type="link" icon={<SafetyCertificateOutlined />} onClick={() => void handleReconcile(record)}>
              对账
            </Button>
          </Tooltip>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该荫房记录"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void removeRoom(record.id).then(() => message.success('已删除'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const previewVerdict = judgeVerdict(draftTemp, draftHumidity);
  const watchedBodyId = Form.useWatch('bodyId', form) as string | undefined;
  const coatOptions = coats
    .filter((coat) => coat.bodyId === watchedBodyId)
    .sort((a, b) => a.seq - b.seq)
    .map((coat) => ({ value: coat.id, label: `第 ${coat.seq} 道 · ${PAINT_TYPE_LABEL[coat.paintType]} · ${coat.colorName}` }));

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>荫房温湿度记录（值守）</h2>
          <p>
            {rangeHint()}；值守只登记温湿度与适宜判定并记录留底，越界记录挂到道次等管理员复检，不回写道次状态与结论。
          </p>
        </div>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增记录
        </Button>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="记录总数" value={stat.total} suffix="条" tone="primary" />
        <StatBadge label="适宜占比" value={`${stat.suitablePercent}%`} percent={stat.suitablePercent} tone="success" />
        <StatBadge label="超标挂道次" value={stat.over} suffix="次" tone="danger" />
        <StatBadge label="偏干" value={stat.dry} suffix="次" tone="warning" />
        <StatBadge label="偏湿" value={stat.wet} suffix="次" tone="info" />
        <StatBadge label="对账挂起" value={stat.suspended} suffix="条" tone="danger" />
        <StatBadge label="平均湿度" value={stat.avgHumidity} suffix="%" />
      </div>

      <FilterBar
        keyword={url.keyword}
        onKeywordChange={url.setKeyword}
        selects={FILTER_SELECTS}
        values={url.values}
        onValuesChange={url.setValues}
        onReset={() => {
          url.reset();
          setDateFrom('');
          setDateTo('');
        }}
        keywordPlaceholder="搜索编号 / 道次 / 日期 / 温湿度…"
        actions={
          <Space size={6} wrap>
            <Input
              type="date"
              size="small"
              style={{ width: 150 }}
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
            <Typography.Text type="secondary">至</Typography.Text>
            <Input
              type="date"
              size="small"
              style={{ width: 150 }}
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </Space>
        }
      />

      <Card className="gb-table-card" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        {filtered.length === 0 ? (
          <EmptyPanel
            title={rooms.length === 0 ? '还没有荫房记录' : '当前条件下没有记录'}
            description={
              rooms.length === 0
                ? '每次入荫房时登记温度、湿度与出入房时间并挂到道次；越界会等管理员复检，不回写道次。'
                : '试着调整判定、对账状态或日期区间。'
            }
            actionText="新增记录"
            onAction={openCreate}
            secondaryText="重置筛选"
            onSecondary={() => {
              url.reset();
              setDateFrom('');
              setDateTo('');
            }}
            size="small"
          />
        ) : (
          <Table<Room> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={filtered} />
        )}
      </Card>

      <Modal
        open={open}
        title={editing ? `编辑 ${editing.date} 的荫房记录` : '新增荫房记录（值守登记）'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false} onValuesChange={(changed) => {
          if (typeof changed.tempC === 'number') setDraftTemp(changed.tempC);
          if (typeof changed.humidityPct === 'number') setDraftHumidity(changed.humidityPct);
        }}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="bodyId"
              label="关联胎体"
              rules={[{ required: true, message: '请选择胎体' }]}
              style={{ flex: 1 }}
            >
              <Select
                options={bodies.map((body) => ({
                  value: body.id,
                  label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
                }))}
                onChange={() => form.setFieldValue('coatId', undefined)}
              />
            </Form.Item>
            <Form.Item name="coatId" label="挂载道次（越界时等该道次管理员复检）" style={{ flex: 1 }}>
              <Select allowClear placeholder="先选胎体；不挂则仅留胎体底账" options={coatOptions} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="记录日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="inAt" label="入房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
            <Form.Item name="outAt" label="出房时间" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="time" />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="tempC" label="温度（℃）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={5} max={45} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="humidityPct" label="湿度（%）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={10} max={100} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Space direction="vertical" size={2}>
            <Tag color={ROOM_VERDICT_COLOR[previewVerdict]}>实时判定：{ROOM_VERDICT_LABEL[previewVerdict]}{isOverRoom({ verdict: previewVerdict }) ? '（将挂到道次等复检）' : ''}</Tag>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              露点约 {dewPoint(draftTemp, draftHumidity)}℃ · 在房 {roomStayHours(form.getFieldValue('inAt') ?? '09:00', form.getFieldValue('outAt') ?? '21:00')} 小时
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {dryingAdvice(draftTemp, draftHumidity, 40)}
            </Typography.Text>
          </Space>
        </Form>
      </Modal>
    </div>
  );
}
