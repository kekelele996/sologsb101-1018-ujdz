/**
 * 复检挂起项（Recheck）数据模型
 * 荫房值守与工序管理员之间的边界对象：
 * - 值守侧荫房记录越界（环境越界 / 荫干时段对不上）时，自动「挂起」一条待复检项到对应道次；
 * - 复检结论只能由工序管理员填写，值守侧后续补录的记录不能改写已定结论。
 * 挂起项本身不属于任何一边：荫房记录留在值守侧，道次状态留在管理员侧，两边各自留底。
 */

/** 挂起原因：荫房环境越界 / 荫干时段对账异常 */
export type RecheckReason = 'env' | 'dryingWindow';

/** 复检状态：待管理员复检 / 复检合格 / 需返工（后两者为已定结论） */
export type RecheckStatus = 'pending' | 'passed' | 'failed';

export interface Recheck {
  id: string;
  /** 所属胎体 id（冗余便于按胎体汇总） */
  bodyId: string;
  /** 挂到的道次 id */
  coatId: string;
  /** 触发挂起的荫房记录 id（环境越界必填；时段对账异常可空） */
  roomId: string | null;
  /** 挂起原因 */
  reason: RecheckReason;
  /** 复检状态 */
  status: RecheckStatus;
  /** 复检结论（管理员填写，值守侧不可写） */
  conclusion: string;
  /** 复检人（管理员） */
  inspector: string;
  /** 定论时间（毫秒），未定论为 null */
  concludedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type RecheckDraft = Omit<Recheck, 'id' | 'createdAt' | 'updatedAt'>;

export const RECHECK_REASON_LABEL: Record<RecheckReason, string> = {
  env: '环境越界',
  dryingWindow: '荫干时段对账异常',
};

export const RECHECK_STATUS_LABEL: Record<RecheckStatus, string> = {
  pending: '待复检',
  passed: '复检合格',
  failed: '需返工',
};

export const RECHECK_STATUS_COLOR: Record<RecheckStatus, string> = {
  pending: '#c9963c',
  passed: '#2f6f4f',
  failed: '#b03a2e',
};

/** 已定结论（非待复检）的挂起项，值守侧补录记录不得改写 */
export function isRecheckConcluded(recheck: Recheck): boolean {
  return recheck.status !== 'pending';
}
