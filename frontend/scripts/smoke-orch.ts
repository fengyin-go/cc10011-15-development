// 冒烟测试：在 Node 里跑重试编排服务全流程（localStorage 缺失时自动走内存态）。
import { listRows } from '@/data/local-store'
import {
  decideConflict,
  exportFailures,
  getState,
  packageBatch,
  reclassifyFailure,
  resetAll,
  restoreBatches,
  resubmitBatch,
  runClassification,
} from '@/api/retry-orchestration-service'

let failures = 0

function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name}`, extra === undefined ? '' : JSON.stringify(extra, null, 2))
  }
}

resetAll()
const OP = '值班管理员'

// 1. 首次分类归并
const r1 = runClassification(OP)
check('首次分类归并成功', r1.ok, r1.message)
let s = getState()
check('生成4个幂等重试批次', s.batches.length === 4, s.batches.map((b) => [b.id, b.groupMode, b.groupKey, b.policyNo]))
const netBatch = s.batches.find((b) => b.groupMode === '按错误类别' && b.groupKey === '网络错误')
check('网络错误批次含FR-0001/FR-0002且策略RETR-0001', !!netBatch && netBatch.policyNo === 'RETR-0001' && netBatch.recordIds.sort().join(',') === 'FR-0001,FR-0002', netBatch)
check('FR-0005达到上限进入待人工且保留最后一次错误', s.failures.find((f) => f.id === 'FR-0005')?.status === '待人工' && s.failures.find((f) => f.id === 'FR-0005')?.lastError === '列表选择器未命中')
check('FR-0007不可重试进入待人工', s.failures.find((f) => f.id === 'FR-0007')?.status === '待人工')
check('同地址网络+认证错误触发1起待判定冲突', s.conflicts.length === 1 && s.conflicts[0].status === '待判定' && s.conflicts[0].address === 'https://data.example.com/list/1', s.conflicts)
check('按错误类别与按采集作业归并记录同时存在', s.groups.some((g) => g.mode === '按错误类别') && s.groups.some((g) => g.mode === '按采集作业'))
check('分类归并核对记录已生成', s.checks.some((c) => c.kind === '分类归并核对'))

// 2. 幂等：重复触发不生成第二个批次
const r2 = runClassification(OP)
s = getState()
check('重复触发不生成第二个批次', !r2.ok && s.batches.length === 4, r2.message)

// 3. 冲突判定为按采集作业
const conflictId = getState().conflicts[0].id
const r3 = decideConflict(conflictId, '按采集作业', OP)
s = getState()
check('冲突判定成功', r3.ok, r3.message)
const jobBatch = s.batches.find((b) => b.groupMode === '按采集作业' && b.groupKey === 'SPID-0001')
check('FR-0001/FR-0004并入SPID-0001作业批次', !!jobBatch && jobBatch.recordIds.sort().join(',') === 'FR-0001,FR-0004', jobBatch)
check('FR-0002仍占网络错误批次唯一位置', s.batches.find((b) => b.groupKey === '网络错误')?.recordIds.join(',') === 'FR-0002')
check('冲突判定核对记录已生成', s.checks.some((c) => c.kind === '冲突判定核对'))
const r3dup = decideConflict(conflictId, '按错误类别', OP)
check('冲突不能重复判定', !r3dup.ok)

// 4. 任务编排恢复：只恢复可重试记录，回写采集作业
const r4 = restoreBatches(OP)
s = getState()
check('任务编排恢复成功', r4.ok, r4.message)
check('FR-0001已恢复且重试次数+1', s.failures.find((f) => f.id === 'FR-0001')?.status === '已恢复' && s.failures.find((f) => f.id === 'FR-0001')?.retryCount === 2)
check('批次保留确认记录与本日数据凭据', s.batches.every((b) => b.confirmations.length >= 1 && b.credential.startsWith('CRED-')), s.batches.map((b) => [b.id, b.credential]))
check('恢复前核对记录（按错误类别）已生成', s.checks.some((c) => c.kind === '恢复前核对' && c.mode === '按错误类别'))
const spider1 = listRows('spider').find((row) => String(row['作业编号']) === 'SPID-0001')
check('任务编排回写：SPID-0001回到待执行且待处理区同步', spider1?.status === '待执行' && spider1?.pending === true, spider1)

// 5. 修复后再次提交同一批次（不生成新批次）
const before = s.batches.length
const r5 = resubmitBatch(jobBatch!.id, OP)
s = getState()
check('再次提交同一批次成功且不生成新批次', r5.ok && s.batches.length === before, r5.message)
check('再次提交批次回到待执行', s.batches.find((b) => b.id === jobBatch!.id)?.status === '待执行')

// 6. 再次恢复：FR-0003所在认证错误批次也再次提交后，FR-0003达到RETR-0002上限(2次)进入待人工并保留最后错误
const authBatch = s.batches.find((b) => b.policyNo === 'RETR-0002' && b.groupKey === '认证错误')
resubmitBatch(authBatch!.id, OP)
restoreBatches(OP)
s = getState()
const fr3 = s.failures.find((f) => f.id === 'FR-0003')
check('FR-0003达到上限进入待人工且保留最后一次错误', fr3?.status === '待人工' && fr3?.exhausted === true && fr3?.lastError === '401 未授权', fr3)
check('上一份确认记录仍保留', s.batches.every((b) => b.status !== '已恢复' || b.confirmations.length >= 1))

// 7. 值班员重新分类待人工记录
const r7 = reclassifyFailure('FR-0007', '网络错误', OP)
s = getState()
check('值班员重新分类成功', r7.ok && s.failures.find((f) => f.id === 'FR-0007')?.status === '待分类', r7.message)
check('重新分类核对记录已生成', s.checks.some((c) => c.kind === '重新分类核对'))
runClassification(OP)
s = getState()
check('重新分类后重新归并进批次', s.failures.find((f) => f.id === 'FR-0007')?.status === '已归并')

// 8. 导出与打包
const csv = exportFailures()
check('失败清单可导出', csv.filename.endsWith('.csv') && csv.content.includes('FR-0001') && csv.content.includes('待人工'))
const restoredBatch = s.batches.find((b) => b.confirmations.length > 0)
const pkg = restoredBatch ? packageBatch(restoredBatch.id) : null
check('发布前批次可打包', !!pkg && pkg.filename.endsWith('.json') && pkg.content.includes('本日数据凭据'))

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
