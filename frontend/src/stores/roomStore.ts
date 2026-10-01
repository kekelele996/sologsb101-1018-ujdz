/**
 * 荫房记录状态管理（Zustand）
 * 维护荫房记录与超标派生统计。值守只管荫房记录与判定：
 * 越界记录只在 rechecks 表「挂起」一条待复检项到对应道次，绝不回写道次表、不改写已定结论。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room, RoomDraft, RoomVerdict } from '@/types/room';
import { judgeVerdict } from '@/utils/humidity';
import { useRecheckStore } from './recheckStore';

interface RoomStoreState {
  rooms: Room[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadRooms: () => Promise<void>;
  roomsOfBody: (bodyId: string) => Room[];
  createRoom: (draft: RoomDraft) => Promise<Room>;
  updateRoom: (id: string, patch: Partial<Room>) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  /** 超标（偏干 / 偏湿）记录条数 */
  overCount: () => number;
  overCountOfBody: (bodyId: string) => number;
  verdictCount: () => Record<RoomVerdict, number>;
}

export const useRoomStore = create<RoomStoreState>((set, get) => ({
  rooms: [],
  loading: false,
  ready: false,
  error: '',

  async loadRooms() {
    set({ loading: true });
    try {
      const rooms = await db.rooms.toArray();
      rooms.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      set({ rooms, loading: false, ready: true, error: '' });
    } catch (error) {
      set({ loading: false, ready: true, error: error instanceof Error ? error.message : '荫房记录读取失败' });
    }
  },

  roomsOfBody(bodyId) {
    return get()
      .rooms.filter((room) => room.bodyId === bodyId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },

  async createRoom(draft) {
    const now = Date.now();
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    const row: Room = { ...draft, verdict, id: createId('room'), createdAt: now, updatedAt: now };
    await db.rooms.put(row);
    // 越界只挂起待复检项（边界对象），不回写道次；已定结论不会被改写
    await useRecheckStore.getState().ensurePendingForRoom(row);
    await get().loadRooms();
    return row;
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    await db.rooms.update(id, { ...patch, tempC, humidityPct, verdict, updatedAt: Date.now() } as never);
    // 越界只挂起待复检项，不回写道次；已定结论不会被改写
    const updated: Room = { ...existing, ...patch, tempC, humidityPct, verdict, updatedAt: Date.now() };
    await useRecheckStore.getState().ensurePendingForRoom(updated);
    await get().loadRooms();
  },

  async removeRoom(id) {
    await db.rooms.delete(id);
    // 连带删除该记录未决的挂起项（已定结论保留作历史）
    await useRecheckStore.getState().removePendingByRoom(id);
    await get().loadRooms();
  },

  overCount() {
    return get().rooms.filter((room) => room.verdict !== 'suitable').length;
  },

  overCountOfBody(bodyId) {
    return get().rooms.filter((room) => room.bodyId === bodyId && room.verdict !== 'suitable').length;
  },

  verdictCount() {
    const result: Record<RoomVerdict, number> = { suitable: 0, dry: 0, wet: 0 };
    get().rooms.forEach((room) => {
      result[room.verdict] += 1;
    });
    return result;
  },
}));
