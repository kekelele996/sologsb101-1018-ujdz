/**
 * 髹涂道次状态管理（Zustand）——工序管理员侧
 * 维护道次顺序、状态推进、复检结论、记账荫干时段与荫干时长建议，支持拖拽重排落库重编号、批量改漆种与状态。
 *
 * 边界：本 store 只写 coats 表，绝不改写 rooms / polishes。
 * - 漆种一改动，已存的荫干时长建议立即失效（dryingAdvicePaintType 与当前漆种不符），需「重新计算」；
 * - 复检结论只能由管理员通过 setRecheck 给出；值守后补的超标记录不会改写它（派生见 utils/reconcile.ts）；
 * - 打磨序列按 Polish.coatId 挂道次，重排 / 改漆种均不触碰打磨表。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType, CoatRecheckConclusion } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { recommendDryingHours, suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { useBodyStore } from './bodyStore';
import { useRoomStore } from './roomStore';

export interface PaintSuggestion {
  paintType: PaintType;
  intervalHours: number;
  sourceCode: string;
  sourceColor: string;
}

interface CoatStoreState {
  coats: Coat[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadCoats: () => Promise<void>;
  coatsOfBody: (bodyId: string) => Coat[];
  createCoat: (draft: CoatDraft) => Promise<Coat>;
  /** 部分字段更新：自动与存量字段合并，改漆种时让旧荫干建议失效 */
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  /** 管理员对挂到道次的超标荫房记录给出复检结论（只写 coats） */
  setRecheck: (id: string, conclusion: Exclude<CoatRecheckConclusion, 'none'>, note: string) => Promise<void>;
  /** 取该胎体最近一条荫房记录重新计算本道次荫干建议（只读 rooms，结果只写 coats）；无记录时返回 false */
  recomputeDryingAdvice: (id: string) => Promise<boolean>;
  reorderCoats: (bodyId: string, orderedIds: string[]) => Promise<void>;
  nextSeq: (bodyId: string) => number;
  /** 同器型自动带出上次漆种与间隔建议 */
  suggestForBody: (bodyId: string) => PaintSuggestion;
}

