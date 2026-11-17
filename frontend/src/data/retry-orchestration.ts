// 重试编排数据层：失败采集记录、幂等重试批次、归并记录、确认记录、核对记录与冲突判定。
// 与模块清单分开持久化，刷新或重开浏览器都还在。

const ORCH_STORAGE_KEY = 'scraper-strategy-studio:retry-orchestration'

export type FailureStatus = '待分类' | '已归并' | '待人工' | '已恢复'
export type GroupMode = '按错误类别' | '按采集作业'
export type BatchStatus = '待执行' | '已恢复'

/** 失败采集记录：原始失败证据，重试批次生成后仍然保留 */
export type FailureRecord = {
  id: string
  jobId: string
  address: string
  errorCategory: string
  errorDetail: string
  /** 达到重试上限后仍保留的最后一次错误 */
  lastError: string
  failedAt: string
  retryCount: number
  status: FailureStatus
  batchId: string | null
  /** 是否因达到最大重试次数进入待人工处理区 */
  exhausted: boolean
}

/** 确认记录：每次恢复时追加，上一份确认记录始终保留 */
export type Confirmation = {
  confirmNo: string
  confirmedAt: string
  operator: string
  recordIds: string[]
  credential: string
  note: string
}

/** 幂等重试批次：同一失败记录只占一个重试位置，重复触发不会生成第二个批次 */
export type RetryBatch = {
  id: string
  groupMode: GroupMode
  groupKey: string
  /** 判定依据：重试机制策略编号 */
  policyNo: string
  maxRetry: number
  recordIds: string[]
  status: BatchStatus
  resubmitCount: number
  /** 本日数据凭据，恢复后留存 */
  credential: string
  createdAt: string
  confirmations: Confirmation[]
}

/** 归并记录：按错误类别与按采集作业两种方式同时记录 */
export type GroupRecord = {
  id: string
  mode: GroupMode
  groupKey: string
  recordId: string
  batchId: string | null
  createdAt: string
}

/** 核对记录：按错误类别归并重试记录产生的核对结果，供重试机制用户复核 */
export type CheckRecord = {
  id: string
  kind: string
  mode: GroupMode | '—'
  groupKey: string
  batchId: string | null
  detail: string
  operator: string
  checkedAt: string
}

/** 冲突判定：同一地址同时出现多类错误时，两种归并方式只能选其一 */
export type ConflictCase = {
  id: string
  address: string
  categories: string[]
  recordIds: string[]
  status: '待判定' | '已判定'
  decision: GroupMode | null
  decidedBy: string | null
  decidedAt: string | null
}

export type OrchestrationState = {
  failures: FailureRecord[]
  batches: RetryBatch[]
  groups: GroupRecord[]
  checks: CheckRecord[]
  conflicts: ConflictCase[]
  sequence: number
  lastClassifiedAt: string | null
}

// 示例失败采集记录：与任务编排（spider）的作业编号对应，首次打开时播种。
const SEED_FAILURES: FailureRecord[] = [
  {
    id: 'FR-0001',
    jobId: 'SPID-0001',
    address: 'https://data.example.com/list/1',
    errorCategory: '网络错误',
    errorDetail: '连接超时(30s)',
    lastError: '连接超时(30s)',
    failedAt: '2026-11-17 08:12',
    retryCount: 1,
    status: '待分类',
    batchId: null,
    exhausted: false,
  },
  {
    id: 'FR-0002',
    jobId: 'SPID-0001',
    address: 'https://data.example.com/list/2',
    errorCategory: '网络错误',
    errorDetail: 'TCP 连接被重置',
    lastError: 'TCP 连接被重置',
    failedAt: '2026-11-17 08:14',
    retryCount: 0,
    status: '待分类',
    batchId: null,
    exhausted: false,
  },
  {
    id: 'FR-0003',
    jobId: 'SPID-0002',
    address: 'https://data.example.com/detail/9',
    errorCategory: '认证错误',
    errorDetail: '401 未授权',
    lastError: '401 未授权',
    failedAt: '2026-11-17 08:20',
    retryCount: 1,
    status: '待分类',
    batchId: null,
    exhausted: false,
  },
  {
    id: 'FR-0004',
    jobId: 'SPID-0001',
    address: 'https://data.example.com/list/1',
    errorCategory: '认证错误',
    errorDetail: '会话 Cookie 失效',
    lastError: '会话 Cookie 失效',
    failedAt: '2026-11-17 08:21',
    retryCount: 0,
    status: '待分类',
    batchId: null,
    exhausted: false,
  },
  {
    id: 'FR-0005',
    jobId: 'SPID-0003',
    address: 'https://mirror.example.org/a',
    errorCategory: '解析错误',
    errorDetail: '列表选择器未命中',
    lastError: '列表选择器未命中',
    failedAt: '2026-11-17 08:31',
    retryCount: 3,
    status: '待分类',
    batchId: null,
    exhausted: false,
  },
  {
    id: 'FR-0006',
    jobId: 'SPID-0002',
    address: 'https://data.example.com/detail/10',
    errorCategory: '限流错误',
    errorDetail: '429 请求过于频繁',
    lastError: '429 请求过于频繁',
    failedAt: '2026-11-17 08:33',
    retryCount: 0,
    status: '待分类',
    batchId: null,
    exhausted: false,
  },
  {
    id: 'FR-0007',
    jobId: 'SPID-0003',
    address: 'https://mirror.example.org/b',
    errorCategory: '数据校验错误',
    errorDetail: '必填字段缺失',
    lastError: '必填字段缺失',
    failedAt: '2026-11-17 08:40',
    retryCount: 0,
    status: '待分类',
    batchId: null,
    exhausted: false,
  },
]

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function seedState(): OrchestrationState {
  return {
    failures: clone(SEED_FAILURES),
    batches: [],
    groups: [],
    checks: [],
    conflicts: [],
    sequence: 0,
    lastClassifiedAt: null,
  }
}

function readState(): OrchestrationState {
  const fallback = seedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(ORCH_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(ORCH_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as OrchestrationState
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(ORCH_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: OrchestrationState | null = null

export function loadOrchestration(): OrchestrationState {
  if (cache === null) {
    cache = readState()
  }
  return cache
}

export function saveOrchestration(state: OrchestrationState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(ORCH_STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetOrchestration(): OrchestrationState {
  const fresh = seedState()
  saveOrchestration(fresh)
  return fresh
}

export function orchestrationStorageKey(): string {
  return ORCH_STORAGE_KEY
}
