/**
 * dsh-fish-bill —— 肥鱼账单（普通版）
 * ============================================================================
 * 只做一件事：定时看 DeepSeek 余额，余额掉多少就是大肥鱼花了多少。
 * 今天 / 本周 / 本月 / 累计，一张面板，外加一个「投喂」入口。
 *
 * 不碰用户的任何个人数据，不需要微信、不需要手机。
 * 数据：<DSH_HOME>/fish-bill/flow.jsonl（一行一个余额快照）
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'fish-bill'

const API = '/dsh-fish-bill'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const DIR = join(HOME, 'fish-bill')
const FLOW = join(DIR, 'flow.jsonl')
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const PANEL_FILE = join(ROOT_DIR, 'assets', 'panel.html')
const INTERVAL_MS = 30 * 60 * 1000
const MIN_DROP = 0.0005

const r2 = (n) => Math.round(n * 100) / 100

// ---------- 余额 ----------

async function apiKey(ctx) {
  try {
    if (ctx && ctx.credentials && typeof ctx.credentials.resolve === 'function') {
      const v = await ctx.credentials.resolve('DEEPSEEK_API_KEY')
      if (v) return String(v)
    }
  } catch { /* 拿不到就退到环境变量 */ }
  return process.env.DEEPSEEK_API_KEY || ''
}