export const useCoatStore = create<CoatStoreState>((set, get) => ({
  coats: [],
  loading: false,
  ready: false,
  error: '',

  async loadCoats() {
    set({ loading: true });
    try {
      const coats = await db.coats.toArray();
      coats.sort((a, b) => (a.bodyId === b.bodyId ? a.seq - b.seq : a.bodyId.localeCompare(b.bodyId)));
      set({ coats, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '道次读取失败' });
    }
  },

  coatsOfBody(bodyId) {
    return get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => a.seq - b.seq);
  },

  async createCoat(draft) {
    const now = Date.now();
    const row: Coat = { ...draft, id: createId('coat'), createdAt: now, updatedAt: now };
    await db.coats.put(row);
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    const existing = get().coats.find((coat) => coat.id === id);
    if (!existing) return;
    const nextPaint = patch.paintType ?? existing.paintType;
    // 合并落库：patch 只带管理员本次改动的字段，复检结论 / 建议等不会被表单整体覆盖
    const merged: Coat = { ...existing, ...patch, paintType: nextPaint, updatedAt: Date.now() };
    // 漆种改动 → 荫干建议立即失效（与当前漆种不符），待管理员重算
    if (patch.paintType !== undefined && patch.paintType !== existing.paintType) {
      merged.dryingAdvicePaintType = existing.paintType;
    }
    await db.coats.put(merged);
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续；不连带删除打磨 / 荫房记录（各自留底）
      const rest = get()
        .coats.filter((coat) => coat.bodyId === target.bodyId && coat.id !== id)
        .sort((a, b) => a.seq - b.seq)
        .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
      if (rest.length > 0) await db.coats.bulkPut(rest);
    }
    await get().loadCoats();
  },

  async batchUpdate(ids, patch) {
    if (ids.length === 0) return;
    const now = Date.now();
    const rows = get()
      .coats.filter((coat) => ids.includes(coat.id))
      .map((coat) => {
        // 逐行合并：批量改漆种时让被改漆种的道次建议失效；批量改状态不影响其它字段
        const next: Coat = { ...coat, ...patch, updatedAt: now };
        if (patch.paintType !== undefined && patch.paintType !== coat.paintType) {
          next.dryingAdvicePaintType = coat.paintType;
        }
        return next;
      });
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  async advanceState(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const next = nextCoatState(coat.state);
    if (next === coat.state) return;
    // 只推进状态本身，合并更新不动复检 / 建议字段
    await get().updateCoat(id, { state: next });
  },

  async setRecheck(id, conclusion, note) {
    const existing = get().coats.find((coat) => coat.id === id);
    if (!existing) return;
    // 复检结论由管理员定并打时间戳；此后新补登的超标记录只会再派生「待复检」，不会回退该结论
    await db.coats.put({
      ...existing,
      recheckStatus: conclusion,
      recheckNote: note,
      recheckAt: Date.now(),
      updatedAt: Date.now(),
    });
    await get().loadCoats();
  },

  async recomputeDryingAdvice(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return false;
    // 跨侧只读：取该胎体最近一条荫房记录作为环境依据
    const latest = useRoomStore
      .getState()
      .rooms.filter((room) => room.bodyId === coat.bodyId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0];
    if (!latest) return false;
    const hours = recommendDryingHours(coat.paintType, latest.tempC, latest.humidityPct, coat.thicknessUm);
    await db.coats.put({
      ...coat,
      dryingAdviceHours: hours,
      dryingAdvicePaintType: coat.paintType,
      dryingAdviceAt: Date.now(),
      updatedAt: Date.now(),
    });
    await get().loadCoats();
    return true;
  },

  async reorderCoats(bodyId, orderedIds) {
    const indexOf = new Map(orderedIds.map((id, index) => [id, index]));
    const rows = get()
      .coats.filter((coat) => coat.bodyId === bodyId)
      .sort((a, b) => {
        const ai = indexOf.has(a.id) ? (indexOf.get(a.id) as number) : Number.MAX_SAFE_INTEGER;
        const bi = indexOf.has(b.id) ? (indexOf.get(b.id) as number) : Number.MAX_SAFE_INTEGER;
        return ai - bi;
      })
      .map((coat, index) => ({ ...coat, seq: index + 1, updatedAt: Date.now() }));
    // 仅重排 coats 自身序号；Polish 按 coatId 关联，目数序列不会被冲掉
    await db.coats.bulkPut(rows);
    await get().loadCoats();
  },

  nextSeq(bodyId) {
    const list = get().coats.filter((coat) => coat.bodyId === bodyId);
    return list.length === 0 ? 1 : Math.max(...list.map((coat) => coat.seq)) + 1;
  },

  suggestForBody(bodyId) {
    const bodies = useBodyStore.getState().bodies;
    const current = bodies.find((body) => body.id === bodyId);
    const previousBody = bodies.find((body) => body.id !== bodyId && current !== undefined && body.shape === current.shape);
    const previousCoat = previousBody
      ? get()
          .coats.filter((coat) => coat.bodyId === previousBody.id)
          .sort((a, b) => a.seq - b.seq)
          .pop()
      : undefined;
    const paintType = suggestPaintType(get().nextSeq(bodyId), previousCoat?.paintType, current?.shape);
    return {
      paintType,
      intervalHours: suggestIntervalHours(paintType),
      sourceCode: previousBody?.code ?? '',
      sourceColor: previousCoat?.colorName ?? '',
    };
  },
}));

/** 道次派生选择器：按状态集合过滤 */
export function selectCoatsByStates(coats: Coat[], states: CoatState[]): Coat[] {
  if (states.length === 0) return coats;
  return coats.filter((coat) => states.includes(coat.state));
}
