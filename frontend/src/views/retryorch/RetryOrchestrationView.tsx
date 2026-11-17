import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  decideConflict,
  downloadBatchPackage,
  downloadFailures,
  ERROR_CATEGORIES,
  getState,
  reclassifyFailure,
  resetAll,
  restoreBatches,
  resubmitBatch,
  runClassification,
} from '@/api/retry-orchestration-service'
import type { GroupMode, OrchestrationState } from '@/data/retry-orchestration'

const OPERATOR = '值班管理员'

const FAILURE_STATUSES = ['待分类', '已归并', '待人工', '已恢复']

const CONFLICT_IMPACT: Record<GroupMode, string> = {
  按错误类别: '同地址记录按错误类别分别进入不同批次，任务编排按类别退避计划分批等待，后续等待计划彼此独立。',
  按采集作业: '同地址记录并入同一采集作业批次，任务编排按作业统一等待，后续等待计划合并为一个。',
}

export default function RetryOrchestrationView() {
  const [state, setState] = useState<OrchestrationState>(() => getState())
  const [message, setMessage] = useState('')
  const [messageOk, setMessageOk] = useState(true)
  const [failureFilters, setFailureFilters] = useState<Record<string, string>>({})
  const [batchFilters, setBatchFilters] = useState<Record<string, string>>({})
  const [checkFilter, setCheckFilter] = useState('')
  const [reclassifyTargets, setReclassifyTargets] = useState<Record<string, string>>({})

  const reload = useCallback(() => {
    setState(getState())
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  function report(result: { ok: boolean; message: string }) {
    setMessageOk(result.ok)
    setMessage(result.message)
    reload()
  }

  const stats = useMemo(
    () => [
      { label: '待分类失败记录', value: state.failures.filter((item) => item.status === '待分类').length },
      { label: '已归并记录', value: state.failures.filter((item) => item.status === '已归并').length },
      { label: '待人工处理', value: state.failures.filter((item) => item.status === '待人工').length },
      { label: '已恢复记录', value: state.failures.filter((item) => item.status === '已恢复').length },
      { label: '幂等重试批次', value: state.batches.length },
      { label: '待判定冲突', value: state.conflicts.filter((item) => item.status === '待判定').length },
    ],
    [state],
  )

  const filteredFailures = useMemo(() => {
    const pairs = Object.entries(failureFilters).filter(([, value]) => value.trim() !== '')
    if (pairs.length === 0) {
      return state.failures
    }
    const fieldMap: Record<string, (item: OrchestrationState['failures'][number]) => string> = {
      采集作业: (item) => item.jobId,
      错误类别: (item) => item.errorCategory,
      当前状态: (item) => item.status,
    }
    return state.failures.filter((item) =>
      pairs.every(([field, value]) => (fieldMap[field]?.(item) ?? '').includes(value.trim())),
    )
  }, [state, failureFilters])

  const filteredBatches = useMemo(() => {
    const pairs = Object.entries(batchFilters).filter(([, value]) => value.trim() !== '')
    if (pairs.length === 0) {
      return state.batches
    }
    return state.batches.filter((batch) =>
      pairs.every(([field, value]) => {
        const text = field === '策略编号' ? batch.policyNo : field === '归并方式' ? batch.groupMode : batch.status
        return text.includes(value.trim())
      }),
    )
  }, [state, batchFilters])

  const filteredChecks = useMemo(() => {
    const keyword = checkFilter.trim()
    if (keyword === '') {
      return state.checks
    }
    return state.checks.filter(
      (item) => item.kind.includes(keyword) || item.detail.includes(keyword) || item.groupKey.includes(keyword),
    )
  }, [state, checkFilter])

  const manualRecords = useMemo(() => state.failures.filter((item) => item.status === '待人工'), [state])

  const openConflicts = state.conflicts.filter((item) => item.status === '待判定')
  const decidedConflicts = state.conflicts.filter((item) => item.status === '已判定')

  return (
    <section className="page" data-module="retry-orchestration">
      <header className="page-head">
        <div>
          <h2>重试编排</h2>
          <p className="page-desc">
            读取失败采集结果、可重试异常与最大重试次数，分类归并失败采集记录并生成幂等重试批次，供采集作业按计划继续。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => report(runClassification(OPERATOR))}>
            执行重试编排
          </button>
          <button className="btn" type="button" onClick={() => report(restoreBatches(OPERATOR))}>
            任务编排恢复
          </button>
          <button className="btn" type="button" onClick={() => downloadFailures()}>
            导出失败清单
          </button>
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              resetAll()
              setMessageOk(true)
              setMessage('重试编排数据已重置为示例数据')
              reload()
            }}
          >
            重置编排数据
          </button>
        </div>
      </header>

      <p className="notice-bar">
        幂等约束：同一失败记录重复进入分类只占一个重试位置，重复触发不会生成第二个批次；不可重试记录单独保留在待人工处理区，
        达到重试上限后仍保留最后一次错误；重试批次与原失败记录一起保存。
      </p>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      {message && <p className={messageOk ? 'ok-text' : 'error-text'}>{message}</p>}
      {state.lastClassifiedAt && <p className="page-desc">最近一次分类归并：{state.lastClassifiedAt}</p>}

      <h3 className="section-title">冲突判定</h3>
      <p className="page-desc">
        同一地址的网络错误和认证错误同时进入分类时，按错误类别分组与按采集作业分组会形成不同的重试批次内容和后续等待计划，
        需要值班员作出判定；两种做法会让任务编排状态走向不同，判定后幂等重试批次供复核。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>冲突编号</th>
            <th>失败地址</th>
            <th>同时出现的错误类别</th>
            <th>涉及失败记录</th>
            <th>判定</th>
          </tr>
        </thead>
        <tbody>
          {openConflicts.map((conflict) => (
            <tr key={conflict.id}>
              <td>{conflict.id}</td>
              <td>{conflict.address}</td>
              <td>{conflict.categories.join('、')}</td>
              <td>{conflict.recordIds.join('、')}</td>
              <td className="row-actions">
                {(['按错误类别', '按采集作业'] as GroupMode[]).map((mode) => (
                  <button
                    key={mode}
                    className="link"
                    type="button"
                    title={CONFLICT_IMPACT[mode]}
                    onClick={() => report(decideConflict(conflict.id, mode, OPERATOR))}
                  >
                    判定{mode}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {decidedConflicts.map((conflict) => (
            <tr key={conflict.id}>
              <td>{conflict.id}</td>
              <td>{conflict.address}</td>
              <td>{conflict.categories.join('、')}</td>
              <td>{conflict.recordIds.join('、')}</td>
              <td>
                已判定{conflict.decision}（{conflict.decidedBy}，{conflict.decidedAt}）
              </td>
            </tr>
          ))}
          {state.conflicts.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={5}>
                暂无同地址多类错误冲突
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">失败采集记录</h3>
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        {['采集作业', '错误类别', '当前状态'].map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={failureFilters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFailureFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn ghost" type="button" onClick={() => setFailureFilters({})}>
          重置条件
        </button>
      </form>
      <table className="data-table">
        <thead>
          <tr>
            <th>失败编号</th>
            <th>采集作业</th>
            <th>失败地址</th>
            <th>错误类别</th>
            <th>最后一次错误</th>
            <th>已重试次数</th>
            <th>当前状态</th>
            <th>所属批次</th>
            <th>重新分类</th>
          </tr>
        </thead>
        <tbody>
          {filteredFailures.map((record) => (
            <tr key={record.id}>
              <td>{record.id}</td>
              <td>{record.jobId}</td>
              <td>{record.address}</td>
              <td>{record.errorCategory}</td>
              <td>{record.lastError}</td>
              <td>{record.retryCount}</td>
              <td>{record.status}</td>
              <td>{record.batchId ?? '—'}</td>
              <td className="row-actions">
                {record.status !== '已恢复' ? (
                  <>
                    <select
                      value={reclassifyTargets[record.id] ?? record.errorCategory}
                      onChange={(event) =>
                        setReclassifyTargets((prev) => ({ ...prev, [record.id]: event.target.value }))
                      }
                    >
                      {ERROR_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                    <button
                      className="link"
                      type="button"
                      onClick={() =>
                        report(reclassifyFailure(record.id, reclassifyTargets[record.id] ?? record.errorCategory, OPERATOR))
                      }
                    >
                      重新分类
                    </button>
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
          {filteredFailures.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={9}>
                暂无符合条件的失败采集记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">幂等重试批次</h3>
      <p className="page-desc">
        批次按重试机制的策略编号判定生成，重试策略、重试机制、策略编号保持可检索；修复后再次提交同一批次，发布前完成打包。
      </p>
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        {['策略编号', '归并方式', '当前状态'].map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={batchFilters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setBatchFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn ghost" type="button" onClick={() => setBatchFilters({})}>
          重置条件
        </button>
      </form>
      <table className="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>归并方式</th>
            <th>归并键</th>
            <th>策略编号</th>
            <th>最大重试次数</th>
            <th>批次记录</th>
            <th>当前状态</th>
            <th>再次提交次数</th>
            <th>本日数据凭据</th>
            <th>确认记录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {filteredBatches.map((batch) => (
            <tr key={batch.id}>
              <td>{batch.id}</td>
              <td>{batch.groupMode}</td>
              <td>{batch.groupKey}</td>
              <td>{batch.policyNo}</td>
              <td>{batch.maxRetry}</td>
              <td>{batch.recordIds.length > 0 ? batch.recordIds.join('、') : '—'}</td>
              <td>{batch.status}</td>
              <td>{batch.resubmitCount}</td>
              <td>{batch.credential || '—'}</td>
              <td>
                {batch.confirmations.length > 0
                  ? batch.confirmations.map((item) => `${item.confirmNo}（${item.confirmedAt}）`).join('；')
                  : '—'}
              </td>
              <td className="row-actions">
                <button className="link" type="button" onClick={() => report(resubmitBatch(batch.id, OPERATOR))}>
                  再次提交同一批次
                </button>
                <button
                  className="link"
                  type="button"
                  onClick={() => {
                    if (!downloadBatchPackage(batch.id)) {
                      setMessageOk(false)
                      setMessage(`批次 ${batch.id} 打包失败`)
                    }
                  }}
                >
                  打包下载
                </button>
              </td>
            </tr>
          ))}
          {filteredBatches.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={11}>
                暂无幂等重试批次，先执行重试编排
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">归并记录（两种方式同时记录）</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>归并编号</th>
            <th>归并方式</th>
            <th>归并键</th>
            <th>失败记录</th>
            <th>所属批次</th>
            <th>记录时间</th>
          </tr>
        </thead>
        <tbody>
          {state.groups.map((group) => (
            <tr key={group.id}>
              <td>{group.id}</td>
              <td>{group.mode}</td>
              <td>{group.groupKey}</td>
              <td>{group.recordId}</td>
              <td>{group.batchId ?? '—'}</td>
              <td>{group.createdAt}</td>
            </tr>
          ))}
          {state.groups.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={6}>
                暂无归并记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">待人工处理区</h3>
      <p className="page-desc">
        不可重试记录在此单独保留，作为失败证据不随重试批次删除；重复触发重试编排不会为它们生成第二个批次。
      </p>
      <table className="data-table">
        <thead>
          <tr>
            <th>失败编号</th>
            <th>采集作业</th>
            <th>失败地址</th>
            <th>错误类别</th>
            <th>最后一次错误</th>
            <th>已重试次数</th>
            <th>保留原因</th>
          </tr>
        </thead>
        <tbody>
          {manualRecords.map((record) => (
            <tr key={record.id}>
              <td>{record.id}</td>
              <td>{record.jobId}</td>
              <td>{record.address}</td>
              <td>{record.errorCategory}</td>
              <td>{record.lastError}</td>
              <td>{record.retryCount}</td>
              <td>{record.exhausted ? '达到最大重试次数，保留最后一次错误' : '不可重试异常，保留失败证据'}</td>
            </tr>
          ))}
          {manualRecords.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={7}>
                待人工处理区暂无记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">核对记录</h3>
      <p className="page-desc">值班员操作完成后，重试机制用户可在此核对按错误类别归并重试记录产生的核对记录。</p>
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault()
        }}
      >
        <label className="filter-item">
          <span>核对类型 / 内容</span>
          <input value={checkFilter} placeholder="检索核对记录" onChange={(event) => setCheckFilter(event.target.value)} />
        </label>
        <button className="btn ghost" type="button" onClick={() => setCheckFilter('')}>
          重置条件
        </button>
      </form>
      <table className="data-table">
        <thead>
          <tr>
            <th>核对编号</th>
            <th>核对类型</th>
            <th>归并方式</th>
            <th>归并键</th>
            <th>关联批次</th>
            <th>核对人</th>
            <th>核对时间</th>
            <th>核对详情</th>
          </tr>
        </thead>
        <tbody>
          {filteredChecks.map((check) => (
            <tr key={check.id}>
              <td>{check.id}</td>
              <td>{check.kind}</td>
              <td>{check.mode}</td>
              <td>{check.groupKey}</td>
              <td>{check.batchId ?? '—'}</td>
              <td>{check.operator}</td>
              <td>{check.checkedAt}</td>
              <td>{check.detail}</td>
            </tr>
          ))}
          {filteredChecks.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={8}>
                暂无核对记录
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>
          共 {state.failures.length} 条失败采集记录、{state.batches.length} 个幂等重试批次、{state.checks.length} 条核对记录
        </span>
        <span>编排数据保存在本机浏览器 localStorage，重置后回到示例数据</span>
      </footer>
    </section>
  )
}
