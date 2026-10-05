import test from 'node:test'
import assert from 'node:assert/strict'
import {
  EMPTY_DATA, STORAGE_KEY, parseMoney, formatMoney, todayLocal, isDate,
  cycleFor, usageInCycle, annualUsed, validateData, loadData, saveData,
  parseBackup, serializeBackup,
} from '../src/domain.ts'
import type { Benefit, Data, Period } from '../src/domain.ts'

function fixture(): Data {
  return {
    version: 1,
    cards: [{ id: 'card', name: '测试卡', issuer: '', annualFee: 0, openedOn: '' }],
    benefits: [{ id: 'benefit', cardId: 'card', name: '餐饮', allowance: 10000, period: 'monthly', anchor: '2024-01-31' }],
    usages: [{ id: 'usage', benefitId: 'benefit', amount: 123, date: '2024-02-01', note: '' }],
  }
}

function benefit(anchor = '2024-01-31', period: Period = 'monthly'): Benefit {
  return { ...fixture().benefits[0]!, anchor, period }
}

test('money parses exact cents and formats Chinese CNY', () => {
  for (const [input, expected] of [
    ['0', 0], ['0.01', 1], ['12.3', 1230], ['12.34', 1234],
    [' 001.20 ', 120], ['100000000.00', 10_000_000_000], ['99999999.99', 9_999_999_999],
  ] as const) assert.equal(parseMoney(input), expected)
  for (const input of ['', ' ', '-1', '+1', '.5', '1.', '1.001', '1e2', 'NaN',
    'Infinity', '1,000', '￥1', '1 2', '100000000.01', '999999999999999999999999']) {
    assert.throws(() => parseMoney(input), /金额/)
  }
  assert.equal(formatMoney(123456), '¥1,234.56')
  assert.equal(formatMoney(0), '¥0.00')
  assert.equal(formatMoney(1), '¥0.01')
  assert.equal(formatMoney(100_000_000_000_000), '¥1,000,000,000,000.00')
  for (const value of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => formatMoney(value), /金额/)
  }
})

test('date validation uses strict Gregorian calendar independent of timezone', () => {
  for (const date of ['1900-01-01', '2100-12-31', '2000-02-29', '2024-02-29', '2024-03-10', '2024-11-03']) {
    assert.equal(isDate(date), true, date)
  }
  for (const date of ['', '1899-12-31', '2101-01-01', '1900-02-29', '2100-02-29',
    '2023-02-29', '2024-04-31', '2024-00-10', '2024-13-01', '2024-01-00',
    '2024-1-01', '2024-01-1', ' 2024-01-01', '2024-01-01T00:00:00Z']) {
    assert.equal(isDate(date), false, date)
  }
  assert.equal(isDate(null as unknown as string), false)
  const before = new Date()
  const actual = todayLocal()
  const after = new Date()
  const local = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  assert.ok(actual === local(before) || actual === local(after))
})

test('monthly cycles retain original anchor day after clamping', () => {
  const b = benefit('2023-01-31')
  assert.deepEqual(cycleFor(b, '2023-01-30'), {
    start: '2023-01-31', end: '2023-02-27', reset: '2023-02-28', active: false,
  })
  assert.deepEqual(cycleFor(b, '2023-01-31'), {
    start: '2023-01-31', end: '2023-02-27', reset: '2023-02-28', active: true,
  })
  assert.deepEqual(cycleFor(b, '2023-02-28'), {
    start: '2023-02-28', end: '2023-03-30', reset: '2023-03-31', active: true,
  })
  assert.equal(cycleFor(b, '2023-03-30').start, '2023-02-28')
  assert.equal(cycleFor(b, '2023-03-31').start, '2023-03-31')
  assert.equal(cycleFor(b, '2024-02-28').start, '2024-01-31')
  assert.equal(cycleFor(b, '2024-02-29').start, '2024-02-29')
  assert.equal(cycleFor(b, '2024-03-31').start, '2024-03-31')
})

