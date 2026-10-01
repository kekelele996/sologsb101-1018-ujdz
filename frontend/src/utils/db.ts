/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据结构版本号与升级迁移逻辑
 *   v1 → v2：Coat 增加 paintType 索引并回填历史记录
 *   v2 → v3：值守侧与管理员侧解耦——
 *            Room 增加 coatId 挂道次、对账状态字段（历史荫房记录按胎体 + 日期归到道次）；
 *            Coat 去掉 needRecheck，增加复检结论 / 记账荫干时段 / 荫干建议字段；
 *            Polish 改以 coatId 稳定挂道次（历史记录按 bodyId + seq 回填）。
 * - 六张业务表的增删改查与整库导入导出
 * - 首次打开自动播种互相引用的演示数据（幂等）
 * 纯前端应用：不依赖任何后端服务或数据库。
 */
import Dexie, { type Table } from 'dexie';
import type { Body } from '@/types/body';
import type { Coat, PaintType } from '@/types/coat';
import type { Room } from '@/types/room';
import type { Polish } from '@/types/polish';
import type { Inlay } from '@/types/inlay';
import type { Inspect } from '@/types/inspect';

/** 数据库名（README 与导出文件均使用该名称） */
export const DB_NAME = 'gblacquer';

/** 当前数据结构版本号 */
export const DB_SCHEMA_VERSION = 3;

/** localStorage 侧少量元数据键 */
export const LS_KEYS = {
  dbVersion: 'gblacquer:db-version',
  lastBackupAt: 'gblacquer:last-backup-at',
  uiPrefs: 'gblacquer:ui-prefs',
} as const;

export interface UiPrefs {
  /** 最近选中的胎体 */
  lastBodyId: string | null;
}

export const DEFAULT_UI_PREFS: UiPrefs = { lastBodyId: null };

export function readUiPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(LS_KEYS.uiPrefs);
    if (!raw) return { ...DEFAULT_UI_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { lastBodyId: typeof parsed.lastBodyId === 'string' ? parsed.lastBodyId : null };
  } catch {
    return { ...DEFAULT_UI_PREFS };
  }
}

export function writeUiPrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(LS_KEYS.uiPrefs, JSON.stringify(prefs));
  } catch {
    /* 忽略隐私模式下的写入失败 */
  }
}

/** 记录结构版本与最近备份时间，便于「本地数据」页回显 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_SCHEMA_VERSION));
  } catch {
    /* ignore */
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt);
  } catch {
    return null;
  }
}

export function writeLastBackupAt(value: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, value);
  } catch {
    /* ignore */
  }
}

/* ------------------------- 跨版本数据归并（升级 / 导入共用） ------------------------- */

const LEGAL_PAINT: PaintType[] = ['raw', 'color', 'topcoat'];

/** 按「涂刷日期不晚于荫房记录日期的最后一道」归并；找不到就退化为该胎体最后一道 */
export function findCoatForRoom(coats: Coat[], bodyId: string, roomDate: string): Coat | undefined {
  const list = coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq);
  if (list.length === 0) return undefined;
  let picked: Coat | undefined;
  list.forEach((coat) => {
    if (coat.coatDate <= roomDate) picked = coat;
  });
  return picked ?? list[list.length - 1];
}

class LacquerDatabase extends Dexie {
  bodies!: Table<Body, string>;
  coats!: Table<Coat, string>;
  rooms!: Table<Room, string>;
  polishes!: Table<Polish, string>;
  inlays!: Table<Inlay, string>;
  inspects!: Table<Inspect, string>;

