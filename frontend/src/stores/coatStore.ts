/**
 * 髹涂道次状态管理（Zustand）
 * 维护道次顺序与状态推进，支持拖拽重排落库重编号、批量改漆种与状态。
 * 道次只管道次编排与推进：荫干时长建议由漆种 + 湿膜厚度算出，漆种改动即失效重算；
 * 荫房越界挂起的复检项走 recheckStore，本 store 不回写荫房记录。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Coat, CoatDraft, CoatState, PaintType } from '@/types/coat';
import { nextCoatState } from '@/types/coat';
import { computeDryingHours, suggestIntervalHours, suggestPaintType } from '@/utils/humidity';
import { useBodyStore } from './bodyStore';
import { useRecheckStore } from './recheckStore';

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
  updateCoat: (id: string, patch: Partial<Coat>) => Promise<void>;
  removeCoat: (id: string) => Promise<void>;
  batchUpdate: (ids: string[], patch: Partial<Coat>) => Promise<void>;
  advanceState: (id: string) => Promise<void>;
  recomputeDryingAdvice: (id: string) => Promise<void>;
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
    const dryingHours = computeDryingHours(draft.paintType, draft.thicknessUm);
    const row: Coat = {
      ...draft,
      dryingHours,
      dryingHoursPaintType: draft.paintType,
      id: createId('coat'),
      createdAt: now,
      updatedAt: now,
    };
    await db.coats.put(row);
    await get().loadCoats();
    return row;
  },

  async updateCoat(id, patch) {
    const existing = get().coats.find((coat) => coat.id === id);
    // 只落库有定义的字段，避免表单未管理的遗留字段（needRecheck 等）被写成 undefined
    const nextPatch: Partial<Coat> = { updatedAt: Date.now() };
    (Object.keys(patch) as Array<keyof Coat>).forEach((key) => {
      if (patch[key] !== undefined) {
        (nextPatch as Record<string, unknown>)[key] = patch[key];
      }
    });
    // 漆种或湿膜厚度改动 → 荫干时长建议失效，按新漆种重算
    if (existing && (patch.paintType !== undefined || patch.thicknessUm !== undefined)) {
      const paintType = patch.paintType ?? existing.paintType;
      const thicknessUm = patch.thicknessUm ?? existing.thicknessUm;
      nextPatch.dryingHours = computeDryingHours(paintType, thicknessUm);
      nextPatch.dryingHoursPaintType = paintType;
    }
    await db.coats.update(id, nextPatch as never);
    await get().loadCoats();
  },

  async removeCoat(id) {
    const target = get().coats.find((coat) => coat.id === id);
    await db.coats.delete(id);
    if (target) {
      // 删除后按序重编号，保持 seq 连续
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
        const next = { ...coat, ...patch, updatedAt: now };
        // 批量改漆种 → 荫干时长建议随漆种重算
        if (patch.paintType !== undefined) {
          next.dryingHours = computeDryingHours(patch.paintType, next.thicknessUm);
          next.dryingHoursPaintType = patch.paintType;
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
    await get().updateCoat(id, { state: next });
    // 推进到已完成：管理员销项该道次未决的复检挂起
    if (next === 'done') {
      await useRecheckStore.getState().resolvePendingForCoat(id, '道次完成自动销项');
    }
  },

  async recomputeDryingAdvice(id) {
    const coat = get().coats.find((item) => item.id === id);
    if (!coat) return;
    const now = Date.now();
    await db.coats.update(
      id,
      {
        dryingHours: computeDryingHours(coat.paintType, coat.thicknessUm),
        dryingHoursPaintType: coat.paintType,
        updatedAt: now,
      } as never,
    );
    await get().loadCoats();
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
