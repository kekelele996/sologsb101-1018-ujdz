/**
 * 荫房记录状态管理（Zustand）——荫房值守侧
 * 维护荫房记录、超标派生统计与时段对账。
 *
 * 边界：本 store 只写 rooms 表，绝不回写 coats（不推状态、不写复检标记）。
 * 越界记录通过 Room.coatId 挂到道次上，由管理员在道次页复检并定结论；
 * 对账动作只回写本记录的 reconcileStatus / reconcileAt（值守侧自己留底）。
 */
import { create } from 'zustand';
import { db, createId } from '@/utils/db';
import type { Room, RoomDraft, RoomVerdict } from '@/types/room';
import { judgeVerdict } from '@/utils/humidity';
import { compareWindows } from '@/utils/reconcile';

interface RoomStoreState {
  rooms: Room[];
  loading: boolean;
  ready: boolean;
  error: string;
  loadRooms: () => Promise<void>;
  roomsOfBody: (bodyId: string) => Room[];
  roomsOfCoat: (coatId: string) => Room[];
  createRoom: (draft: RoomDraft) => Promise<Room>;
  updateRoom: (id: string, patch: Partial<Room>) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  /** 对单条荫房记录与道次记账时段发起对账，返回对账结论（只回写 rooms 表） */
  reconcileRoom: (id: string) => Promise<Exclude<Room['reconcileStatus'], 'pending'>>;
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

  roomsOfCoat(coatId) {
    return get()
      .rooms.filter((room) => room.coatId === coatId)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  },

  async createRoom(draft) {
    const now = Date.now();
    const verdict = judgeVerdict(draft.tempC, draft.humidityPct);
    // 后补记录同样挂到道次上待复检；不触碰任何已定的道次状态 / 复检结论
    const row: Room = {
      ...draft,
      verdict,
      reconcileStatus: 'pending',
      reconcileAt: 0,
      id: createId('room'),
      createdAt: now,
      updatedAt: now,
    };
    await db.rooms.put(row);
    await get().loadRooms();
    return row;
  },

  async updateRoom(id, patch) {
    const existing = get().rooms.find((room) => room.id === id);
    if (!existing) return;
    const tempC = patch.tempC ?? existing.tempC;
    const humidityPct = patch.humidityPct ?? existing.humidityPct;
    const verdict = judgeVerdict(tempC, humidityPct);
    // 温湿度 / 时段 / 挂载道次被值守改动后，旧对账结论失效，回到待核
    await db.rooms.update(id, {
      ...patch,
      tempC,
      humidityPct,
      verdict,
      reconcileStatus: 'pending',
      reconcileAt: 0,
      updatedAt: Date.now(),
    } as never);
    await get().loadRooms();
  },

  async removeRoom(id) {
    await db.rooms.delete(id);
    await get().loadRooms();
  },

  async reconcileRoom(id) {
    const room = get().rooms.find((item) => item.id === id);
    if (!room) return 'suspended';
    // 跨侧只读：取管理员记账时段做比对，结论只落本记录
    const coat = room.coatId ? await db.coats.get(room.coatId) : undefined;
    const status = compareWindows(room, coat);
    await db.rooms.update(id, { reconcileStatus: status, reconcileAt: Date.now(), updatedAt: Date.now() } as never);
    await get().loadRooms();
    return status;
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