  constructor() {
    super(DB_NAME);

    // v1：初版结构（历史数据保留）
    this.version(1).stores({
      bodies: 'id, code, material, shape, state, updatedAt',
      coats: 'id, bodyId, seq, state, updatedAt',
      rooms: 'id, bodyId, date, verdict, updatedAt',
      polishes: 'id, bodyId, seq, method, updatedAt',
      inlays: 'id, bodyId, type, position, updatedAt',
      inspects: 'id, bodyId, verdict, date, updatedAt',
    });

    // v2：Coat 增加 paintType 索引；历史记录缺少 paintType 时按「生漆」回填
    this.version(2)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, needRecheck, updatedAt',
        rooms: 'id, bodyId, date, verdict, updatedAt',
        polishes: 'id, bodyId, seq, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            if (!LEGAL_PAINT.includes(coat.paintType)) coat.paintType = 'raw';
            if (typeof coat.thicknessUm !== 'number') coat.thicknessUm = 40;
          });
      });

    // v3：两侧解耦——Coat 复检/时段/建议字段，Room 挂道次 + 对账，Polish 改挂 coatId
    this.version(DB_SCHEMA_VERSION)
      .stores({
        bodies: 'id, code, material, shape, state, updatedAt',
        coats: 'id, bodyId, seq, paintType, state, recheckStatus, updatedAt',
        rooms: 'id, bodyId, coatId, date, verdict, reconcileStatus, updatedAt',
        polishes: 'id, bodyId, coatId, method, updatedAt',
        inlays: 'id, bodyId, type, position, updatedAt',
        inspects: 'id, bodyId, verdict, date, updatedAt',
      })
      .upgrade(async (tx) => {
        const coats = await tx.table<Coat>('coats').toArray();

        await tx
          .table<Coat>('coats')
          .toCollection()
          .modify((coat) => {
            // 管理员侧新增字段：复检结论 / 记账荫干时段 / 荫干建议
            coat.recheckStatus = coat.recheckStatus === 'pass' || coat.recheckStatus === 'fail' ? coat.recheckStatus : 'none';
            coat.recheckNote = typeof coat.recheckNote === 'string' ? coat.recheckNote : '';
            coat.recheckAt = typeof coat.recheckAt === 'number' ? coat.recheckAt : null;
            coat.dryingFrom = typeof coat.dryingFrom === 'string' ? coat.dryingFrom : '';
            coat.dryingTo = typeof coat.dryingTo === 'string' ? coat.dryingTo : '';
            coat.dryingAdviceHours = typeof coat.dryingAdviceHours === 'number' ? coat.dryingAdviceHours : null;
            coat.dryingAdvicePaintType = LEGAL_PAINT.includes(coat.dryingAdvicePaintType as PaintType)
              ? coat.dryingAdvicePaintType
              : null;
            coat.dryingAdviceAt = typeof coat.dryingAdviceAt === 'number' ? coat.dryingAdviceAt : null;
            // needRecheck 是旧版值守侧越界回写的越界字段，v3 复检结论一律由管理员重新给
            delete (coat as unknown as Record<string, unknown>).needRecheck;
          });

        // 已有荫房记录升级时归到道次：按胎体 + 日期匹配当时已涂刷的最后一道
        await tx
          .table<Room>('rooms')
          .toCollection()
          .modify((room) => {
            if (typeof room.coatId !== 'string') {
              room.coatId = findCoatForRoom(coats, room.bodyId, room.date)?.id ?? null;
            }
            if (room.reconcileStatus !== 'matched' && room.reconcileStatus !== 'suspended') {
              room.reconcileStatus = 'pending';
            }
            room.reconcileAt = typeof room.reconcileAt === 'number' ? room.reconcileAt : 0;
          });

        // 打磨记录改以 coatId 稳定挂道次：按旧 bodyId + seq 回填，避免重排后目数序列错位
        const coatKey = new Map(coats.map((coat) => [`${coat.bodyId}#${coat.seq}`, coat.id]));
        await tx
          .table<Polish>('polishes')
          .toCollection()
          .modify((polish) => {
            if (typeof polish.coatId !== 'string' || !polish.coatId) {
              const legacy = polish as unknown as Record<string, unknown>;
              const seq = typeof legacy.seq === 'number' ? legacy.seq : 0;
              polish.coatId = coatKey.get(`${polish.bodyId}#${seq}`) ?? '';
            }
            delete (polish as unknown as Record<string, unknown>).seq;
          });
      });
  }
}

export const db = new LacquerDatabase();

/** 六张业务表清单，事务中统一引用 */
const TABLE_LIST = [db.bodies, db.coats, db.rooms, db.polishes, db.inlays, db.inspects];

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

