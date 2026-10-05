import {
  EMPTY_DATA, STORAGE_KEY, annualUsed, cycleFor, formatMoney, loadData,
  parseBackup, parseMoney, saveData, serializeBackup, todayLocal, usageInCycle,
} from './domain.ts'
import type { Benefit, Card, Data, Period, Usage } from './domain.ts'

type View = 'overview' | 'cards' | 'history' | 'backup'
const periods: Record<Period, string> = { monthly: '每月', quarterly: '每季度', semiannual: '每半年', annual: '每年' }
// Escape every dynamic string before rendering HTML, including imported names and notes.
const escape = (value: string): string => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!))
const decimal = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
const signedMoney = (cents: number): string => `${cents < 0 ? '−' : ''}${formatMoney(Math.abs(cents))}`
const errorText = (error: unknown): string => error instanceof Error ? error.message : '操作失败，请重试。'
let data: Data = structuredClone(EMPTY_DATA)
let view: View = 'overview'
let historyCard = ''
let blocked = false
let storageWarning = ''
let storedSnapshot: string | null = null
try {
  data = loadData(localStorage)
  storedSnapshot = localStorage.getItem(STORAGE_KEY)
} catch (error) {
  blocked = true
  storageWarning = `${errorText(error)} 为保护原数据，编辑已暂停。可重新加载，或在备份页确认导入替换。`
}

const app = document.querySelector<HTMLDivElement>('#app')!
app.innerHTML = `
  <a class="skip-link" href="#content">跳到主要内容</a>
  <header class="site-header">
    <a class="brand" href="#overview" aria-label="拾益首页"><span class="brand-mark" aria-hidden="true">拾</span>
      <span>拾益<small>CARD BENEFITS</small></span></a>
    <span class="local-badge"><span aria-hidden="true">●</span> 仅本机保存</span>
  </header>
  <div id="storage-warning" class="storage-warning" role="alert" hidden></div>
  <div id="feedback" class="feedback" role="status" aria-live="polite"></div>
  <main id="content" tabindex="-1"></main>
  <nav class="navigation" aria-label="主要导航">
    <button type="button" data-view="overview"><span aria-hidden="true">◫</span>总览</button>
    <button type="button" data-view="cards"><span aria-hidden="true">▤</span>我的卡片</button>
    <button type="button" data-view="history"><span aria-hidden="true">↗</span>使用记录</button>
    <button type="button" data-view="backup"><span aria-hidden="true">⇅</span>数据备份</button>
  </nav>
  <footer>你的权益，你来定义。<br>不收集卡号、CVV 或银行凭据 · 无账号 · 无云端同步</footer>
  <dialog id="editor" aria-labelledby="editor-title"></dialog>`
const content = document.querySelector<HTMLElement>('#content')!
const dialog = document.querySelector<HTMLDialogElement>('#editor')!
const feedback = document.querySelector<HTMLElement>('#feedback')!
const warning = document.querySelector<HTMLElement>('#storage-warning')!
let dialogOpener: HTMLElement | null = null

function notify(message: string, isError = false): void {
  feedback.textContent = message
  feedback.classList.toggle('error', isError)
}
function renderWarning(): void {
  warning.hidden = !storageWarning
  warning.replaceChildren(document.createTextNode(storageWarning))
  if (storageWarning) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = '重新加载'
    button.addEventListener('click', () => window.location.reload())
    warning.append(button)
  }
}
function persist(next: Data, replacement = false): boolean {
  if (blocked && !replacement) { notify('编辑已暂停，请重新加载或从备份恢复。', true); return false }
  try {
    if (!replacement && localStorage.getItem(STORAGE_KEY) !== storedSnapshot) {
      blocked = true
      storageWarning = '另一个页面已修改数据。为避免覆盖，请重新加载后继续。'
      renderWarning()
      throw new Error(storageWarning)
    }
    saveData(next, localStorage)
    storedSnapshot = localStorage.getItem(STORAGE_KEY)
    data = next
    blocked = false
    storageWarning = ''
    renderWarning()
    render()
    return true
  } catch (error) {
    notify(`未保存：${errorText(error)} 请检查浏览器存储权限或空间，并先导出备份。`, true)
    return false
  }
}
const heading = (eyebrow: string, title: string, description: string, action = ''): string => `
  <section class="page-heading"><div><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>
    <p class="muted">${description}</p></div>${action}</section>`
