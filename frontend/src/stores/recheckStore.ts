/**
 * 复检挂起项状态管理（Zustand）
 * 荫房值守与工序管理员之间的边界：值守侧越界只「挂起」待复检项，结论由管理员填写。
 * - 值守侧（roomStore）保存越界荫房记录后调用 ensurePendingForRoom，只创建 / 保留待复检项，
 *   已定结论（passed / failed）的挂起项绝不被值守侧改写；
 * - 管理员侧（道次页）调用 resolveRecheck 填写复检结论；
 * - 荫干时段对账 reconcileDryingWindows 比对道次建议荫干时长与实际在房时长，对不上挂起等核。
 * 本 store 不反向依赖 coatStore / roomStore，避免跨边循环引用。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room } from '@/types/room';
import type { Recheck, RecheckReason, RecheckStatus } from '@/types/recheck';
import { dryingWindowStatus } from '@/utils/humidity';

interface RecheckStoreState {
  rechecks: Recheck[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadRechecks: () => Promise<void>;
  rechecksOfBody: (bodyId: string) => Recheck[];
  rechecksOfCoat: (coatId: string) => Recheck[];
  pendingOfCoat: (coatId: string) => Recheck[];
  latestOfCoat: (coatId: string) => Recheck | undefined;
  pendingCount: () => number;
  pendingCountOfBody: (bodyId: string) => number;
  hasPending: (coatId: string) => boolean;
  /** 值守保存越界记录后挂起一条待复检；已定结论的不改写 */
  ensurePendingForRoom: (room: Room) => Promise<void>;
  /** 管理员填写复检结论（复检合格 / 需返工） */
  resolveRecheck: (id: string, status: Exclude<RecheckStatus, 'pending'>, conclusion: string, inspector: string) => Promise<void>;
  /** 管理员撤销结论，回到待复检 */
  reopenRecheck: (id: string) => Promise<void>;
  /** 道次推进到完成时，自动销项该道次未决的挂起项 */
  resolvePendingForCoat: (coatId: string, conclusion: string) => Promise<void>;
  /** 荫干时段对账：对不上挂起等核，返回核对 / 异常 / 新增挂起数 */
  reconcileDryingWindows: () => Promise<{ checked: number; mismatched: number; created: number }>;
  /** 荫房记录删除时，连带删除其未决挂起项（已定结论保留作历史） */
  removePendingByRoom: (roomId: string) => Promise<void>;
}

export const useRecheckStore = create<RecheckStoreState>((set, get) => ({
  rechecks: [],
  loading: false,
  ready: false,
  error: '',

  async loadRechecks() {
    set({ loading: true });
    try {
      const rechecks = await db.rechecks.toArray();
      rechecks.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      set({ rechecks, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '复检项读取失败' });
    }
  },

  rechecksOfBody(bodyId) {
    return get()
      .rechecks.filter((recheck) => recheck.bodyId === bodyId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  },

  rechecksOfCoat(coatId) {
    return get()
      .rechecks.filter((recheck) => recheck.coatId === coatId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  },

  pendingOfCoat(coatId) {
    return get().rechecks.filter((recheck) => recheck.coatId === coatId && recheck.status === 'pending');
  },

  latestOfCoat(coatId) {
    const list = get().rechecksOfCoat(coatId);
    return list[0];
  },

  pendingCount() {
    return get().rechecks.filter((recheck) => recheck.status === 'pending').length;
  },

  pendingCountOfBody(bodyId) {
    return get().rechecks.filter((recheck) => recheck.bodyId === bodyId && recheck.status === 'pending').length;
  },

  hasPending(coatId) {
    return get().pendingOfCoat(coatId).length > 0;
  },

  async ensurePendingForRoom(room) {
    if (room.verdict === 'suitable') return;
    const existing = get().rechecks.find(
      (recheck) => recheck.roomId === room.id && recheck.reason === 'env',
    );
    // 已定结论的挂起项绝不被值守侧补录 / 修改的记录改写
    if (existing) return;
    // 未指定归属道次时，挂到该胎体当前在制（未完成）的最近一道
    let coatId = room.coatId ?? '';
    if (!coatId) {
      const bodyCoats = await db.coats.where('bodyId').equals(room.bodyId).toArray();
      const active = bodyCoats
        .filter((coat) => coat.state !== 'done')
        .sort((a, b) => a.seq - b.seq)[0];
      coatId = active?.id ?? '';
    }
    const now = Date.now();
    const row: Recheck = {
      id: createId('recheck'),
      bodyId: room.bodyId,
      coatId,
      roomId: room.id,
      reason: 'env' as RecheckReason,
      status: 'pending',
      conclusion: '',
      inspector: '',
      concludedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    await db.rechecks.put(row);
    await get().loadRechecks();
  },

  async resolveRecheck(id, status, conclusion, inspector) {
    const existing = get().rechecks.find((recheck) => recheck.id === id);
    if (!existing) return;
    const now = Date.now();
    await db.rechecks.update(id, {
      status,
      conclusion,
      inspector,
      concludedAt: now,
      updatedAt: now,
    } as never);
    await get().loadRechecks();
  },

  async reopenRecheck(id) {
    const existing = get().rechecks.find((recheck) => recheck.id === id);
    if (!existing) return;
    const now = Date.now();
    await db.rechecks.update(id, {
      status: 'pending',
      conclusion: '',
      inspector: '',
      concludedAt: null,
      updatedAt: now,
    } as never);
    await get().loadRechecks();
  },

  async resolvePendingForCoat(coatId, conclusion) {
    const pending = get().pendingOfCoat(coatId);
    if (pending.length === 0) return;
    const now = Date.now();
    await db.rechecks.bulkPut(
      pending.map((recheck) => ({
        ...recheck,
        status: 'passed' as RecheckStatus,
        conclusion,
        concludedAt: now,
        updatedAt: now,
      })),
    );
    await get().loadRechecks();
  },

  async reconcileDryingWindows() {
    const [coats, rooms] = await Promise.all([db.coats.toArray(), db.rooms.toArray()]);
    const activeCoats = coats.filter((coat) => coat.state !== 'todo');
    let mismatched = 0;
    let created = 0;
    const now = Date.now();
    const rows: Recheck[] = [];
    for (const coat of activeCoats) {
      const coatRooms = rooms.filter((room) => room.coatId === coat.id);
      const result = dryingWindowStatus(coat, coatRooms);
      if (result.status === 'ok') continue;
      mismatched += 1;
      const hasPending = get().rechecks.some(
        (recheck) => recheck.coatId === coat.id && recheck.reason === 'dryingWindow' && recheck.status === 'pending',
      );
      if (hasPending) continue;
      rows.push({
        id: createId('recheck'),
        bodyId: coat.bodyId,
        coatId: coat.id,
        roomId: null,
        reason: 'dryingWindow',
        status: 'pending',
        conclusion: '',
        inspector: '',
        concludedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }
    if (rows.length > 0) await db.rechecks.bulkPut(rows);
    await get().loadRechecks();
    return { checked: activeCoats.length, mismatched, created };
  },

  async removePendingByRoom(roomId) {
    const pending = get().rechecks.filter(
      (recheck) => recheck.roomId === roomId && recheck.status === 'pending',
    );
    if (pending.length === 0) return;
    await db.rechecks.bulkDelete(pending.map((recheck) => recheck.id));
    await get().loadRechecks();
  },
}));

/** 道次派生选择器：是否存在未决挂起项 */
export function selectCoatHasPending(rechecks: Recheck[], coatId: string): boolean {
  return rechecks.some((recheck) => recheck.coatId === coatId && recheck.status === 'pending');
}
