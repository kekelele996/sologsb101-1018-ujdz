/**
 * 两侧数据的只读派生逻辑（不写任何表）
 * - 道次荫干时段对账：值守侧 Room 实测出入房时段 vs 管理员侧 Coat 记账的 dryingFrom/dryingTo
 * - 道次复检视图：越界荫房记录挂到道次上等管理员复检；复检后后补的超标记录只新增「待复检」，不改写已定结论
 *
 * 约定：本文件允许跨侧读数据，但任何派生结论都不落库到对侧——
 * 对账动作只回写 Room（值守侧自己的表），复检结论只写 Coat（管理员侧自己的表）。
 */
import type { Coat, CoatRecheckConclusion } from '@/types/coat';
import type { Room, ReconcileStatus } from '@/types/room';

/** 对账允许的起止时刻偏差（分钟）：手工登记时间，30 分钟内视为一致 */
export const RECONCILE_TOLERANCE_MINUTES = 30;

/** 把 yyyy-MM-dd 与 HH:mm 拼成 epoch 毫秒；非法返回 null */
function toEpochMinutes(date: string, hm: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(hm);
  if (!match) return null;
  const time = Date.parse(`${date}T${hm}`);
  return Number.isNaN(time) ? null : time;
}

/** 解析 datetime-local（yyyy-MM-ddTHH:mm）为 epoch 毫秒；空串 / 非法返回 null */
export function parseDryingMoment(value: string): number | null {
  if (!value) return null;
  const time = Date.parse(value.length === 16 ? value : value.slice(0, 16));
  return Number.isNaN(time) ? null : time;
}

export interface TimeWindow {
  from: number;
  to: number;
}

/** 值守侧实测时段（记录日期 + 入房/出房时刻，出房早于入房按跨夜处理） */
export function roomWindow(room: Pick<Room, 'date' | 'inAt' | 'outAt'>): TimeWindow | null {
  const from = toEpochMinutes(room.date, room.inAt);
  const rawTo = toEpochMinutes(room.date, room.outAt);
  if (from === null || rawTo === null) return null;
  const to = rawTo <= from ? rawTo + 24 * 60 * 60 * 1000 : rawTo;
  return { from, to };
}

/** 管理员侧记账时段 */
export function coatWindow(coat: Pick<Coat, 'dryingFrom' | 'dryingTo'>): TimeWindow | null {
  const from = parseDryingMoment(coat.dryingFrom);
  const to = parseDryingMoment(coat.dryingTo);
  if (from === null || to === null || to <= from) return null;
  return { from, to };
}

/** 单条记录对账判定：缺道次 / 任一侧时段缺失或无法解析 → 挂起；起止均在容差内 → 一致，否则挂起 */
export function compareWindows(room: Room, coat: Coat | undefined): Exclude<ReconcileStatus, 'pending'> {
  if (!coat) return 'suspended';
  const actual = roomWindow(room);
  const booked = coatWindow(coat);
  if (!actual || !booked) return 'suspended';
  const tolerance = RECONCILE_TOLERANCE_MINUTES * 60 * 1000;
  if (Math.abs(actual.from - booked.from) <= tolerance && Math.abs(actual.to - booked.to) <= tolerance) {
    return 'matched';
  }
  return 'suspended';
}

/**
 * 一条荫房记录当前「有效」对账状态（派生）：
 * - 从未对账 → 待核
 * - 对账之后任一侧时段相关数据被改动（room/coat 的 updatedAt 晚于 reconcileAt）→ 回到待核
 * - 否则按最近一次对账结论展示（一致 / 已挂起）
 */
export function effectiveReconcile(room: Room, coat: Coat | undefined): ReconcileStatus {
  if (!room.reconcileAt) return 'pending';
  if (room.updatedAt > room.reconcileAt) return 'pending';
  if (coat && coat.updatedAt > room.reconcileAt) return 'pending';
  return room.reconcileStatus === 'matched' ? 'matched' : 'suspended';
}

/** 越界（偏干 / 偏湿）判定 */
export function isOverRoom(room: Pick<Room, 'verdict'>): boolean {
  return room.verdict !== 'suitable';
}

export interface CoatRecheckView {
  /** 是否有待管理员处理的复检线索（复检后新挂上来的超标记录也算） */
  pending: boolean;
  /** 待复检线索条数（全部未被当前复检覆盖的超标记录） */
  pendingCount: number;
  /** 管理员已定的复检结论；有新线索时该结论保留展示但不代表覆盖新线索 */
  conclusion: CoatRecheckConclusion;
  note: string;
  recheckAt: number | null;
  /** 挂在本道次的超标荫房记录总数 */
  overCount: number;
}

/** 道次复检视图：把挂在道次上的超标荫房记录与管理员复检结论合并派生 */
export function coatRecheckView(
  coat: Pick<Coat, 'recheckStatus' | 'recheckNote' | 'recheckAt'>,
  roomsOnCoat: Array<Pick<Room, 'verdict' | 'createdAt'>>,
): CoatRecheckView {
  const over = roomsOnCoat.filter(isOverRoom);
  const since = coat.recheckAt ?? 0;
  const pendingRooms = over.filter((room) => room.createdAt > since);
  const pending = pendingRooms.length > 0 || (over.length > 0 && coat.recheckStatus === 'none');
  return {
    pending,
    pendingCount: pendingRooms.length,
    conclusion: coat.recheckStatus,
    note: coat.recheckNote,
    recheckAt: coat.recheckAt,
    overCount: over.length,
  };
}

/** 按 coatId 分组荫房记录（无道次的记录归到 null 桶） */
export function groupRoomsByCoat(rooms: Room[]): Map<string | null, Room[]> {
  const map = new Map<string | null, Room[]>();
  rooms.forEach((room) => {
    const list = map.get(room.coatId) ?? [];
    list.push(room);
    map.set(room.coatId, list);
  });
  return map;
}

/** 全局待复检道次数（App 徽标 / 台账统计用） */
export function countPendingRecheckCoats(coats: Coat[], rooms: Room[]): number {
  const grouped = groupRoomsByCoat(rooms);
  return coats.reduce((sum, coat) => {
    const view = coatRecheckView(coat, grouped.get(coat.id) ?? []);
    return sum + (view.pending ? 1 : 0);
  }, 0);
}