test('all periods, leap anchors, year crossings and supported date extremes', () => {
  for (const [period, start, reset, end] of [
    ['quarterly', '2024-01-31', '2024-04-30', '2024-04-29'],
    ['semiannual', '2024-01-31', '2024-07-31', '2024-07-30'],
    ['annual', '2024-01-31', '2025-01-31', '2025-01-30'],
  ] as const) {
    const b = benefit(start, period)
    assert.deepEqual(cycleFor(b, end), { start, end, reset, active: true })
    assert.equal(cycleFor(b, reset).start, reset)
    assert.equal(cycleFor(b, '2023-12-31').active, false)
  }
  assert.deepEqual(cycleFor(benefit('2024-02-29', 'annual'), '2025-02-28'), {
    start: '2025-02-28', end: '2026-02-27', reset: '2026-02-28', active: true,
  })
  assert.equal(cycleFor(benefit('2024-02-29', 'annual'), '2028-02-29').start, '2028-02-29')
  assert.deepEqual(cycleFor(benefit('2024-12-01'), '2024-12-31'), {
    start: '2024-12-01', end: '2024-12-31', reset: '2025-01-01', active: true,
  })
  assert.equal(cycleFor(benefit('1900-01-31'), '2100-02-28').start, '2100-02-28')
  assert.equal(cycleFor(benefit('2100-12-31', 'annual'), '2100-12-31').reset, '2101-12-31')
  assert.throws(() => cycleFor(benefit(), '2024-02-30'), /日期/)
  assert.throws(() => cycleFor(benefit('bad'), '2024-01-01'), /日期/)
  assert.throws(() => cycleFor(benefit('2024-01-01', 'toString' as Period), '2024-01-01'), /周期/)
})

test('cycle sums count through query date, include endpoints and only matching benefit', () => {
  const data = fixture()
  data.usages = [
    ['a', '2024-01-30', 1], ['b', '2024-01-31', 2],
    ['c', '2024-02-28', 4], ['d', '2024-02-29', 8],
  ].map(([id, date, amount]) => ({
    id: id as string, date: date as string, amount: amount as number, benefitId: 'benefit', note: '',
  }))
  data.usages.push({ id: 'other', benefitId: 'other', date: '2024-02-01', amount: 16, note: '' })
  assert.equal(usageInCycle(data, benefit(), '2024-01-30'), 0)
  assert.equal(usageInCycle(data, benefit(), '2024-02-01'), 2)
  assert.equal(usageInCycle(data, benefit(), '2024-02-28'), 6)
  assert.equal(usageInCycle(data, benefit(), '2024-02-29'), 8)
})

test('planned usages validate but do not count until their calendar date arrives', () => {
  const data = fixture()
  data.usages.push({ id: 'planned', benefitId: 'benefit', amount: 50, date: '2024-02-15', note: '预约' })
  const valid = validateData(data)
  const b = valid.benefits[0]!
  assert.equal(usageInCycle(valid, b, '2024-02-14'), 123)
  assert.equal(usageInCycle(valid, b, '2024-02-15'), 173)
  assert.equal(usageInCycle(valid, b, '2024-02-28'), 173)
  assert.equal(usageInCycle(valid, b, '2024-02-29'), 0)
})

test('annual sums stop at today and optionally select a card', () => {
  const data = fixture()
  data.benefits.push({ ...benefit(), id: 'other-benefit', cardId: 'other-card' })
  data.usages = [
    ['2023-12-31', 1], ['2024-01-01', 2], ['2024-06-15', 4], ['2024-06-16', 8],
    ['2024-12-31', 16], ['2025-01-01', 32],
  ].map(([date, amount], index) => ({
    id: String(index), date: date as string, amount: amount as number, benefitId: 'benefit', note: '',
  }))
  data.usages.push({ id: 'other', date: '2024-06-15', amount: 64, benefitId: 'other-benefit', note: '' })
  assert.equal(annualUsed(data, '2024-06-15'), 70)
  assert.equal(annualUsed(data, '2024-06-15', 'card'), 6)
  assert.equal(annualUsed(data, '2024-01-01'), 2)
  assert.equal(annualUsed(data, '2024-12-31'), 94)
  assert.equal(annualUsed(data, '2024-06-15', 'missing'), 0)
  assert.throws(() => annualUsed(data, 'invalid'), /日期/)
})

