/**
 * 荫房记录（Room）数据模型
 * 每次入荫房的温湿度与出入房时间，是漆层缺陷回溯的关键依据。
 *
 * 边界约定：Room 归荫房值守侧维护（温湿度登记 / 适宜度判定 / 发起对账）。
 * 记录通过 coatId「挂」到具体道次：温湿度越界即作为待复检线索挂在道次上等管理员复检，
 * 值守侧不回写、不改写道次状态与复检结论。
 * reconcileStatus 是值守侧对本记录与道次记账荫干时段的对账结果，任一侧时段改动后自动回到「待核」。
 */

/** 判定结论：适宜 / 偏干 / 偏湿 */
export type RoomVerdict = 'suitable' | 'dry' | 'wet';

/** 对账状态：待核 / 一致 / 对不上挂起 */
export type ReconcileStatus = 'pending' | 'matched' | 'suspended';

export interface Room {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 挂载的髹涂道次 id（v3 起必填，历史数据迁移时按胎体 + 日期归并）；无道次时为 null */
  coatId: string | null;
  /** 记录日期 yyyy-MM-dd */
  date: string;
  /** 荫房温度（摄氏度） */
  tempC: number;
  /** 相对湿度（%） */
  humidityPct: number;
  /** 入房时间 HH:mm */
  inAt: string;
  /** 出房时间 HH:mm */
  outAt: string;
  /** 判定结论（值守侧按温湿度区间定） */
  verdict: RoomVerdict;
  /** 对账状态：待核 / 一致 / 挂起；派生的「有效状态」见 utils/reconcile.ts effectiveReconcile() */
  reconcileStatus: ReconcileStatus;
  /** 最近一次对账操作时间戳（0 表示从未对账） */
  reconcileAt: number;
  createdAt: number;
  updatedAt: number;
}

export type RoomDraft = Omit<Room, 'id' | 'createdAt' | 'updatedAt'>;

export const ROOM_VERDICT_LABEL: Record<RoomVerdict, string> = {
  suitable: '适宜',
  dry: '偏干',
  wet: '偏湿',
};

export const ROOM_VERDICT_COLOR: Record<RoomVerdict, string> = {
  suitable: '#2f6f4f',
  dry: '#c9963c',
  wet: '#3a6ea5',
};

export const ROOM_VERDICT_OPTIONS: ReadonlyArray<{ value: RoomVerdict; label: string }> = [
  { value: 'suitable', label: '适宜' },
  { value: 'dry', label: '偏干' },
  { value: 'wet', label: '偏湿' },
];

export const RECONCILE_LABEL: Record<ReconcileStatus, string> = {
  pending: '待核',
  matched: '一致',
  suspended: '已挂起',
};

export const RECONCILE_COLOR: Record<ReconcileStatus, string> = {
  pending: '#8c8c8c',
  matched: '#2f6f4f',
  suspended: '#b03a2e',
};

export const RECONCILE_OPTIONS: ReadonlyArray<{ value: ReconcileStatus; label: string }> = [
  { value: 'pending', label: '待核' },
  { value: 'matched', label: '一致' },
  { value: 'suspended', label: '已挂起' },
];

export function createEmptyRoomDraft(bodyId: string, coatId: string | null): RoomDraft {
  const today = new Date().toISOString().slice(0, 10);
  return {
    bodyId,
    coatId,
    date: today,
    tempC: 24,
    humidityPct: 75,
    inAt: '09:00',
    outAt: '21:00',
    verdict: 'suitable',
    reconcileStatus: 'pending',
    reconcileAt: 0,
  };
}
