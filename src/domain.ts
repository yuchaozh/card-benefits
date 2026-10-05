export type Period = 'monthly' | 'quarterly' | 'semiannual' | 'annual'
export type Card = {
  id: string
  name: string
  issuer: string
  annualFee: number
  openedOn: string
}
export type Benefit = {
  id: string
  cardId: string
  name: string
  allowance: number
  period: Period
  anchor: string
}
export type Usage = {
  id: string
  benefitId: string
  amount: number
  date: string
  note: string
}
export type Data = { version: 1; cards: Card[]; benefits: Benefit[]; usages: Usage[] }

export const STORAGE_KEY = 'card-benefits:v1'
const MAX_MONEY = 10_000_000_000
const MAX_ITEMS = 10_000
const MAX_BACKUP_BYTES = 5 * 1024 * 1024
const MONTHS: Record<Period, number> = {
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
}

// Freezing the shared template prevents accidental changes to subsequent new datasets.
export const EMPTY_DATA: Data = Object.freeze({
  version: 1 as const,
  cards: Object.freeze([]) as unknown as Card[],
  benefits: Object.freeze([]) as unknown as Benefit[],
  usages: Object.freeze([]) as unknown as Usage[],
})

function emptyData(): Data {
  return { version: 1, cards: [], benefits: [], usages: [] }
}

export function parseMoney(input: string): number {
  if (typeof input !== 'string' || input.length > 100) {
    throw new Error('金额格式无效')
  }
  const text = input.trim()
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error('金额必须为非负数字，且最多保留两位小数')
  }
  const [whole, fraction = ''] = text.split('.')
  const cents = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'))
  if (cents > BigInt(MAX_MONEY)) throw new Error('金额不能超过一亿元')
  return Number(cents)
}