const addCardButton = '<button class="primary" type="button" data-action="add-card">＋ 添加卡片</button>'
const emptyState = (title: string, description: string, action: string): string => `
  <section class="empty panel"><span class="empty-mark" aria-hidden="true">＋</span>
    <h2>${title}</h2><p class="muted">${description}</p>${action}</section>`
const cardName = (id: string): string => data.cards.find(card => card.id === id)?.name ?? '未找到卡片'

function benefitItem(benefit: Benefit, compact = false): string {
  const today = todayLocal()
  const cycle = cycleFor(benefit, today)
  const used = usageInCycle(data, benefit, today)
  const remaining = cycle.active ? Math.max(0, benefit.allowance - used) : 0
  const percent = Math.min(100, used / benefit.allowance * 100)
  return `<article class="benefit">
    <div class="benefit-top"><div><p class="eyebrow">${compact ? escape(cardName(benefit.cardId)) : periods[benefit.period]}</p>
      <h3>${escape(benefit.name)}</h3></div><span class="pill">${periods[benefit.period]}</span></div>
    <div class="balance-row"><span>${cycle.active ? '本期剩余' : '尚未开始'}</span><strong>${formatMoney(remaining)}</strong></div>
    <div class="meter" role="meter" aria-label="${escape(benefit.name)}额度使用比例" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent.toFixed(2)}"><span style="width:${percent}%"></span></div>
    <p class="benefit-detail">已用 ${formatMoney(used)} / 额度 ${formatMoney(benefit.allowance)}
      ${used > benefit.allowance ? `<span class="excess">超出 ${formatMoney(used - benefit.allowance)}</span>` : ''}</p>
    <p class="benefit-detail">${cycle.active ? `本期 ${cycle.start} 至 ${cycle.end}<br>到期：${cycle.end} · 重置：${cycle.reset}` : `首次开始：${cycle.start} · 下次重置：${cycle.reset}`}</p>
    <div class="actions"><button class="primary small" type="button" data-action="add-usage" data-id="${escape(benefit.id)}">＋ 记录使用</button>
    ${compact ? '' : `<button type="button" data-action="edit-benefit" data-id="${escape(benefit.id)}">编辑权益</button>
      <button class="danger" type="button" data-action="delete-benefit" data-id="${escape(benefit.id)}">删除权益</button>`}</div></article>`
}
function overview(): string {
  const today = todayLocal()
  const used = annualUsed(data, today)
  const fees = data.cards.reduce((sum, card) => sum + card.annualFee, 0)
  const active = data.benefits.filter(benefit => cycleFor(benefit, today).active)
  const remaining = active.reduce((sum, benefit) => sum + Math.max(0, benefit.allowance - usageInCycle(data, benefit, today)), 0)
  const upcoming = active.filter(benefit => usageInCycle(data, benefit, today) < benefit.allowance)
    .sort((a, b) => cycleFor(a, today).reset.localeCompare(cycleFor(b, today).reset))
  return heading('YOUR BENEFITS, AT A GLANCE', '把每一份权益，用在生活里。', `${today} · 自定义权益手账，不是银行账单`, addCardButton) + `
    <section class="dashboard-stats" aria-label="权益概览">
      <article class="stat featured"><p>本期剩余权益</p><strong>${formatMoney(remaining)}</strong><span>${active.length} 项已开始的权益 · 不结转</span></article>
      <article class="stat"><p>${today.slice(0, 4)} 年已使用</p><strong>${formatMoney(used)}</strong><span>按使用日期，累计至今天</span></article>
      <article class="stat"><p>所填卡片年费合计</p><strong>${formatMoney(fees)}</strong><span>${data.cards.length} 张卡，每张计一次</span></article>
    </section>
    <section class="comparison panel"><div><p class="eyebrow">年度价值 / 年费</p><h2>${!data.cards.length ? '添加卡片后查看年费比较' : used >= fees ? '已记录价值覆盖所填年费' : '距所填年费还差'}${data.cards.length && used < fees ? ` ${formatMoney(fees - used)}` : ''}</h2></div>
      <p class="muted">差额：${signedMoney(used - fees)}。按本年 1 月 1 日至今天的使用金额，减去当前卡片年费合计；不按开卡日分摊，不代表实际收费或真实收益。未来日期记录暂不计入。</p></section>
    <div class="section-heading"><h2>即将重置 · 别让权益错过</h2><span class="muted">按重置日期排序</span></div>
    ${!data.cards.length ? emptyState('从你的第一张卡开始', '添加卡片，再按自己的实际权益设置额度和周期。这里没有预置的银行权益。', addCardButton)
      : upcoming.length ? `<section class="benefit-grid">${upcoming.map(benefit => benefitItem(benefit, true)).join('')}</section>`
      : emptyState('暂时没有待使用权益', data.benefits.length ? '已开始的权益都已用完，或尚未到首次开始日。到卡片页查看全部重置日期。' : '为卡片添加自定义权益，开始追踪每一笔使用。', '<button type="button" data-view="cards">管理我的卡片</button>')}
    <aside class="privacy-note"><strong>只有这个浏览器知道你的记录。</strong>手机与电脑数据独立。清除浏览器数据可能丢失记录；隐私浏览可能不保留数据。请定期导出备份。</aside>`
}
function cardsView(): string {
  return heading('YOUR WALLET', '我的卡片', '只填写卡片名称和权益信息，请勿填写卡号、CVV 或银行凭据。', addCardButton)
    + (data.cards.length ? data.cards.map(card => {
      const benefits = data.benefits.filter(benefit => benefit.cardId === card.id)
      const used = annualUsed(data, todayLocal(), card.id)
      return `<section class="card-panel panel">
        <header class="card-header"><div><p class="eyebrow">${escape(card.issuer || '自定义卡片')}</p><h2>${escape(card.name)}</h2>
          <p class="muted">年费 ${formatMoney(card.annualFee)}${card.openedOn ? ` · 开卡 ${card.openedOn}` : ''}<br>今年已用 ${formatMoney(used)} · 与年费差额 ${signedMoney(used - card.annualFee)}</p></div>
          <div class="actions"><button type="button" data-action="edit-card" data-id="${escape(card.id)}">编辑卡片</button>
            <button class="danger" type="button" data-action="delete-card" data-id="${escape(card.id)}">删除卡片</button></div></header>
        ${benefits.length ? `<div class="benefit-grid">${benefits.map(benefit => benefitItem(benefit)).join('')}</div>` : '<p class="card-empty muted">还没有权益。按照银行实际条款，添加你希望追踪的额度。</p>'}
        <button class="add-benefit" type="button" data-action="add-benefit" data-id="${escape(card.id)}">＋ 添加自定义权益</button></section>`
    }).join('') : emptyState('一张卡，一个清晰的开始', '添加卡片年费与自定义权益。无需账号，不需要关联银行。', addCardButton))
}
function historyView(): string {
  const usages = data.usages.filter(usage => !historyCard || data.benefits.find(item => item.id === usage.benefitId)?.cardId === historyCard)
    .sort((a, b) => b.date.localeCompare(a.date))
  return heading('EVERY LITTLE VALUE', '使用记录', '保留每次使用的日期与金额；未来日期记录在当天才计入统计。')
    + `<label class="filter">筛选卡片<select id="history-card"><option value="">全部卡片</option>${data.cards.map(card =>
      `<option value="${escape(card.id)}" ${historyCard === card.id ? 'selected' : ''}>${escape(card.name)}</option>`).join('')}</select></label>`
    + (usages.length ? `<section class="history-list" aria-label="使用明细">${usages.map(usage => {
      const benefit = data.benefits.find(item => item.id === usage.benefitId)!
      return `<article class="usage panel"><div class="usage-date">${usage.date}${usage.date > todayLocal() ? '<span class="pill">未来记录</span>' : ''}</div>
        <div class="usage-info"><p class="eyebrow">${escape(cardName(benefit.cardId))}</p><h2>${escape(benefit.name)}</h2>${usage.note ? `<p class="note">${escape(usage.note)}</p>` : ''}</div>
        <strong>${formatMoney(usage.amount)}</strong><div class="actions"><button type="button" data-action="edit-usage" data-id="${escape(usage.id)}">编辑记录</button>
        <button class="danger" type="button" data-action="delete-usage" data-id="${escape(usage.id)}">删除记录</button></div></article>`
    }).join('')}</section>` : emptyState('还没有使用记录', '到卡片的权益下点击「记录使用」，记下你的第一笔权益价值。', '<button type="button" data-view="cards">去我的卡片</button>'))
}
function backupView(): string {
  return heading('LOCAL BY DESIGN', '数据在你手里', '没有账号，没有服务器同步。备份是换设备和防止丢失数据的方式。') + `
    <div class="backup-grid"><section class="panel backup-card"><span class="backup-symbol" aria-hidden="true">↓</span><h2>导出备份</h2>
      <p class="muted">下载包含卡片、权益和使用记录的版本化 JSON 文件。请保存在你信任的位置，不要提交到公开仓库。</p>
      <p>${data.cards.length} 张卡片 · ${data.benefits.length} 项权益 · ${data.usages.length} 笔记录</p>
      <button class="primary" type="button" data-action="export" ${blocked ? 'disabled' : ''}>下载 JSON 备份</button></section>
    <section class="panel backup-card"><span class="backup-symbol" aria-hidden="true">↑</span><h2>从备份恢复</h2>
      <p class="muted">选择本应用的 JSON 文件（最大 5 MB）。先校验，再确认；导入会<strong>替换全部本地数据</strong>，不是合并。</p>
      <label class="file-label" for="import-file">选择 JSON 备份文件</label><input id="import-file" type="file" accept=".json,application/json">
      <p class="muted small-text">建议先导出当前数据。取消确认不会更改任何记录。</p></section></div>
    <section class="panel privacy-panel"><h2>本地保存，不等于永久保存</h2><ul>
      <li>不同设备、浏览器和网站地址的数据各自独立；不会自动同步。</li>
      <li>清除站点数据、卸载浏览器或使用隐私浏览，可能导致记录丢失。</li>
      <li>个人记录只写入此浏览器的 localStorage，不上传到 GitHub、分析服务或银行。</li>
      <li>备份文件含个人记录，请自行妥善保管。本应用不提供加密或金融账户连接。</li>
      <li>所有金额统一显示为人民币（¥），不进行汇率换算。请使用同一币种录入。</li>
      <li>没有离线缓存承诺；初次打开和加载网页需要网络。</li></ul></section>`
}
function render(): void {
  content.innerHTML = ({ overview, cards: cardsView, history: historyView, backup: backupView }[view])()
  document.querySelectorAll<HTMLButtonElement>('.navigation button').forEach(button => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
}

function field(name: string, label: string, value = '', type = 'text', extra = ''): string {
  return `<label for="${name}">${label}<input id="${name}" name="${name}" type="${type}" value="${escape(value)}" ${extra}></label>`
}
const dateBounds = 'min="1900-01-01" max="2100-12-31"'
const moneyInput = 'inputmode="decimal" pattern="[0-9]+(\\.[0-9]{1,2})?" maxlength="13" required'
function openEditor(title: string, fields: string, onSave: (form: FormData) => Data): void {
  if (blocked) { notify('编辑已暂停，请重新加载或从备份恢复。', true); return }
  dialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.innerHTML = `<form><div class="dialog-heading"><h2 id="editor-title">${title}</h2>
    <button type="button" data-close aria-label="关闭表单">×</button></div><div class="form-fields">${fields}</div>
    <p id="form-error" class="form-error" role="alert"></p><div class="dialog-actions">
    <button type="button" data-close>取消</button><button class="primary" type="submit">保存</button></div></form>`
  dialog.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => dialog.close()))
  dialog.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault()
    const form = event.currentTarget as HTMLFormElement
    if (!form.reportValidity()) return
    try {
      if (persist(onSave(new FormData(form)))) { dialog.close(); notify('已保存到当前浏览器。') }
      else dialog.querySelector('#form-error')!.textContent = feedback.textContent
    } catch (error) { dialog.querySelector('#form-error')!.textContent = errorText(error) }
  })
  dialog.showModal()
}
const text = (form: FormData, key: string): string => String(form.get(key) ?? '').trim()
function editCard(card?: Card): void {
  openEditor(card ? '编辑卡片' : '添加卡片',
    field('name', '卡片名称', card?.name, 'text', 'required maxlength="80" autocomplete="off"')
    + field('issuer', '发卡机构（可选）', card?.issuer, 'text', 'maxlength="80" autocomplete="off"')
    + field('annualFee', '年费（¥）', decimal(card?.annualFee ?? 0), 'text', moneyInput)
    + field('openedOn', '开卡日期（可选）', card?.openedOn, 'date', dateBounds),
    form => {
      const next: Card = { id: card?.id ?? crypto.randomUUID(), name: text(form, 'name'), issuer: text(form, 'issuer'), annualFee: parseMoney(text(form, 'annualFee')), openedOn: text(form, 'openedOn') }
      return { ...data, cards: card ? data.cards.map(item => item.id === card.id ? next : item) : [...data.cards, next] }
    })
}
function editBenefit(cardId: string, benefit?: Benefit): void {
  openEditor(benefit ? '编辑权益' : '添加自定义权益',
    field('name', '权益名称', benefit?.name, 'text', 'required maxlength="80"')
    + field('allowance', '每期额度（¥，大于 0）', benefit ? decimal(benefit.allowance) : '', 'text', moneyInput)
    + `<label for="period">重置周期<select id="period" name="period">${Object.entries(periods).map(([key, value]) =>
      `<option value="${key}" ${key === (benefit?.period ?? 'monthly') ? 'selected' : ''}>${value}</option>`).join('')}</select></label>`
    + field('anchor', '首次周期开始 / 重置锚点', benefit?.anchor ?? todayLocal(), 'date', `required ${dateBounds}`)
    + '<p class="field-help">从锚点起，每 1 / 3 / 6 / 12 个月重置。例：1 月 31 日 → 2 月末 → 3 月 31 日。截止日为下次重置的前一天；额度不结转。修改锚点会重新归属历史记录，不能晚于已有记录。</p>',
    form => {
      const next: Benefit = { id: benefit?.id ?? crypto.randomUUID(), cardId, name: text(form, 'name'), allowance: parseMoney(text(form, 'allowance')), period: text(form, 'period') as Period, anchor: text(form, 'anchor') }
      return { ...data, benefits: benefit ? data.benefits.map(item => item.id === benefit.id ? next : item) : [...data.benefits, next] }
    })
}
function editUsage(benefit: Benefit, usage?: Usage): void {
  openEditor(usage ? '编辑使用记录' : '记录权益使用',
    `<p class="field-help">${escape(cardName(benefit.cardId))} · ${escape(benefit.name)}</p>`
    + field('amount', '使用金额（¥，大于 0）', usage ? decimal(usage.amount) : '', 'text', moneyInput)
    + field('date', '使用日期', usage?.date ?? todayLocal(), 'date', `required min="${benefit.anchor}" max="2100-12-31"`)
    + `<div class="note-field"><label for="note">备注（可选）</label><textarea id="note" name="note" maxlength="500" rows="3">${escape(usage?.note ?? '')}</textarea></div>`
    + '<p class="field-help">按使用日期归入对应周期，可补记历史或记录未来日期。超额使用会显示超出金额，不会产生负余额。请勿填写敏感凭据。</p>',
    form => {
      const next: Usage = { id: usage?.id ?? crypto.randomUUID(), benefitId: benefit.id, amount: parseMoney(text(form, 'amount')), date: text(form, 'date'), note: text(form, 'note') }
      return { ...data, usages: usage ? data.usages.map(item => item.id === usage.id ? next : item) : [...data.usages, next] }
    })
}
function deleteItem(kind: 'card' | 'benefit' | 'usage', id: string): void {
  let next: Data
  let prompt: string
  if (kind === 'card') {
    const card = data.cards.find(item => item.id === id)
    if (!card) return
    const ids = new Set(data.benefits.filter(item => item.cardId === id).map(item => item.id))
    prompt = `删除「${card.name}」及其全部权益和使用记录？不可撤销，年度统计也会变化。`
    next = { ...data, cards: data.cards.filter(item => item.id !== id), benefits: data.benefits.filter(item => !ids.has(item.id)), usages: data.usages.filter(item => !ids.has(item.benefitId)) }
  } else if (kind === 'benefit') {
    const benefit = data.benefits.find(item => item.id === id)
    if (!benefit) return
    prompt = `删除「${benefit.name}」及其全部使用记录？此操作不可撤销。`
    next = { ...data, benefits: data.benefits.filter(item => item.id !== id), usages: data.usages.filter(item => item.benefitId !== id) }
  } else {
    const usage = data.usages.find(item => item.id === id)
    if (!usage) return
    prompt = `删除 ${usage.date} 的 ${formatMoney(usage.amount)} 使用记录？此操作不可撤销。`
    next = { ...data, usages: data.usages.filter(item => item.id !== id) }
  }
  if (window.confirm(prompt) && persist(next)) {
    if (historyCard === id) { historyCard = ''; render() }
    notify('已删除。')
    content.focus()
  }
}
function downloadBackup(): void {
  if (blocked) return
  try {
    const blob = new Blob([serializeBackup(data)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `card-benefits-${todayLocal()}.json`
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify('已请求下载备份，请检查下载记录并妥善保管文件。')
  } catch (error) { notify(`导出失败：${errorText(error)}`, true) }
}
app.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action], [data-view], .brand') : null
  if (!target) return
  if (target.dataset.view || target.classList.contains('brand')) {
    event.preventDefault()
    view = (target.dataset.view ?? 'overview') as View
    render()
    content.focus()
    window.scrollTo({ top: 0, behavior: 'instant' })
    return
  }
  const id = target.dataset.id ?? ''
  switch (target.dataset.action) {
    case 'add-card': editCard(); break
    case 'edit-card': editCard(data.cards.find(item => item.id === id)); break
    case 'add-benefit': editBenefit(id); break
    case 'edit-benefit': {
      const benefit = data.benefits.find(item => item.id === id)
      if (benefit) editBenefit(benefit.cardId, benefit)
      break
    }
    case 'add-usage': {
      const benefit = data.benefits.find(item => item.id === id)
      if (benefit) editUsage(benefit)
      break
    }
    case 'edit-usage': {
      const usage = data.usages.find(item => item.id === id)
      const benefit = data.benefits.find(item => item.id === usage?.benefitId)
      if (usage && benefit) editUsage(benefit, usage)
      break
    }
    case 'delete-card': deleteItem('card', id); break
    case 'delete-benefit': deleteItem('benefit', id); break
    case 'delete-usage': deleteItem('usage', id); break
    case 'export': downloadBackup(); break
  }
})
app.addEventListener('change', async event => {
  const input = event.target
  if (input instanceof HTMLSelectElement && input.id === 'history-card') {
    historyCard = input.value
    render()
    document.querySelector<HTMLElement>('#history-card')?.focus()
  }
  if (!(input instanceof HTMLInputElement) || input.id !== 'import-file') return
  const file = input.files?.[0]
  if (!file) return
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB，请选择较小的备份。')
    const next = parseBackup(await file.text())
    if (window.confirm(`校验通过：${next.cards.length} 张卡片、${next.benefits.length} 项权益、${next.usages.length} 笔记录。\n确认替换当前浏览器中的全部数据？不可撤销，请先备份。`)) {
      if (persist(next, true)) { historyCard = ''; notify('备份已导入并替换本地数据。'); content.focus() }
    } else notify('已取消导入，原数据未更改。')
  } catch (error) { notify(`未导入：${errorText(error)}`, true) }
  finally { input.value = '' }
})
dialog.addEventListener('close', () => {
  if (dialogOpener?.isConnected) dialogOpener.focus()
  else content.focus()
})
window.addEventListener('storage', event => {
  if (event.key === STORAGE_KEY || event.key === null) {
    blocked = true
    storageWarning = '另一个页面已修改或清除数据。为避免覆盖，请重新加载后继续。'
    renderWarning()
  }
})
let renderedDate = todayLocal()
function refreshDate(): void {
  const today = todayLocal()
  if (today !== renderedDate && !dialog.open) { renderedDate = today; render() }
}
window.addEventListener('focus', refreshDate)
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshDate() })
window.setInterval(refreshDate, 60_000)
renderWarning()
render()