// 没有 API key 时的第二条路：DSH 账号登录态（设置里登录过 DeepSeek 就有）
async function viaAccount(ctx) {
  let acc = null
  try {
    acc = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
  } catch { acc = null }
  if (!acc || typeof acc.getBalance !== 'function') return null
  let r = null
  try {
    r = await acc.getBalance({
      version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || ''),
      locale: String(process.env.DSH_LOCALE || 'zh_CN'),
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
  } catch { return null }
  if (!r || r.status !== 'ready') return null
  const wallets = []
    .concat(Array.isArray(r.value) ? r.value : [], Array.isArray(r.bonusWallets) ? r.bonusWallets : [])
    .filter((w) => w && Number.isFinite(Number(w.balance)))
  if (!wallets.length) return null
  const curOf = (w) => String((w && w.currency) || 'CNY').toUpperCase()
  const pick = wallets.find((w) => curOf(w) === 'CNY') || wallets[0]
  const total = wallets.filter((w) => curOf(w) === curOf(pick))
    .reduce((s, w) => s + Number(w.balance), 0)
  return { total, currency: curOf(pick) }
}

async function fetchBalance(ctx) {
  const key = await apiKey(ctx)
  if (!key) {
    const acc = await viaAccount(ctx)
    if (acc) return acc
    throw new Error('没配 DEEPSEEK_API_KEY，也没登录 DeepSeek 账号 —— 在 DSH 设置里登录一下就成')
  }
  const r = await fetch('https://api.deepseek.com/user/balance', {
    headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
  })
  if (!r.ok) throw new Error('余额接口 ' + r.status)
  const j = await r.json()
  const infos = Array.isArray(j.balance_infos) ? j.balance_infos : []
  const cny = infos.find((i) => String(i.currency).toUpperCase() === 'CNY') || infos[0]
  if (!cny) throw new Error('余额接口没给数据')
  return { total: Number(cny.total_balance) || 0, currency: String(cny.currency || 'CNY').toUpperCase() }
}

function appendSnap(total, currency) {
  mkdirSync(dirname(FLOW), { recursive: true })
  const row = { ts: new Date().toISOString(), total, currency }
  appendFileSync(FLOW, JSON.stringify(row) + '\n', 'utf8')
  return row
}

// ---------- 统计 ----------

function loadFlow() {
  if (!existsSync(FLOW)) return []
  const rows = []
  for (const line of readFileSync(FLOW, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { rows.push(JSON.parse(t)) } catch { /* 跳过坏行 */ }
  }
  rows.sort((a, b) => String(a.ts).localeCompare(String(b.ts)))
  return rows
}

const dayKey = (d) => {
  const x = new Date(d)
  const p = (n) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

/** 把相邻快照的「余额下降」按天归集 */
function dailySpend(rows) {
  const byDay = {}
  for (let i = 1; i < rows.length; i++) {
    const drop = Number(rows[i - 1].total) - Number(rows[i].total)
    if (!(drop > MIN_DROP)) continue
    const k = dayKey(rows[i].ts)
    byDay[k] = (byDay[k] || 0) + drop
  }
  return byDay
}

function summary() {
  const rows = loadFlow()
  const days = dailySpend(rows)
  const now = new Date()
  const weekStart = new Date(now)
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7))
  weekStart.setHours(0, 0, 0, 0)
  const monthKey = dayKey(now).slice(0, 7)
  const todayKey = dayKey(now)
  const weekKey = dayKey(weekStart)

  let today = 0, week = 0, month = 0, all = 0
  for (const [d, v] of Object.entries(days)) {
    all += v
    if (d === todayKey) today += v
    if (d >= weekKey) week += v
    if (d.startsWith(monthKey)) month += v
  }

  // ---------- 对比：昨天 / 上周 / 上月 ----------
  const dayBefore = new Date(now)
  dayBefore.setDate(now.getDate() - 1)
  const prevDay = days[dayKey(dayBefore)] || 0

  // 上一个完整的周（周一~周日）
  const prevWeekStart = new Date(weekStart)
  prevWeekStart.setDate(weekStart.getDate() - 7)
  const prevWeekEnd = new Date(weekStart)
  prevWeekEnd.setDate(weekStart.getDate() - 1)
  const pwA = dayKey(prevWeekStart), pwB = dayKey(prevWeekEnd)
  let prevWeek = 0
  for (const [d, v] of Object.entries(days)) if (d >= pwA && d <= pwB) prevWeek += v

  // 上一个完整的月
  const pmFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const pmLast = new Date(now.getFullYear(), now.getMonth(), 0)
  const pmA = dayKey(pmFirst), pmB = dayKey(pmLast)
  let prevMonth = 0
  for (const [d, v] of Object.entries(days)) if (d >= pmA && d <= pmB) prevMonth += v

  const series = []
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    const k = dayKey(d)
    series.push({ day: k.slice(5), amount: r2(days[k] || 0) })
  }

  // ---------- 明细：余额每次掉，都是一笔钱 ----------
  const cut = new Date(now)
  cut.setDate(now.getDate() - 6)
  cut.setHours(0, 0, 0, 0)
  const drops = []
  for (let i = 1; i < rows.length; i++) {
    const drop = Number(rows[i - 1].total) - Number(rows[i].total)
    if (!(drop > MIN_DROP)) continue
    const ts = String(rows[i].ts)
    const t = new Date(ts)
    if (!(t >= cut)) continue
    drops.push({ ts, day: dayKey(t), amount: r2(drop) })
  }
  drops.reverse()

  const last = rows[rows.length - 1] || null
  return {
    ok: rows.length > 0,
    balance: last ? r2(Number(last.total)) : null,
    currency: last ? last.currency : 'CNY',
    updatedAt: last ? last.ts : null,
    today: r2(today),
    week: r2(week),
    month: r2(month),
    total: r2(all),
    prev: { day: r2(prevDay), week: r2(prevWeek), month: r2(prevMonth) },
    drops,
    series,
    snaps: rows.length,
    feedUrl: 'https://platform.deepseek.com/top_up',
    note: rows.length < 2 ? '还在攒数据：每 30 分钟看一次余额，攒两次才能算出花了多少。' : '',
  }
}

export { summary }

// ---------- 路由 ----------

function json(res, body, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function apply(root) {
  root.inject(['webServer'], (ctx) => {
    const route = (path, handler) => ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))

    route(`${API}/`, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(existsSync(PANEL_FILE) ? readFileSync(PANEL_FILE, 'utf8') : '<h1>面板文件丢了</h1>')
    })

    route(`${API}/api/summary`, (req, res) => json(res, summary()))

    route(`${API}/api/snap`, async (req, res) => {
      try {
        const b = await fetchBalance(ctx)
        appendSnap(b.total, b.currency)
        json(res, { ok: true, ...summary() })
      } catch (e) {
        json(res, { ok: false, error: String(e.message || e) }, 400)
      }
    })

    // 每 30 分钟自动看一次
    const tick = async () => {
      try {
        const b = await fetchBalance(ctx)
        appendSnap(b.total, b.currency)
      } catch { /* 没 key 或断网就跳过，不打扰 */ }
    }
    ctx.effect(() => {
      const t = setInterval(tick, INTERVAL_MS)
      setTimeout(tick, 8000)
      return () => clearInterval(t)
    })

    ctx.logger?.info?.(`fish-bill 就位：页面 ${API}/，数据 ${FLOW}`)
  })
}