test('validation rebuilds known fields, normalizes names and never mutates inputs', () => {
  const input = fixture()
  input.cards[0]!.name = ' 测试卡 '
  const extra = { ...input, unknown: true }
  Object.assign(extra.cards[0]!, { unknown: 'ignored' })
  const output = validateData(extra)
  assert.equal(output.cards[0]!.name, '测试卡')
  assert.equal(input.cards[0]!.name, ' 测试卡 ')
  assert.equal(Object.hasOwn(output, 'unknown'), false)
  assert.equal(Object.hasOwn(output.cards[0]!, 'unknown'), false)
  output.usages[0]!.note = 'changed'
  assert.equal(input.usages[0]!.note, '')
  assert.deepEqual(validateData(EMPTY_DATA), fixtureEmpty())
  assert.throws(() => EMPTY_DATA.cards.push(input.cards[0]!), TypeError)
})

function fixtureEmpty(): Data {
  return { version: 1, cards: [], benefits: [], usages: [] }
}

test('validation rejects malformed structure and versions', () => {
  for (const input of [null, [], 1, 'data', {}, { ...fixture(), version: 2 },
    { ...fixture(), version: '1' }, { ...fixture(), cards: null },
    { ...fixture(), benefits: {} }, { ...fixture(), usages: [null] }]) {
    assert.throws(() => validateData(input))
  }
  const sparse = fixture()
  sparse.usages = new Array(1)
  assert.throws(() => validateData(sparse))
})

test('validation rejects unsafe monetary values, references, dates, IDs and names', () => {
  const edits: Array<(data: Data) => void> = [
    d => { d.cards[0]!.annualFee = -1 },
    d => { d.cards[0]!.annualFee = 0.5 },
    d => { d.cards[0]!.annualFee = NaN },
    d => { d.cards[0]!.annualFee = Infinity },
    d => { d.cards[0]!.annualFee = Number.MAX_SAFE_INTEGER + 1 },
    d => { d.benefits[0]!.allowance = 10_000_000_001 },
    d => { d.benefits[0]!.allowance = 0 },
    d => { d.benefits[0]!.allowance = -1 },
    d => { d.usages[0]!.amount = 0 },
    d => { d.usages[0]!.amount = -1 },
    d => { d.usages[0]!.amount = 0.5 },
    d => { d.usages[0]!.amount = 10_000_000_001 },
    d => { d.benefits[0]!.cardId = 'missing' },
    d => { d.usages[0]!.benefitId = 'missing' },
    d => { d.benefits[0]!.id = 'card' },
    d => { d.usages[0]!.id = 'benefit' },
    d => { d.cards.push({ ...d.cards[0]! }) },
    d => { d.cards[0]!.id = ' ' },
    d => { d.cards[0]!.name = ' ' },
    d => { d.benefits[0]!.name = '' },
    d => { d.cards[0]!.name = 'x'.repeat(81) },
    d => { d.cards[0]!.issuer = 'x'.repeat(81) },
    d => { d.cards[0]!.id = 'x'.repeat(101) },
    d => { d.benefits[0]!.name = 'x'.repeat(81) },
    d => { d.usages[0]!.note = 'x'.repeat(501) },
    d => { d.cards[0]!.openedOn = '2023-02-29' },
    d => { d.benefits[0]!.anchor = '2024-02-30' },
    d => { d.usages[0]!.date = '2024-01-30' },
    d => { d.usages[0]!.date = '2024-02-30' },
    d => { d.benefits[0]!.period = 'weekly' as Period },
    d => { d.benefits[0]!.period = '__proto__' as Period },
    d => { d.usages[0]!.note = null as unknown as string },
  ]
  for (const edit of edits) {
    const data = fixture()
    edit(data)
    assert.throws(() => validateData(data), edit.toString())
  }
})

test('array and monetary limits bound aggregations within safe integers', () => {
  const data = fixture()
  data.cards[0]!.annualFee = 10_000_000_000
  data.benefits[0]!.allowance = 10_000_000_000
  data.usages = Array.from({ length: 10_000 }, (_, index) => ({
    id: `usage-${index}`, benefitId: 'benefit', amount: 10_000_000_000, date: '2024-02-01', note: '',
  }))
  const valid = validateData(data)
  const sum = annualUsed(valid, '2024-02-01')
  assert.equal(sum, 100_000_000_000_000)
  assert.equal(Number.isSafeInteger(sum), true)
  assert.equal(usageInCycle(valid, valid.benefits[0]!, '2024-02-01'), sum)
  data.usages.push({ ...data.usages[0]!, id: 'overflow' })
  assert.throws(() => validateData(data), /最多/)
  for (const key of ['cards', 'benefits'] as const) {
    assert.throws(() => validateData({ ...fixture(), [key]: new Array(10_001) }), /最多/)
  }
})

