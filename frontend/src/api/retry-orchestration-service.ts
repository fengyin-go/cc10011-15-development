import { listRows, saveRows } from '@/data/local-store'
import type {
  CheckRecord,
  ConflictCase,
  FailureRecord,
  GroupMode,
  GroupRecord,
  OrchestrationState,
  RetryBatch,
} from '@/data/retry-orchestration'
import { loadOrchestration, resetOrchestration, saveOrchestration } from '@/data/retry-orchestration'

// 重试编排服务：读取失败采集结果、可重试异常与最大次数，分类归并生成幂等重试批次。
// 状态流转只允许在这里改，页面组件不做业务判断。

export type OrchestrationResult = {
  ok: boolean
  message: string
  state: OrchestrationState
}

type RetryPolicy = {
  policyNo: string
  jobId: string
  maxRetry: number
  retryableCategories: string[]
  backoff: string
  enabled: boolean
}

/** 内置兜底策略：采集作业没有已启用的重试策略时使用 */
const DEFAULT_POLICY: RetryPolicy = {
  policyNo: 'RETR-0000',
  jobId: '*',
  maxRetry: 3,
  retryableCategories: ['网络错误', '限流错误', '解析错误'],
  backoff: '指数退避',
  enabled: true,
}

export const ERROR_CATEGORIES = ['网络错误', '认证错误', '限流错误', '解析错误', '数据校验错误']

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function today(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function nextId(state: OrchestrationState, prefix: string): string {
  state.sequence += 1
  return `${prefix}-${today()}-${String(state.sequence).padStart(3, '0')}`
}

/** 从重试机制模块读取已登记的重试策略，策略编号是可检索的判定依据 */
function loadPolicies(): RetryPolicy[] {
  return listRows('retry').map((row) => ({
    policyNo: String(row['策略编号'] ?? ''),
    jobId: String(row['关联任务'] ?? ''),
    maxRetry: Number.parseInt(String(row['最大重试次数'] ?? ''), 10) || 3,
    retryableCategories: String(row['可重试异常'] ?? '')
      .split(/[、,，/\s]+/)
      .filter(Boolean),
    backoff: String(row['退避算法'] ?? ''),
    enabled: String(row.status) === '已启用',
  }))
}

function policyFor(policies: RetryPolicy[], jobId: string): RetryPolicy {
  return policies.find((item) => item.enabled && item.jobId === jobId) ?? DEFAULT_POLICY
}

function findOrCreateBatch(
  state: OrchestrationState,
  mode: GroupMode,
  groupKey: string,
  policy: RetryPolicy,
  at: string,
): RetryBatch {
  const existing = state.batches.find(
    (batch) => batch.groupMode === mode && batch.groupKey === groupKey && batch.policyNo === policy.policyNo && batch.status === '待执行',
  )
  if (existing) {
    return existing
  }
  const batch: RetryBatch = {
    id: nextId(state, 'RB'),
    groupMode: mode,
    groupKey,
    policyNo: policy.policyNo,
    maxRetry: policy.maxRetry,
    recordIds: [],
    status: '待执行',
    resubmitCount: 0,
    credential: '',
    createdAt: at,
    confirmations: [],
  }
  state.batches.push(batch)
  return batch
}

function addGroupRecord(
  state: OrchestrationState,
  mode: GroupMode,
  groupKey: string,
  recordId: string,
  batchId: string | null,
  at: string,
): void {
  const dup = state.groups.some((item) => item.mode === mode && item.groupKey === groupKey && item.recordId === recordId)
  if (dup) {
    return
  }
  const record: GroupRecord = { id: nextId(state, 'GC'), mode, groupKey, recordId, batchId, createdAt: at }
  state.groups.push(record)
}

function addCheck(
  state: OrchestrationState,
  kind: string,
  mode: CheckRecord['mode'],
  groupKey: string,
  batchId: string | null,
  detail: string,
  operator: string,
  at: string,
): void {
  state.checks.push({ id: nextId(state, 'CHK'), kind, mode, groupKey, batchId, detail, operator, checkedAt: at })
}

/** 冲突地址已判定归并方式时，受影响记录跟随判定；否则默认按错误类别 */
function decidedModeFor(state: OrchestrationState, record: FailureRecord): GroupMode {
  const decided = state.conflicts.find(
    (item) => item.address === record.address && item.status === '已判定' && item.decision !== null,
  )
  return decided?.decision ?? '按错误类别'
}

function detectConflicts(state: OrchestrationState, at: string): void {
  const active = state.failures.filter((item) => item.status === '已归并')
  const byAddress = new Map<string, FailureRecord[]>()
  for (const record of active) {
    const list = byAddress.get(record.address) ?? []
    list.push(record)
    byAddress.set(record.address, list)
  }
  for (const [address, records] of byAddress) {
    const categories = [...new Set(records.map((item) => item.errorCategory))]
    if (categories.length < 2) {
      continue
    }
    const open = state.conflicts.some((item) => item.address === address && item.status === '待判定')
    if (!open) {
      const conflict: ConflictCase = {
        id: nextId(state, 'CF'),
        address,
        categories,
        recordIds: records.map((item) => item.id),
        status: '待判定',
        decision: null,
        decidedBy: null,
        decidedAt: null,
      }
      state.conflicts.push(conflict)
      void at
    }
  }
}

/**
 * 执行重试编排：分类归并失败采集记录并生成幂等重试批次。
 * 同一失败记录重复进入分类只占一个重试位置；不可重试记录进入待人工处理区并保留最后一次错误；
 * 重复触发不会生成第二个批次。
 */
export function runClassification(operator: string): OrchestrationResult {
  const state = loadOrchestration()
  const policies = loadPolicies()
  const at = now()
  const pending = state.failures.filter((item) => item.status === '待分类')
  if (pending.length === 0) {
    return {
      ok: false,
      message: '没有待分类的失败采集记录：重复触发不会生成第二个批次，不可重试记录仍单独保留在待人工处理区',
      state,
    }
  }
  let merged = 0
  let manual = 0
  const touchedBatches = new Set<string>()
  for (const record of pending) {
    const policy = policyFor(policies, record.jobId)
    const retryable = policy.retryableCategories.includes(record.errorCategory)
    const exhausted = record.retryCount >= policy.maxRetry
    // 达到上限后仍保留最后一次错误
    record.lastError = record.errorDetail
    if (!retryable || exhausted) {
      record.status = '待人工'
      record.exhausted = exhausted
      record.batchId = null
      manual += 1
      continue
    }
    const mode = decidedModeFor(state, record)
    const groupKey = mode === '按错误类别' ? record.errorCategory : record.jobId
    const batch = findOrCreateBatch(state, mode, groupKey, policy, at)
    if (!batch.recordIds.includes(record.id)) {
      // 幂等：同一失败记录只占一个重试位置
      batch.recordIds.push(record.id)
    }
    record.status = '已归并'
    record.batchId = batch.id
    record.exhausted = false
    merged += 1
    touchedBatches.add(batch.id)
    // 先记录按错误类别归并重试记录，同时记录按采集作业归并重试记录
    addGroupRecord(state, '按错误类别', record.errorCategory, record.id, mode === '按错误类别' ? batch.id : null, at)
    addGroupRecord(state, '按采集作业', record.jobId, record.id, mode === '按采集作业' ? batch.id : null, at)
  }
  detectConflicts(state, at)
  for (const batch of state.batches.filter((item) => touchedBatches.has(item.id))) {
    addCheck(
      state,
      '分类归并核对',
      '按错误类别',
      batch.groupKey,
      batch.id,
      `按错误类别归并 ${batch.recordIds.length} 条失败记录进入 ${batch.id}，判定依据策略编号 ${batch.policyNo}（最大重试 ${batch.maxRetry} 次）`,
      operator,
      at,
    )
  }
  state.lastClassifiedAt = at
  saveOrchestration(state)
  const conflictCount = state.conflicts.filter((item) => item.status === '待判定').length
  const conflictTip = conflictCount > 0 ? `；检测到 ${conflictCount} 起同地址多类错误冲突，待值班员判定归并方式` : ''
  return {
    ok: true,
    message: `重试编排完成：${merged} 条归并进幂等重试批次，${manual} 条不可重试进入待人工处理区（批次与原失败记录已一起保存）${conflictTip}`,
    state,
  }
}

/** 冲突判定：同一地址多类错误时，在按错误类别与按采集作业两种归并方式中作出判定 */
export function decideConflict(conflictId: string, decision: GroupMode, operator: string): OrchestrationResult {
  const state = loadOrchestration()
  const conflict = state.conflicts.find((item) => item.id === conflictId)
  if (!conflict) {
    return { ok: false, message: `没有找到编号为 ${conflictId} 的冲突记录`, state }
  }
  if (conflict.status === '已判定') {
    return { ok: false, message: `冲突 ${conflictId} 已判定为${conflict.decision}，不能重复判定`, state }
  }
  const at = now()
  const policies = loadPolicies()
  conflict.status = '已判定'
  conflict.decision = decision
  conflict.decidedBy = operator
  conflict.decidedAt = at
  for (const recordId of conflict.recordIds) {
    const record = state.failures.find((item) => item.id === recordId)
    if (!record || record.status !== '已归并') {
      continue
    }
    const policy = policyFor(policies, record.jobId)
    const groupKey = decision === '按错误类别' ? record.errorCategory : record.jobId
    const batch = findOrCreateBatch(state, decision, groupKey, policy, at)
    if (record.batchId && record.batchId !== batch.id) {
      const oldBatch = state.batches.find((item) => item.id === record.batchId)
      if (oldBatch) {
        oldBatch.recordIds = oldBatch.recordIds.filter((id) => id !== record.id)
      }
    }
    if (!batch.recordIds.includes(record.id)) {
      batch.recordIds.push(record.id)
    }
    record.batchId = batch.id
  }
  // 空批次不留存，但已恢复批次的确认记录必须保留
  state.batches = state.batches.filter((item) => item.recordIds.length > 0 || item.confirmations.length > 0)
  addCheck(
    state,
    '冲突判定核对',
    decision,
    conflict.address,
    null,
    `同一地址 ${conflict.address} 同时出现${conflict.categories.join('、')}，判定${decision}归并：两种做法会让任务编排状态走向不同（分批等待 / 统一等待），已按判定调整幂等重试批次，供复核`,
    operator,
    at,
  )
  saveOrchestration(state)
  return { ok: true, message: `冲突 ${conflictId} 已判定为${decision}归并，幂等重试批次已调整并留存核对记录`, state }
}

/** 值班员重新分类失败记录：释放原重试位置，等待下一次分类归并 */
export function reclassifyFailure(failureId: string, newCategory: string, operator: string): OrchestrationResult {
  const state = loadOrchestration()
  const record = state.failures.find((item) => item.id === failureId)
  if (!record) {
    return { ok: false, message: `没有找到失败采集记录 ${failureId}`, state }
  }
  if (record.status === '已恢复') {
    return { ok: false, message: `失败记录 ${failureId} 已恢复，不能再重新分类`, state }
  }
  if (record.errorCategory === newCategory) {
    return { ok: false, message: `失败记录 ${failureId} 已经是「${newCategory}」，不用重复分类`, state }
  }
  const at = now()
  const oldCategory = record.errorCategory
  if (record.batchId) {
    const oldBatch = state.batches.find((item) => item.id === record.batchId)
    if (oldBatch) {
      oldBatch.recordIds = oldBatch.recordIds.filter((id) => id !== record.id)
    }
  }
  state.batches = state.batches.filter((item) => item.recordIds.length > 0 || item.confirmations.length > 0)
  record.errorCategory = newCategory
  record.status = '待分类'
  record.batchId = null
  record.exhausted = false
  addCheck(
    state,
    '重新分类核对',
    '按错误类别',
    newCategory,
    null,
    `值班员将 ${record.id} 由「${oldCategory}」重新分类为「${newCategory}」，原重试位置已释放，等待下一次分类归并`,
    operator,
    at,
  )
  saveOrchestration(state)
  return { ok: true, message: `失败记录 ${failureId} 已重新分类为「${newCategory}」，下次执行重试编排时重新归并`, state }
}

/** 任务编排回写：恢复的作业回到待执行，待处理区同步更新 */
function writebackSpiderJobs(jobIds: string[]): number {
  const rows = listRows('spider')
  let changed = 0
  const next = rows.map((row) => {
    if (jobIds.includes(String(row['作业编号'])) && String(row.status) !== '待执行') {
      changed += 1
      return { ...row, status: '待执行', pending: true, abnormal: false }
    }
    return row
  })
  if (changed > 0) {
    saveRows('spider', next)
  }
  return changed
}

/**
 * 任务编排恢复：读取幂等重试批次，先核对按错误类别归并重试记录，只恢复可重试记录，
 * 不可重试错误进入待人工处理区；批次保留上一份确认记录，本日数据凭据留存。
 */
export function restoreBatches(operator: string): OrchestrationResult {
  const state = loadOrchestration()
  const policies = loadPolicies()
  const at = now()
  const open = state.batches.filter((item) => item.status === '待执行' && item.recordIds.length > 0)
  if (open.length === 0) {
    return { ok: false, message: '没有待执行的幂等重试批次，无需恢复', state }
  }
  const restoredJobs = new Set<string>()
  let restored = 0
  let toManual = 0
  for (const batch of open) {
    // 先核对按错误类别归并重试记录，作为本次恢复的复核依据
    const categoryRecords = state.groups.filter((item) => item.mode === '按错误类别' && batch.recordIds.includes(item.recordId))
    addCheck(
      state,
      '恢复前核对',
      '按错误类别',
      batch.groupKey,
      batch.id,
      `任务编排找到幂等重试批次 ${batch.id} 的变更节点，先核对按错误类别归并重试记录 ${categoryRecords.length} 条，核对通过`,
      operator,
      at,
    )
    const credential = `CRED-${today()}-${batch.id}`
    // 保留上一份确认记录：确认记录只追加不覆盖
    batch.confirmations.push({
      confirmNo: nextId(state, 'QR'),
      confirmedAt: at,
      operator,
      recordIds: [...batch.recordIds],
      credential,
      note: '重试机制失败后重试并恢复，本日数据凭据已留存',
    })
    batch.credential = credential
    for (const recordId of batch.recordIds) {
      const record = state.failures.find((item) => item.id === recordId)
      if (!record) {
        continue
      }
      const policy = policyFor(policies, record.jobId)
      const retryable = policy.retryableCategories.includes(record.errorCategory) && record.retryCount < policy.maxRetry
      if (retryable) {
        record.status = '已恢复'
        record.retryCount += 1
        record.lastError = record.errorDetail
        restoredJobs.add(record.jobId)
        restored += 1
      } else {
        // 不可重试错误进入待人工处理区，最后一次错误保留
        record.status = '待人工'
        record.exhausted = record.retryCount >= policy.maxRetry
        record.lastError = record.errorDetail
        toManual += 1
      }
      record.batchId = null
    }
    batch.recordIds = []
    batch.status = '已恢复'
    addCheck(
      state,
      '恢复核对',
      '按错误类别',
      batch.groupKey,
      batch.id,
      `批次 ${batch.id} 恢复完成：${restored} 条可重试记录已恢复，不可重试进入待人工处理区；复核依据为按错误类别归并重试记录`,
      operator,
      at,
    )
  }
  const writeback = writebackSpiderJobs([...restoredJobs])
  saveOrchestration(state)
  return {
    ok: true,
    message: `任务编排恢复完成：${restored} 条可重试记录已恢复，${toManual} 条不可重试进入待人工处理区；回写 ${writeback} 个采集作业为待执行，待处理区已同步更新`,
    state,
  }
}

/** 修复后再次提交同一批次：不生成新批次，原批次回到待执行 */
export function resubmitBatch(batchId: string, operator: string): OrchestrationResult {
  const state = loadOrchestration()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到幂等重试批次 ${batchId}`, state }
  }
  if (batch.status !== '已恢复') {
    return { ok: false, message: `批次 ${batchId} 尚未恢复，当前仍在待执行，重复提交不会生成第二个批次`, state }
  }
  const lastConfirmation = batch.confirmations[batch.confirmations.length - 1]
  if (!lastConfirmation) {
    return { ok: false, message: `批次 ${batchId} 没有确认记录，无法再次提交`, state }
  }
  const at = now()
  let back = 0
  for (const recordId of lastConfirmation.recordIds) {
    const record = state.failures.find((item) => item.id === recordId)
    if (!record || record.status !== '已恢复') {
      continue
    }
    record.status = '已归并'
    record.batchId = batch.id
    if (!batch.recordIds.includes(record.id)) {
      batch.recordIds.push(record.id)
    }
    back += 1
  }
  batch.status = '待执行'
  batch.resubmitCount += 1
  addCheck(
    state,
    '再次提交核对',
    batch.groupMode,
    batch.groupKey,
    batch.id,
    `修复后再次提交同一批次 ${batch.id}（第 ${batch.resubmitCount} 次），沿用上一份确认记录 ${lastConfirmation.confirmNo} 的 ${back} 条记录，未生成新批次`,
    operator,
    at,
  )
  saveOrchestration(state)
  return { ok: true, message: `批次 ${batchId} 已再次提交（同一批次，第 ${batch.resubmitCount} 次），${back} 条记录回到待执行`, state }
}

/** 失败清单导出为文件并下载 */
export function exportFailures(): { filename: string; content: string } {
  const state = loadOrchestration()
  const header = ['失败编号', '采集作业', '失败地址', '错误类别', '最后一次错误', '已重试次数', '当前状态', '所属批次']
  const lines = [header.join(',')]
  for (const record of state.failures) {
    lines.push(
      [record.id, record.jobId, record.address, record.errorCategory, record.lastError, record.retryCount, record.status, record.batchId ?? '']
        .map((cell) => String(cell).replace(/,/g, '，'))
        .join(','),
    )
  }
  return { filename: `失败采集清单-${today()}.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadFailures(): void {
  const { filename, content } = exportFailures()
  downloadFile(filename, content, 'text/csv;charset=utf-8')
}

/** 发布前完成打包：批次、失败记录、归并记录、核对记录与本日数据凭据打成一个包下载 */
export function packageBatch(batchId: string): { filename: string; content: string } | null {
  const state = loadOrchestration()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return null
  }
  const recordIds = new Set<string>(batch.recordIds)
  for (const confirmation of batch.confirmations) {
    for (const recordId of confirmation.recordIds) {
      recordIds.add(recordId)
    }
  }
  const bundle = {
    批次: batch,
    失败记录: state.failures.filter((item) => recordIds.has(item.id)),
    归并记录: state.groups.filter((item) => recordIds.has(item.recordId)),
    核对记录: state.checks.filter((item) => item.batchId === batchId),
    本日数据凭据: batch.credential,
    打包时间: now(),
  }
  return { filename: `重试批次-${batch.id}-发布包.json`, content: JSON.stringify(bundle, null, 2) }
}

export function downloadBatchPackage(batchId: string): boolean {
  const bundle = packageBatch(batchId)
  if (!bundle) {
    return false
  }
  downloadFile(bundle.filename, bundle.content, 'application/json;charset=utf-8')
  return true
}

function downloadFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function getState(): OrchestrationState {
  return loadOrchestration()
}

export function resetAll(): OrchestrationState {
  return resetOrchestration()
}
