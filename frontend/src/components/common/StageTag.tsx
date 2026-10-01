/**
 * <StageTag> 阶段标签
 * 按胎体状态（待髹涂/髹涂中/待荫干/已完成）与道次状态（待涂/已涂/待打磨/已完成）渲染底色。
 *
 * 复检徽标两种模式（都由两侧数据只读派生，标签本身不触发任何写入）：
 * - 道次复检视图 recheckView：待复检（可标注「复检后新增 n 条」）/ 复检合格 / 复检不合格；
 * - 布尔 needRecheck：胎体卡片等只需「有没有待复检道次」的聚合场景。
 */
import { Tag, Tooltip } from 'antd';
import { CheckCircleOutlined, ExclamationCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { BODY_STATE_COLOR, BODY_STATE_LABEL, type BodyState } from '@/types/body';
import { COAT_STATE_COLOR, COAT_STATE_LABEL, type CoatState } from '@/types/coat';
import type { CoatRecheckView } from '@/utils/reconcile';

export type StageKey = BodyState | CoatState;

export interface StageTagProps {
  /** 状态键：胎体状态或道次状态 */
  state: StageKey;
  /** 简单聚合场景：是否存在待复检 */
  needRecheck?: boolean;
  /** 道次复检视图（道次页 / 打磨页逐道展示用） */
  recheckView?: CoatRecheckView;
  /** 道次序号，传入时前缀显示「第 n 道」 */
  seq?: number;
  /** 追加文案，如「已完成 2/4」 */
  suffix?: string;
}

const LABEL: Record<string, string> = { ...BODY_STATE_LABEL, ...COAT_STATE_LABEL };
const COLOR: Record<string, string> = { ...BODY_STATE_COLOR, ...COAT_STATE_COLOR };

export function StageTag({ state, needRecheck = false, recheckView, seq, suffix }: StageTagProps) {
  const label = LABEL[state] ?? state;
  const color = COLOR[state] ?? '#8c8c8c';
  const text = `${seq === undefined ? '' : `第 ${seq} 道 · `}${label}${suffix ? ` · ${suffix}` : ''}`;

  const pending = recheckView?.pending ?? needRecheck;
  const hasBadge = pending || (recheckView && recheckView.conclusion !== 'none');

  return (
    <>
      <Tag color={color} style={{ marginInlineEnd: hasBadge ? 4 : 0 }}>
        {text}
      </Tag>
      {recheckView && recheckView.pending ? (
        <Tooltip
          title={
            recheckView.conclusion === 'none'
              ? '挂到本道次的荫房记录温湿度越界，等管理员复检'
              : `已有${recheckView.conclusion === 'pass' ? '合格' : '不合格'}结论；复检后又新增 ${recheckView.pendingCount} 条超标记录，待再次复检`
          }
        >
          <Tag icon={<ExclamationCircleOutlined />} color="warning">
            待复检{recheckView.conclusion !== 'none' && recheckView.pendingCount > 0 ? ` ${recheckView.pendingCount}` : ''}
          </Tag>
        </Tooltip>
      ) : recheckView && recheckView.conclusion === 'pass' ? (
        <Tooltip title={recheckView.note ? `管理员复检：${recheckView.note}` : '管理员复检合格'}>
          <Tag icon={<CheckCircleOutlined />} color="success">
            复检合格
          </Tag>
        </Tooltip>
      ) : recheckView && recheckView.conclusion === 'fail' ? (
        <Tooltip title={recheckView.note ? `管理员复检：${recheckView.note}` : '管理员复检不合格，安排返工'}>
          <Tag icon={<CloseCircleOutlined />} color="error">
            复检不合格
          </Tag>
        </Tooltip>
      ) : null}
    </>
  );
}

export default StageTag;
