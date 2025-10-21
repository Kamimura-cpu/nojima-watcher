// ノジマの新着を拾って LINE に送る（Playwright 使用）
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CATEGORY_URL = "https://online.nojima.co.jp/category/114/?searchCategoryCode=114&mode=image&pageSize=60&currentPage=1&alignmentSequence=8&searchDispFlg=true";
const STATE_FILE = path.join(__dirname, "nojima_seen.json");
const MAX_NOTIFY = 5;

function loadSeen() {
  try {
    return new Set(JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")));
  } catch (_) {
    return new Set();
  }
}
function saveSeen(seen) {
  fs.writeFileSync(STATE_FILE, JSON.stringify([...seen].sort()), "utf-8");
}
function absolutize(base, href) {
  try { return new URL(href, base).toString(); } catch { return href; }
}
function cleanText(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function findPrice(text) {
  const m1 = /[¥￥]\s*([\d,]{3,})/.exec(text);
  if (m1) return "￥" + m1[1].replace(/,/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const m2 = /(\d{4,})(?:\s*(円|税込|税込み))/i.exec(text);
  if (m2) return "￥" + Number(m2[1]).toLocaleString("ja-JP");
  return null;
}

async function fetchProducts() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "ja-JP",
  });
  const page = await context.newPage();
  await page.goto(CATEGORY_URL, { waitUntil: "domcontentloaded" });
  const html = await page.content();
  await browser.close();

  const found = {};
  const anchorRe = /<a[^>]+href="([^"]*\/product\/(\d+)(?:\/[^"]*)?)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const url = absolutize(CATEGORY_URL, m[1]);
    const id = m[2];
    if (!found[id]) {
      found[id] = { id, url, title: cleanText(m[3]) || `商品 ${id}`, price: "-", idx: m.index };
    }
  }
  for (const id of Object.keys(found)) {
    const pos = found[id].idx || 0;
    const windowText = cleanText(html.slice(Math.max(0, pos - 1500), pos + 1500));
    const p = findPrice(windowText);
    if (p) found[id].price = p;
  }
  return found;
}

async function pushLine(messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const userId = process.env.LINE_USER_ID;
  if (!token || !userId) throw new Error("LINE 環境変数が未設定です");
  const payload = {
    to: userId,
    messages: [{ type: "text", text: messages.join("\n").slice(0, 4900) }],
  };
  const resp = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`LINE push failed ${resp.status}: ${txt}`);
  }
}

async function main() {
  const seen = loadSeen();
  const found = await fetchProducts();
  const ids = Object.keys(found);
  const newbies = ids.filter(id => !seen.has(id));

  // ✅ ここがサマリー送信用
  if (process.env.FORCE_SUMMARY === '1') {
    await pushLine([`デバッグ: 抽出 ${ids.length} 件 / 新規 ${newbies.length} 件`]);
  }

  if (newbies.length > 0) {
    const lines = [];
    for (const id of newbies.slice(0, MAX_NOTIFY)) {
      const { title, price, url } = found[id];
      lines.push(`🆕 ${title}\n価格: ${price}\n${url}`);
      seen.add(id);
    }
    if (newbies.length > MAX_NOTIFY) lines.push(`…ほか ${newbies.length - MAX_NOTIFY} 件`);
    await pushLine(lines);
    saveSeen(seen);
  } else {
    saveSeen(seen);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