/** 打开数据库并在首次使用时播种演示数据（幂等） */
export async function initDatabase(): Promise<void> {
  await db.open();
  stampDbVersion();
  if ((await db.bodies.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 播种数据 ------------------------------ */
/* 三层互相引用：Body →（Coat / Room / Polish / Inlay）→ Inspect，id 固定便于深链命中 */
/* v3：Room.coatId 全部挂到具体道次，部分记录演示对账一致 / 挂起 / 待核与复检后补线索 */

export async function seedDatabase(): Promise<void> {
  const now = Date.now();
  const DAY = 86400000;
  const bodies: Body[] = [
    {
      id: 'body_01',
      code: 'LQ-2401',
      material: 'wood',
      shape: 'bowl',
      sizeMm: 152,
      ownerName: '陈氏委托',
      state: 'coating',
      createdAt: now - DAY * 12,
      updatedAt: now - DAY * 2,
    },
    {
      id: 'body_02',
      code: 'LQ-2402',
      material: 'lacquered',
      shape: 'box',
      sizeMm: 96,
      ownerName: '工作室自藏',
      state: 'drying',
      createdAt: now - DAY * 9,
      updatedAt: now - DAY,
    },
    {
      id: 'body_03',
      code: 'LQ-2403',
      material: 'metal',
      shape: 'vase',
      sizeMm: 210,
      ownerName: '市工艺美术馆',
      state: 'done',
      createdAt: now - DAY * 30,
      updatedAt: now - DAY * 4,
    },
  ];

  const coats: Coat[] = [
    {
      id: 'coat_0101', bodyId: 'body_01', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-02',
      thicknessUm: 40, state: 'done',
      recheckStatus: 'none', recheckNote: '', recheckAt: null,
      dryingFrom: '2026-03-03T09:00', dryingTo: '2026-03-03T21:00',
      dryingAdviceHours: 24, dryingAdvicePaintType: 'raw', dryingAdviceAt: now - DAY * 10,
      createdAt: now - DAY * 11, updatedAt: now - DAY * 10,
    },
    {
      // 漆种已从生漆改为色漆：旧建议（按生漆算）失效，等管理员重算
      id: 'coat_0102', bodyId: 'body_01', seq: 2, paintType: 'color', colorName: '朱红', coatDate: '2026-03-06',
      thicknessUm: 45, state: 'toPolish',
      // 03-07 偏干记录已复检合格；03-09 后补的偏干记录是复检后新增线索，结论保留不被改写
      recheckStatus: 'pass', recheckNote: '复检表面成膜正常，偏干未造成缺陷', recheckAt: now - DAY * 4,
      dryingFrom: '', dryingTo: '',
      dryingAdviceHours: 24, dryingAdvicePaintType: 'raw', dryingAdviceAt: now - DAY * 6,
      createdAt: now - DAY * 7, updatedAt: now - DAY * 2,
    },
    {
      id: 'coat_0103', bodyId: 'body_01', seq: 3, paintType: 'topcoat', colorName: '推光本色', coatDate: '2026-03-12',
      thicknessUm: 30, state: 'todo',
      recheckStatus: 'none', recheckNote: '', recheckAt: null,
      dryingFrom: '', dryingTo: '',
      dryingAdviceHours: null, dryingAdvicePaintType: null, dryingAdviceAt: null,
      createdAt: now - DAY * 6, updatedAt: now - DAY * 6,
    },
    {
      id: 'coat_0201', bodyId: 'body_02', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-03-03',
      thicknessUm: 35, state: 'done',
      recheckStatus: 'none', recheckNote: '', recheckAt: null,
      dryingFrom: '', dryingTo: '',
      dryingAdviceHours: 24, dryingAdvicePaintType: 'raw', dryingAdviceAt: now - DAY * 7,
      createdAt: now - DAY * 8, updatedAt: now - DAY * 7,
    },
    {
      // 偏湿挂起：出房记账 21:30，值守实测 22:30（差 60 分钟，超容差）→ 对账挂起等核；超标记录待管理员复检
      id: 'coat_0202', bodyId: 'body_02', seq: 2, paintType: 'color', colorName: '赭石', coatDate: '2026-03-04',
      thicknessUm: 42, state: 'coated',
      recheckStatus: 'none', recheckNote: '', recheckAt: null,
      dryingFrom: '2026-03-05T10:00', dryingTo: '2026-03-05T21:30',
      dryingAdviceHours: null, dryingAdvicePaintType: null, dryingAdviceAt: null,
      createdAt: now - DAY * 5, updatedAt: now - DAY * 2,
    },
    {
      id: 'coat_0301', bodyId: 'body_03', seq: 1, paintType: 'raw', colorName: '漆黑', coatDate: '2026-02-10',
      thicknessUm: 38, state: 'done',
      recheckStatus: 'none', recheckNote: '', recheckAt: null,
      dryingFrom: '', dryingTo: '',
      dryingAdviceHours: 24, dryingAdvicePaintType: 'raw', dryingAdviceAt: now - DAY * 25,
      createdAt: now - DAY * 26, updatedAt: now - DAY * 25,
    },
    {
      id: 'coat_0302', bodyId: 'body_03', seq: 2, paintType: 'color', colorName: '石绿', coatDate: '2026-02-18',
      thicknessUm: 44, state: 'done',
      recheckStatus: 'none', recheckNote: '', recheckAt: null,
      dryingFrom: '2026-02-20T09:30', dryingTo: '2026-02-20T21:30',
      dryingAdviceHours: 18, dryingAdvicePaintType: 'color', dryingAdviceAt: now - DAY * 18,
      createdAt: now - DAY * 20, updatedAt: now - DAY * 18,
    },
    {
      id: 'coat_0303', bodyId: 'body_03', seq: 3, paintType: 'topcoat', colorName: '描金', coatDate: '2026-02-26',
      thicknessUm: 28, state: 'done',
      recheckStatus: 'none', recheckNote: '', recheckAt: null,
      dryingFrom: '', dryingTo: '',
      dryingAdviceHours: 12, dryingAdvicePaintType: 'topcoat', dryingAdviceAt: now - DAY * 4,
      createdAt: now - DAY * 14, updatedAt: now - DAY * 4,
    },
  ];

  const rooms: Room[] = [
    {
      id: 'room_0101', bodyId: 'body_01', coatId: 'coat_0101', date: '2026-03-03',
      tempC: 24, humidityPct: 78, inAt: '09:00', outAt: '21:00', verdict: 'suitable',
      reconcileStatus: 'matched', reconcileAt: now - DAY * 10,
      createdAt: now - DAY * 10, updatedAt: now - DAY * 10,
    },
    {
      // 管理员尚未记账本道次时段：从未对账 → 待核
      id: 'room_0102', bodyId: 'body_01', coatId: 'coat_0102', date: '2026-03-07',
      tempC: 27, humidityPct: 56, inAt: '08:30', outAt: '20:00', verdict: 'dry',
      reconcileStatus: 'pending', reconcileAt: 0,
      createdAt: now - DAY * 6, updatedAt: now - DAY * 6,
    },
    {
      // 后补记录（录入时间晚于管理员复检）：只新增待复检线索，不改写 coat_0102 的「复检合格」
      id: 'room_0103', bodyId: 'body_01', coatId: 'coat_0102', date: '2026-03-09',
      tempC: 28, humidityPct: 58, inAt: '08:00', outAt: '19:00', verdict: 'dry',
      reconcileStatus: 'pending', reconcileAt: 0,
      createdAt: now - DAY * 1, updatedAt: now - DAY * 1,
    },
    {
      // 与 coat_0202 记账出房时间相差 30 分钟：对账结论挂起
      id: 'room_0201', bodyId: 'body_02', coatId: 'coat_0202', date: '2026-03-05',
      tempC: 23, humidityPct: 91, inAt: '10:00', outAt: '22:30', verdict: 'wet',
      reconcileStatus: 'suspended', reconcileAt: now - DAY * 1,
      createdAt: now - DAY * 5, updatedAt: now - DAY * 1,
    },
    {
      id: 'room_0301', bodyId: 'body_03', coatId: 'coat_0302', date: '2026-02-20',
      tempC: 25, humidityPct: 76, inAt: '09:30', outAt: '21:30', verdict: 'suitable',
      reconcileStatus: 'matched', reconcileAt: now - DAY * 18,
      createdAt: now - DAY * 18, updatedAt: now - DAY * 18,
    },
  ];

  const polishes: Polish[] = [
    { id: 'polish_0101', bodyId: 'body_01', coatId: 'coat_0101', grit: 600, method: 'water', durationMin: 35, operator: '王丽', createdAt: now - DAY * 9, updatedAt: now - DAY * 9 },
    { id: 'polish_0102', bodyId: 'body_01', coatId: 'coat_0102', grit: 1500, method: 'burnish', durationMin: 45, operator: '王丽', createdAt: now - DAY * 2, updatedAt: now - DAY * 2 },
    { id: 'polish_0201', bodyId: 'body_02', coatId: 'coat_0201', grit: 800, method: 'water', durationMin: 30, operator: '李成', createdAt: now - DAY * 6, updatedAt: now - DAY * 6 },
    { id: 'polish_0301', bodyId: 'body_03', coatId: 'coat_0303', grit: 2000, method: 'burnish', durationMin: 60, operator: '王丽', createdAt: now - DAY * 5, updatedAt: now - DAY * 4 },
  ];

  const inlays: Inlay[] = [
    { id: 'inlay_0101', bodyId: 'body_01', type: 'nacre', pattern: '缠枝莲', position: '外壁', materialNote: '0.8mm 螺钿片，刻纹嵌贴', createdAt: now - DAY * 7, updatedAt: now - DAY * 7 },
    { id: 'inlay_0201', bodyId: 'body_02', type: 'eggshell', pattern: '云纹', position: '盖面', materialNote: '鸭蛋壳拼贴后髹漆磨显', createdAt: now - DAY * 4, updatedAt: now - DAY * 4 },
    { id: 'inlay_0301', bodyId: 'body_03', type: 'incisedGold', pattern: '折枝花', position: '通体', materialNote: '戗金，金粉入刻线', createdAt: now - DAY * 12, updatedAt: now - DAY * 12 },
    { id: 'inlay_0302', bodyId: 'body_03', type: 'goldTrace', pattern: '诗文', position: '外壁', materialNote: '描金，泥金细描', createdAt: now - DAY * 11, updatedAt: now - DAY * 11 },
  ];

  const inspects: Inspect[] = [
    { id: 'inspect_0101', bodyId: 'body_03', verdict: 'pass', defectNote: '', inspector: '周衡', date: '2026-03-02', defectCoatSeq: null, defectRoomId: null, createdAt: now - DAY * 4, updatedAt: now - DAY * 4 },
    { id: 'inspect_0102', bodyId: 'body_02', verdict: 'rework', defectNote: '起皱（荫干过快）', inspector: '周衡', date: '2026-03-08', defectCoatSeq: 2, defectRoomId: 'room_0201', createdAt: now - DAY, updatedAt: now - DAY },
  ];

  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(bodies);
    await db.coats.bulkPut(coats);
    await db.rooms.bulkPut(rooms);
    await db.polishes.bulkPut(polishes);
    await db.inlays.bulkPut(inlays);
    await db.inspects.bulkPut(inspects);
  });
}

/* ------------------------------ 整库导入导出 ------------------------------ */

export interface LacquerSnapshot {
  app: typeof DB_NAME;
  schemaVersion: number;
  exportedAt: string;
  bodies: Body[];
  coats: Coat[];
  rooms: Room[];
  polishes: Polish[];
  inlays: Inlay[];
  inspects: Inspect[];
}

export async function exportSnapshot(): Promise<LacquerSnapshot> {
  const [bodies, coats, rooms, polishes, inlays, inspects] = await Promise.all([
    db.bodies.toArray(),
    db.coats.toArray(),
    db.rooms.toArray(),
    db.polishes.toArray(),
    db.inlays.toArray(),
    db.inspects.toArray(),
  ]);
  return {
    app: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    bodies,
    coats,
    rooms,
    polishes,
    inlays,
    inspects,
  };
}

/** 校验导入文件结构，返回错误文案（空串表示通过） */
export function validateSnapshot(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '文件内容不是合法的 JSON 对象';
  const snapshot = input as Partial<LacquerSnapshot>;
  if (snapshot.app !== DB_NAME) return `备份文件不属于本项目（app=${String(snapshot.app)}）`;
  const keys: Array<keyof LacquerSnapshot> = ['bodies', 'coats', 'rooms', 'polishes', 'inlays', 'inspects'];
  for (const key of keys) {
    if (!Array.isArray(snapshot[key])) return `备份文件缺少 ${String(key)} 集合`;
  }
  return '';
}

/**
 * 把任意旧版本（v1/v2/v3）备份归一到当前结构：
 * 只补字段 / 做归并映射，不改判定语义。
 */
export function normalizeSnapshot(snapshot: LacquerSnapshot): LacquerSnapshot {
  const coats: Coat[] = snapshot.coats.map((row) => {
    const paintType: PaintType = LEGAL_PAINT.includes(row.paintType) ? row.paintType : 'raw';
    const next = {
      ...row,
      paintType,
      thicknessUm: typeof row.thicknessUm === 'number' ? row.thicknessUm : 40,
      recheckStatus: row.recheckStatus === 'pass' || row.recheckStatus === 'fail' ? row.recheckStatus : 'none',
      recheckNote: typeof row.recheckNote === 'string' ? row.recheckNote : '',
      recheckAt: typeof row.recheckAt === 'number' ? row.recheckAt : null,
      dryingFrom: typeof row.dryingFrom === 'string' ? row.dryingFrom : '',
      dryingTo: typeof row.dryingTo === 'string' ? row.dryingTo : '',
      dryingAdviceHours: typeof row.dryingAdviceHours === 'number' ? row.dryingAdviceHours : null,
      dryingAdvicePaintType: LEGAL_PAINT.includes(row.dryingAdvicePaintType as PaintType)
        ? row.dryingAdvicePaintType
        : null,
      dryingAdviceAt: typeof row.dryingAdviceAt === 'number' ? row.dryingAdviceAt : null,
    } as Coat;
    // 旧版 needRecheck 是值守侧回写字段，v3 不迁移：复检结论由管理员重新给
    delete (next as unknown as Record<string, unknown>).needRecheck;
    return next;
  });

  const coatKey = new Map(coats.map((coat) => [`${coat.bodyId}#${coat.seq}`, coat.id]));
  const rooms: Room[] = snapshot.rooms.map((row) => {
    const coatId =
      typeof row.coatId === 'string'
        ? row.coatId
        : (findCoatForRoom(coats, row.bodyId, row.date)?.id ?? null);
    return {
      ...row,
      coatId,
      reconcileStatus:
        row.reconcileStatus === 'matched' || row.reconcileStatus === 'suspended'
          ? row.reconcileStatus
          : 'pending',
      reconcileAt: typeof row.reconcileAt === 'number' ? row.reconcileAt : 0,
    } as Room;
  });

  const polishes: Polish[] = snapshot.polishes.map((row) => {
    const legacy = row as unknown as Record<string, unknown>;
    const coatId =
      typeof row.coatId === 'string' && row.coatId
        ? row.coatId
        : coatKey.get(`${row.bodyId}#${typeof legacy.seq === 'number' ? legacy.seq : 0}`) ?? '';
    const next: Polish = { ...row, coatId } as Polish;
    delete (next as unknown as Record<string, unknown>).seq;
    return next;
  });

  return { ...snapshot, coats, rooms, polishes, schemaVersion: DB_SCHEMA_VERSION };
}

export async function importSnapshot(raw: LacquerSnapshot): Promise<void> {
  const snapshot = normalizeSnapshot(raw);
  await clearAllTables();
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.bodies.bulkPut(snapshot.bodies);
    await db.coats.bulkPut(snapshot.coats);
    await db.rooms.bulkPut(snapshot.rooms);
    await db.polishes.bulkPut(snapshot.polishes);
    await db.inlays.bulkPut(snapshot.inlays);
    await db.inspects.bulkPut(snapshot.inspects);
  });
}

export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await Promise.all([
      db.bodies.clear(),
      db.coats.clear(),
      db.rooms.clear(),
      db.polishes.clear(),
      db.inlays.clear(),
      db.inspects.clear(),
    ]);
  });
}

/** 清空并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables();
  await seedDatabase();
}

export async function countAll(): Promise<Record<string, number>> {
  const [bodies, coats, rooms, polishes, inlays, inspects] = await Promise.all([
    db.bodies.count(),
    db.coats.count(),
    db.rooms.count(),
    db.polishes.count(),
    db.inlays.count(),
    db.inspects.count(),
  ]);
  return { bodies, coats, rooms, polishes, inlays, inspects };
}

/* ------------------------------ 级联删除 ------------------------------ */

export async function removeBodyCascade(bodyId: string): Promise<void> {
  await db.transaction('rw', TABLE_LIST, async () => {
    await db.coats.where('bodyId').equals(bodyId).delete();
    await db.rooms.where('bodyId').equals(bodyId).delete();
    await db.polishes.where('bodyId').equals(bodyId).delete();
    await db.inlays.where('bodyId').equals(bodyId).delete();
    await db.inspects.where('bodyId').equals(bodyId).delete();
    await db.bodies.delete(bodyId);
  });
}