test('storage loads fresh empty data, roundtrips and reports failures without overwriting', () => {
  const first = loadData({ getItem: () => null })
  first.cards.push(fixture().cards[0]!)
  assert.deepEqual(loadData({ getItem: () => null }), fixtureEmpty())
  assert.deepEqual(EMPTY_DATA, fixtureEmpty())
  let saved = ''
  saveData(fixture(), { setItem: (key, value) => { assert.equal(key, STORAGE_KEY); saved = value } })
  assert.deepEqual(loadData({ getItem: key => { assert.equal(key, STORAGE_KEY); return saved } }), fixture())
  assert.throws(() => loadData({ getItem: () => { throw new Error('denied') } }), /无法读取本地存储/)
  for (const corrupt of ['', '{', '{"version":2}', '{"version":1}']) {
    assert.throws(() => loadData({ getItem: () => corrupt }), /损坏.*未覆盖/)
  }
  assert.throws(() => saveData(fixture(), { setItem: () => { throw new Error('quota') } }), /无法保存/)
  let writes = 0
  const invalid = fixture()
  invalid.usages[0]!.amount = 0
  assert.throws(() => saveData(invalid, { setItem: () => { writes++ } }))
  assert.equal(writes, 0)
})

test('backup roundtrip validates, strips unknowns and enforces UTF-8 size before parsing', () => {
  const serialized = serializeBackup(fixture())
  assert.ok(serialized.includes('\n  "version": 1'))
  assert.deepEqual(parseBackup(serialized), fixture())
  assert.deepEqual(parseBackup(JSON.stringify({ ...fixture(), extra: true })), fixture())
  assert.throws(() => parseBackup('broken'), /JSON/)
  assert.throws(() => parseBackup('{"version":2}'), /版本/)
  assert.throws(() => parseBackup(' '.repeat(5 * 1024 * 1024 + 1)), /5MB/)
  assert.throws(() => parseBackup('中'.repeat(2 * 1024 * 1024)), /5MB/)
  assert.deepEqual(parseBackup(JSON.stringify(fixtureEmpty()).padEnd(5 * 1024 * 1024, ' ')), fixtureEmpty())
  const invalid = fixture()
  invalid.usages[0]!.amount = 0
  assert.throws(() => serializeBackup(invalid), /使用金额/)
})

test('oversized valid datasets cannot be saved or exported, and saving never writes', () => {
  const data = fixture()
  data.usages = Array.from({ length: 4000 }, (_, index) => ({
    id: `u-${index}`, benefitId: 'benefit', amount: 1, date: '2024-02-01', note: '中'.repeat(500),
  }))
  assert.equal(validateData(data).usages.length, 4000)
  let writes = 0
  assert.throws(() => saveData(data, { setItem: () => { writes++ } }), /5MB/)
  assert.equal(writes, 0)
  assert.throws(() => serializeBackup(data), /5MB/)
})

test('save requires pretty-backup exportability even when compact storage fits', () => {
  const data = fixture()
  data.usages = Array.from({ length: 8500 }, (_, index) => ({
    id: `u-${index}`, benefitId: 'benefit', amount: 1, date: '2024-02-01', note: 'a'.repeat(500),
  }))
  const valid = validateData(data)
  const size = (value: string) => new TextEncoder().encode(value).length
  assert.ok(size(JSON.stringify(valid)) <= 5 * 1024 * 1024)
  assert.ok(size(JSON.stringify(valid, null, 2)) > 5 * 1024 * 1024)
  let writes = 0
  assert.throws(() => saveData(data, { setItem: () => { writes++ } }), /5MB/)
  assert.equal(writes, 0)
})

test('oversized stored input is rejected before parsing without modifying storage', () => {
  const stored = ' '.repeat(5 * 1024 * 1024 + 1)
  const storage = { getItem: () => stored, setItem: () => assert.fail('must not overwrite') }
  assert.throws(() => loadData(storage), /损坏.*未覆盖.*5MB/)
  assert.equal(storage.getItem(), stored)
})