const currency = new Intl.NumberFormat('zh-CN', {
  style: 'currency',
  currency: 'CNY',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export function formatMoney(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('金额必须是安全的非负整数分')
  return currency.format(cents / 100)
}

function dateText(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function todayLocal(): string {
  const now = new Date()
  return dateText(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
  return [4, 6, 9, 11].includes(month) ? 30 : 31
}

export function isDate(value: string): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  return year! >= 1900 && year! <= 2100 && month! >= 1 && month! <= 12
    && day! >= 1 && day! <= daysInMonth(year!, month!)
}

function requireDate(value: string, label: string): void {
  if (!isDate(value)) throw new Error(`${label}必须为1900至2100年的有效日期（YYYY-MM-DD）`)
}

function anchoredMonth(anchor: string, offset: number): string {
  const [year, month, day] = anchor.split('-').map(Number)
  const index = year! * 12 + month! - 1 + offset
  const nextYear = Math.floor(index / 12)
  const nextMonth = index % 12 + 1
  return dateText(nextYear, nextMonth, Math.min(day!, daysInMonth(nextYear, nextMonth)))
}

function previousDay(value: string): string {
  let [year, month, day] = value.split('-').map(Number) as [number, number, number]
  if (day > 1) return dateText(year, month, day - 1)
  if (--month === 0) {
    year--
    month = 12
  }
  day = daysInMonth(year, month)
  return dateText(year, month, day)
}

export function cycleFor(benefit: Benefit, date: string): {
  start: string; end: string; reset: string; active: boolean
} {
  requireDate(benefit.anchor, '权益起算日期')
  requireDate(date, '查询日期')
  if (!Object.hasOwn(MONTHS, benefit.period)) throw new Error('权益周期无效')
  const months = MONTHS[benefit.period]
  const [anchorYear, anchorMonth] = benefit.anchor.split('-').map(Number)
  const [year, month] = date.split('-').map(Number)
  let index = Math.max(0, Math.floor(((year! - anchorYear!) * 12 + month! - anchorMonth!) / months))
  if (index > 0 && anchoredMonth(benefit.anchor, index * months) > date) index--
  const start = anchoredMonth(benefit.anchor, index * months)
  const reset = anchoredMonth(benefit.anchor, (index + 1) * months)
  return { start, end: previousDay(reset), reset, active: date >= benefit.anchor }
}

export function usageInCycle(data: Data, benefit: Benefit, date: string): number {
  const cycle = cycleFor(benefit, date)
  if (!cycle.active) return 0
  return data.usages.reduce((sum, usage) =>
    usage.benefitId === benefit.id && usage.date >= cycle.start && usage.date <= cycle.end
      && usage.date <= date
      ? sum + usage.amount : sum, 0)
}

export function annualUsed(data: Data, date: string, cardId?: string): number {
  requireDate(date, '查询日期')
  const start = `${date.slice(0, 4)}-01-01`
  const ids = cardId === undefined ? null
    : new Set(data.benefits.filter(benefit => benefit.cardId === cardId).map(benefit => benefit.id))
  return data.usages.reduce((sum, usage) =>
    usage.date >= start && usage.date <= date && (ids === null || ids.has(usage.benefitId))
      ? sum + usage.amount : sum, 0)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}必须是对象`)
  }
  return value as Record<string, unknown>
}

function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`)
  if (value.length > MAX_ITEMS) throw new Error(`${label}最多允许${MAX_ITEMS}条记录`)
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label}不能包含空缺记录`)
  }
  return value
}

function text(value: unknown, limit: number, label: string, required = false, trim = true): string {
  if (typeof value !== 'string' || value.length > limit) {
    throw new Error(`${label}必须是最多${limit}个字符的字符串`)
  }
  const result = trim ? value.trim() : value
  if (required && result.length === 0) throw new Error(`${label}不能为空`)
  return result
}

function money(value: unknown, label: string, positive = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value < (positive ? 1 : 0) || value > MAX_MONEY) {
    throw new Error(`${label}必须是${positive ? '正' : '非负'}整数分，且不能超过一亿元`)
  }
  return value
}

export function validateData(value: unknown): Data {
  const source = record(value, '数据')
  if (source.version !== 1) throw new Error('不支持的数据版本，仅支持版本1')
  const seen = new Set<string>()
  const id = (value: unknown): string => {
    const result = text(value, 100, '记录ID', true)
    if (seen.has(result)) throw new Error(`记录ID重复：${result}`)
    seen.add(result)
    return result
  }
  const cards = list(source.cards, '信用卡').map((value): Card => {
    const item = record(value, '信用卡')
    const openedOn = text(item.openedOn, 10, '开卡日期', false, false)
    if (openedOn !== '') requireDate(openedOn, '开卡日期')
    return {
      id: id(item.id),
      name: text(item.name, 80, '信用卡名称', true),
      issuer: text(item.issuer, 80, '发卡行'),
      annualFee: money(item.annualFee, '年费'),
      openedOn,
    }
  })
  const cardIds = new Set(cards.map(card => card.id))
  const benefits = list(source.benefits, '权益').map((value): Benefit => {
    const item = record(value, '权益')
    const cardId = text(item.cardId, 100, '信用卡ID', true)
    if (!cardIds.has(cardId)) throw new Error('权益引用了不存在的信用卡')
    const period = item.period
    if (typeof period !== 'string' || !Object.hasOwn(MONTHS, period)) throw new Error('权益周期无效')
    const anchor = text(item.anchor, 10, '权益起算日期', true, false)
    requireDate(anchor, '权益起算日期')
    return {
      id: id(item.id),
      cardId,
      name: text(item.name, 80, '权益名称', true),
      allowance: money(item.allowance, '权益额度', true),
      period: period as Period,
      anchor,
    }
  })
  const benefitMap = new Map(benefits.map(benefit => [benefit.id, benefit]))
  const usages = list(source.usages, '使用记录').map((value): Usage => {
    const item = record(value, '使用记录')
    const benefitId = text(item.benefitId, 100, '权益ID', true)
    const benefit = benefitMap.get(benefitId)
    if (!benefit) throw new Error('使用记录引用了不存在的权益')
    const date = text(item.date, 10, '使用日期', true, false)
    requireDate(date, '使用日期')
    if (date < benefit.anchor) throw new Error('使用日期不能早于权益起算日期')
    return {
      id: id(item.id),
      benefitId,
      amount: money(item.amount, '使用金额', true),
      date,
      note: text(item.note, 500, '备注', false, false),
    }
  })
  // At most 10,000 entries × 10^10 cents keeps every possible sum safely integral.
  return { version: 1, cards, benefits, usages }
}

function requireBackupSize(input: string): void {
  if (typeof input !== 'string') throw new Error('备份内容必须是文本')
  if (input.length > MAX_BACKUP_BYTES || new TextEncoder().encode(input).length > MAX_BACKUP_BYTES) {
    throw new Error('备份文件不能超过5MB')
  }
}

export function parseBackup(input: string): Data {
  requireBackupSize(input)
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    throw new Error('备份内容不是有效的JSON，无法导入')
  }
  return validateData(value)
}

export function serializeBackup(data: Data): string {
  const serialized = JSON.stringify(validateData(data), null, 2)
  requireBackupSize(serialized)
  return serialized
}

export function loadData(storage: Pick<Storage, 'getItem'>): Data {
  let stored: string | null
  try {
    stored = storage.getItem(STORAGE_KEY)
  } catch {
    throw new Error('无法读取本地存储，请检查浏览器存储权限')
  }
  if (stored === null) return emptyData()
  try {
    return parseBackup(stored)
  } catch (error) {
    const detail = error instanceof Error ? error.message : '数据无效'
    throw new Error(`本地存储数据损坏，未覆盖原数据：${detail}`)
  }
}

export function saveData(data: Data, storage: Pick<Storage, 'setItem'>): void {
  const valid = validateData(data)
  requireBackupSize(JSON.stringify(valid, null, 2))
  const serialized = JSON.stringify(valid)
  try {
    storage.setItem(STORAGE_KEY, serialized)
  } catch {
    throw new Error('无法保存到本地存储，请检查存储权限或可用空间')
  }
}
