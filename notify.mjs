// 更新完成后，把「今天上什么课」推到微信。
// 支持两种免费通道，配了哪个用哪个：
//   SC_SENDKEY      Server酱（sct.ftqq.com）关注服务号即可，免费 10 条/天
//   PUSHPLUS_TOKEN  PushPlus（pushplus.plus）需实名，免费 200 条/天
// 两个都没配就静默跳过，不影响课表生成。
// 推送内容只含：日期、时间、校区、课程名、页面链接。不含学生姓名、不含学员人数。

const PAGE_URL = process.env.PAGE_URL || 'https://danackerman-attack.github.io/schoolpal-schedule/';

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function shanghaiToday() {
  const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { ymd, wd };
}

function build(items) {
  const { ymd, wd } = shanghaiToday();
  const today = (items || []).filter((x) => x.d === ymd).sort((a, b) => a.s - b.s);
  const cls = today.filter((x) => !x.late);
  const late = today.filter((x) => x.late);

  const byCampus = {};
  cls.forEach((x) => { const k = String(x.c || '').replace(/校区$/, ''); byCampus[k] = (byCampus[k] || 0) + 1; });
  const campusTxt = Object.entries(byCampus).map(([k, v]) => `${k}${v}`).join(' ');

  let title;
  if (cls.length) title = `今天 ${cls.length} 节${campusTxt ? ' · ' + campusTxt : ''}${late.length ? ' +晚辅' : ''}`;
  else title = late.length ? '今天没正课（有晚辅）' : '今天没课';

  const lines = [`**${ymd} ${wd}**`, ''];
  if (cls.length) cls.forEach((x) => lines.push(`- ${hm(x.s)}–${hm(x.e)}　${x.c}　${x.t}`));
  else lines.push('- 今天没有排课');
  if (late.length) {
    lines.push('', '晚辅（不计课时）：');
    late.forEach((x) => lines.push(`- ${hm(x.s)}–${hm(x.e)}　${x.c}　${x.t}`));
  }
  lines.push('', `[打开完整课表](${PAGE_URL})`);
  return { title, desp: lines.join('\n'), count: today.length };
}

async function sendServerChan(key, title, desp) {
  const r = await fetch(`https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: new URLSearchParams({ title, desp }).toString(),
  });
  const t = await r.text();
  return `Server酱 HTTP ${r.status} ${t.slice(0, 80)}`;
}

async function sendPushPlus(token, title, desp) {
  const r = await fetch('https://www.pushplus.plus/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, title, content: desp, template: 'markdown' }),
  });
  const t = await r.text();
  return `PushPlus HTTP ${r.status} ${t.slice(0, 80)}`;
}

// 永不抛错：推送失败只记日志，绝不影响课表页面生成与部署
export async function notifyToday(items) {
  const sc = process.env.SC_SENDKEY;
  const pp = process.env.PUSHPLUS_TOKEN;
  if (!sc && !pp) {
    console.log('[notify] 未配置 SC_SENDKEY / PUSHPLUS_TOKEN，跳过微信通知');
    return null;
  }
  try {
    const { title, desp, count } = build(items);
    if (process.env.NOTIFY_DRY === '1') {
      console.log('[notify][dry-run] 标题：' + title);
      console.log('[notify][dry-run] 正文：\n' + desp);
      return { dryRun: true, title, count };
    }
    const out = sc ? await sendServerChan(sc, title, desp) : await sendPushPlus(pp, title, desp);
    console.log('[notify] ' + out);
    return { title, count, result: out };
  } catch (e) {
    console.error('[notify] 推送失败（不影响课表）：' + String(e && e.message ? e.message : e).slice(0, 160));
    return null;
  }
}
