/**
 * 髹涂道次（Coat）数据模型
 * 一件胎体上的逐道髹涂记录：漆种、色名、涂刷日期、湿膜厚度与状态推进。
 *
 * 边界约定：Coat 归工序管理员侧维护（编排 / 状态推进 / 复检结论 / 荫干时段记账 / 荫干建议）。
 * 值守侧（荫房）对本表只读；越界的荫房记录通过 Room.coatId「挂」到道次上，
 * 是否需要复检由两侧数据派生，管理员的复检结论落本表且不会被后补的荫房记录改写。
 */

/** 漆种：生漆 / 色漆 / 罩漆 */
export type PaintType = 'raw' | 'color' | 'topcoat';

/** 道次状态：待涂 / 已涂 / 待打磨 / 已完成 */
export type CoatState = 'todo' | 'coated' | 'toPolish' | 'done';

/** 管理员复检结论：未复检 / 复检合格 / 复检不合格 */
export type CoatRecheckConclusion = 'none' | 'pass' | 'fail';

export interface Coat {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 道次序号，从 1 开始连续整数 */
  seq: number;
  /** 漆种 */
  paintType: PaintType;
  /** 色名，如「朱红」「漆黑」 */
  colorName: string;
  /** 涂刷日期 yyyy-MM-dd */
  coatDate: string;
  /** 湿膜厚度（微米） */
  thicknessUm: number;
  /** 当前状态 */
  state: CoatState;

  /* --------------------- 管理员侧：复检结论（对挂到本道次的超标荫房记录） --------------------- */
  /** 最近一次管理员复检结论；派生的「待复检」见 utils/reconcile.ts coatRecheckView() */
  recheckStatus: CoatRecheckConclusion;
  /** 复检备注 */
  recheckNote: string;
  /** 最近一次复检时间戳；晚于该时间的超标荫房记录视为「复检后新增」，只挂起不改写结论 */
  recheckAt: number | null;

  /* --------------------- 管理员侧：本道次荫干时段记账（与值守侧 Room 对账） --------------------- */
  /** 计划 / 记账的入荫时间 yyyy-MM-ddTHH:mm（datetime-local），空串表示未记账 */
  dryingFrom: string;
  /** 计划 / 记账的出荫时间 yyyy-MM-ddTHH:mm，空串表示未记账 */
  dryingTo: string;

  /* --------------------- 管理员侧：荫干时长建议（漆种一变即失效，需重算） --------------------- */
  /** 建议荫干时长（小时），null 表示尚无有效建议 */
  dryingAdviceHours: number | null;
  /** 建议所依据的漆种；与当前 paintType 不一致即视为建议已失效 */
  dryingAdvicePaintType: PaintType | null;
  /** 建议计算时间戳 */
  dryingAdviceAt: number | null;

  createdAt: number;
  updatedAt: number;
}

export type CoatDraft = Omit<Coat, 'id' | 'createdAt' | 'updatedAt'>;

export const PAINT_TYPE_LABEL: Record<PaintType, string> = {
  raw: '生漆',
  color: '色漆',
  topcoat: '罩漆',
};

export const COAT_STATE_LABEL: Record<CoatState, string> = {
  todo: '待涂',
  coated: '已涂',
  toPolish: '待打磨',
  done: '已完成',
};

export const COAT_STATE_COLOR: Record<CoatState, string> = {
  todo: '#8c8c8c',
  coated: '#c9963c',
  toPolish: '#8c2f1f',
  done: '#2f6f4f',
};

export const COAT_RECHECK_LABEL: Record<CoatRecheckConclusion, string> = {
  none: '未复检',
  pass: '复检合格',
  fail: '复检不合格',
};

export const COAT_RECHECK_COLOR: Record<CoatRecheckConclusion, string> = {
  none: '#8c8c8c',
  pass: '#2f6f4f',
  fail: '#b03a2e',
};

/** 复检表单只允许给明确结论，不允许在表单里选「未复检」 */
export const COAT_RECHECK_OPTIONS: ReadonlyArray<{ value: Exclude<CoatRecheckConclusion, 'none'>; label: string }> = [
  { value: 'pass', label: '复检合格' },
  { value: 'fail', label: '复检不合格（安排返工）' },
];

export const COAT_STATE_FLOW: readonly CoatState[] = ['todo', 'coated', 'toPolish', 'done'];

export const PAINT_TYPE_OPTIONS: ReadonlyArray<{ value: PaintType; label: string }> = [
  { value: 'raw', label: '生漆' },
  { value: 'color', label: '色漆' },
  { value: 'topcoat', label: '罩漆' },
];

export const COAT_STATE_OPTIONS: ReadonlyArray<{ value: CoatState; label: string }> =
  COAT_STATE_FLOW.map((state) => ({ value: state, label: COAT_STATE_LABEL[state] }));

/** 色名候选，表单下拉直接复用 */
export const COLOR_NAME_OPTIONS: readonly string[] = [
  '漆黑',
  '朱红',
  '赭石',
  '藤黄',
  '石绿',
  '推光本色',
  '描金',
];

export function nextCoatState(state: CoatState): CoatState {
  const index = COAT_STATE_FLOW.indexOf(state);
  if (index < 0 || index >= COAT_STATE_FLOW.length - 1) return state;
  return COAT_STATE_FLOW[index + 1] as CoatState;
}

/** 荫干建议是否仍对应当前漆种（漆种一变即失效） */
export function dryingAdviceValid(coat: Pick<Coat, 'dryingAdviceHours' | 'dryingAdvicePaintType' | 'paintType'>): boolean {
  return coat.dryingAdviceHours !== null && coat.dryingAdvicePaintType === coat.paintType;
}

export function createEmptyCoatDraft(bodyId: string, seq: number): CoatDraft {
  return {
    bodyId,
    seq,
    paintType: 'raw',
    colorName: '漆黑',
    coatDate: new Date().toISOString().slice(0, 10),
    thicknessUm: 40,
    state: 'todo',
    recheckStatus: 'none',
    recheckNote: '',
    recheckAt: null,
    dryingFrom: '',
    dryingTo: '',
    dryingAdviceHours: null,
    dryingAdvicePaintType: null,
    dryingAdviceAt: null,
  };
}
