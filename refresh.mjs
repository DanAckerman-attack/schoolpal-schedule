// 校宝三校区课表 —— 云端刷新（纯 HTTP，零依赖，供 GitHub Actions 定时运行）
// 环境变量：SP_PHONE / SP_PASS（必填）、SP_START / SP_END（可选）
// 输出：public/index.html（移动优先视图，学员姓名中间字打码）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://pc.schoolpal.cn';
const PHONE = process.env.SP_PHONE;
const PASS = process.env.SP_PASS;

const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const START = process.env.SP_START || fmt(new Date(Date.now() - 14 * 864e5));
const END = process.env.SP_END || fmt(new Date(Date.now() + 70 * 864e5));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!PHONE || !PASS) {
  console.error('缺少 SP_PHONE / SP_PASS 环境变量（应配置为仓库 Secrets）');
  process.exit(2);
}

function jwtPayload(t) {
  try { return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

async function req(p, { method = 'POST', body, auth, tenant, bearer } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json' };
  if (tenant) headers['xb-gw-tenant-key'] = tenant;
  if (bearer) headers.Authorization = 'bearer ' + bearer;
  else if (auth) headers.Authorization = auth;

  // 网络抖动是常态（曾出现 fetch failed / 连接超时），重试 3 次，避免某个校区被静默漏掉
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(BASE + p, {
        method, headers, body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      if (r.status >= 500 && attempt < 3) {
        lastErr = new Error(`服务端 ${r.status}`);
        await sleep(700 * attempt);
        continue;
      }
      return { status: r.status, json, text: text.slice(0, 300) };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(700 * attempt);
    }
  }
  throw lastErr;
}

async function login() {
  const r = await req('/next-sso/ToB/PC/Sign/LoginByPassword', {
    body: { phone: PHONE, password: PASS, deviceId: '', jPushId: '', deviceName: '电脑', deviceType: 'PC', fromPC: true },
  });
  if (r.status !== 200 || !r.json || r.json.code !== 0) throw new Error('登录失败 status=' + r.status + ' ' + r.text);
  const d = r.json.data;
  const erpJwt = d.erpSelected && d.erpSelected.token;
  const claims = jwtPayload(erpJwt || '');
  return { sso: d.token, erpJwt, staffId: claims.OrgStaffId, defaultSchoolId: claims.SchoolId };
}

async function erpLogin(erpJwt) {
  const r = await req('/next-org-management/ToB/PC/Oauth/Login', { body: { token: erpJwt } });
  if (r.status !== 200 || !r.json || r.json.code !== 0) throw new Error('Oauth/Login 失败 ' + r.text);
  return { authToken: r.json.data.token, tenant: r.json.data.envTag };
}

// 姓名打码：保留首字与末字，中间用 *
function maskName(n) {
  const a = [...String(n || '').trim()];
  if (a.length <= 1) return a.join('');
  if (a.length === 2) return a[0] + '*';
  return a[0] + '*'.repeat(a.length - 2) + a[a.length - 1];
}
function maskText(t) {
  const s = String(t || '');
  const i = s.indexOf('-');
  const head = i > 0 ? s.slice(0, i) : s;
  if (/^[\u4e00-\u9fa5]{2,4}$/.test(head)) return maskName(head) + (i > 0 ? s.slice(i) : '');
  return s;
}

async function main() {
  const s = await login();
  const erp = await erpLogin(s.erpJwt);
  const tenant = erp.tenant;

  const orgs = await req('/next-sso/ToB/PC/Sign/GetCurrentSignOrgs', { method: 'GET', bearer: s.sso, tenant });
  const org = orgs.json?.data?.list?.[0];
  if (!org) throw new Error('未取到组织信息 ' + orgs.text);
  const orgId = org.orgId;
  const schools = org.schools || [];

  const staff = await req('/next-org-management/ToB/PC/Staffs/GetCurrentStaff', { method: 'GET', auth: erp.authToken, tenant });
  const staffId = staff.json?.data?.id || s.staffId;
  const staffName = staff.json?.data?.name || '';

  const cur = await req('/next-sso/ToB/PC/Sign/GetSelectOrgSchoolName', { body: { orgId }, bearer: s.sso, tenant });
  const currentSchoolId = cur.json?.data?.schoolId || cur.json?.data?.SchoolId || s.defaultSchoolId;

  const rows = [];
  const meta = [];
  const errors = [];

  for (const sc of schools) {
    const m = { id: sc.schoolId, name: sc.schoolName, count: 0 };
    try {
      // 切换会使上一次 token 失效，每个校区都完整切一次
      await req('/next-sso/ToB/PC/Sign/SelectOrg', { body: { orgId, isUpdate: false }, bearer: s.sso, tenant });
      await sleep(250);
      const sel = await req('/next-sso/ToB/PC/Sign/SelectSchool', { body: { orgId, schoolId: sc.schoolId, isUpdate: false }, bearer: s.sso, tenant });
      const jwt = sel.json?.data?.token;
      if (!jwt) { errors.push(`${sc.schoolName}: SelectSchool ${sel.status}`); meta.push(m); continue; }
      await sleep(250);
      const lg = await req('/next-org-management/ToB/PC/Oauth/Login', { body: { token: jwt } });
      const schoolAuth = lg.json?.data?.token;
      if (!schoolAuth) { errors.push(`${sc.schoolName}: OauthLogin ${lg.status}`); meta.push(m); continue; }
      await sleep(250);
      const tt = await req('/next-edu-admin/ToB/PC/Timetable/GetDefaultView', {
        auth: schoolAuth, tenant,
        body: { address: { addressType: 1, addressIds: [] }, teacherIds: [], sourceTypes: [], startDateTime: START, endDateTime: END },
      });
      if (tt.status !== 200 || tt.json?.code !== 0) errors.push(`${sc.schoolName}: GetDefaultView ${tt.status}`);
      const list = tt.json?.data || [];
      m.count = list.length;
      // 服务端"我的课数"：权威口径（晚辅靠班级人员关系关联，主教师字段里没有本人）
      const mc = await req('/next-edu-admin/ToB/PC/Timetable/GetMyCountByDate', {
        auth: schoolAuth, tenant,
        body: { address: { addressType: 1, addressIds: [] }, teacherIds: [], sourceTypes: [], startDateTime: START, endDateTime: END },
      });
      m.myCounts = {};
      ((mc.json?.data) || []).forEach((x) => { m.myCounts[String(x.date).slice(0, 10)] = x.timetableCount; });
      list.forEach((r) => rows.push({ ...r, _school: sc.schoolName }));
    } catch (e) {
      errors.push(`${sc.schoolName}: ${String(e).slice(0, 120)}`);
    }
    meta.push(m);
  }

  // 还原默认校区
  if (currentSchoolId) {
    try {
      await req('/next-sso/ToB/PC/Sign/SelectOrg', { body: { orgId, isUpdate: false }, bearer: s.sso, tenant });
      const sel = await req('/next-sso/ToB/PC/Sign/SelectSchool', { body: { orgId, schoolId: currentSchoolId, isUpdate: false }, bearer: s.sso, tenant });
      const jwt = sel.json?.data?.token;
      if (jwt) await req('/next-org-management/ToB/PC/Oauth/Login', { body: { token: jwt } });
    } catch { /* ignore */ }
  }

  const isMine = (r) => String(r.mainTeacherId) === String(staffId) ||
    (r.timetableTeachers || []).some((x) => String(x.teacherId || x.id) === String(staffId));
  const base = rows.filter(isMine);

  // 补全：晚辅/晚自习由班级人员关系关联，接口不把本人写进 mainTeacherId。
  // 以服务端 GetMyCountByDate 逐日核对，差额从当日其余条目补足（优先晚辅类）。
  const dayKey = (r) => r._school + '|' + String(r.lessonDay).slice(0, 10);
  const kept = {};
  base.forEach((r) => { const k = dayKey(r); kept[k] = (kept[k] || 0) + 1; });
  const keptIds = new Set(base.map((r) => r.id));
  const scoreOf = (r) => {
    const t = String(r.title || r.lessonName || '');
    if (/晚自习|晚辅|自习|值班|辅导|答疑/.test(t)) return 2;
    if (r.isOrgCreated) return 1;
    return 0;
  };
  const extra = [];
  meta.forEach((m) => {
    Object.entries(m.myCounts || {}).forEach(([date, n]) => {
      let need = Number(n || 0) - (kept[m.name + '|' + date] || 0);
      if (need <= 0) return;
      const cands = rows
        .filter((r) => !keptIds.has(r.id) && r._school === m.name && String(r.lessonDay).slice(0, 10) === date)
        .sort((a, b) => scoreOf(b) - scoreOf(a) || a.startMinutes - b.startMinutes);
      for (const c of cands) { if (need <= 0) break; extra.push(c); keptIds.add(c.id); need--; }
    });
  });
  extra.forEach((r) => { r._reconciled = true; });
  const mine = base.concat(extra);

  const items = mine.map((r) => ({
    d: String(r.lessonDay).slice(0, 10),
    s: r.startMinutes,
    e: r.endMinutes,
    t: maskText(r.title || r.lessonName),
    c: r._school,
    late: (/晚自习|晚辅|自习/.test(String(r.title || r.lessonName || '')) || r._reconciled) ? 1 : 0,
    done: !!r.isFinished,
  })).sort((a, b) => (a.d === b.d ? a.s - b.s : a.d < b.d ? -1 : 1));

  const payload = {
    updatedAt: new Date().toISOString(),
    staff: staffName,
    range: `${START} ~ ${END}`,
    campus: meta,
    items,
    errors,
  };

  const html = render(payload);
  const outDir = path.join(ROOT, 'public');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');
  // 不让搜索引擎收录个人课表页
  fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

  // 供 Actions 日志查看（不含姓名）
  console.log(JSON.stringify({
    ok: true,
    staff: staffName,
    campuses: meta.map((m) => `${m.name}:${m.count}`),
    myClasses: items.length,
    errors,
  }));

  if (errors.length) process.exitCode = 0; // 部分校区失败不阻断部署，但会记录
}

function render(p) {
  const data = JSON.stringify(p).replace(/</g, '\\u003c');
  const ts = new Date(p.updatedAt);
  // 服务器是 UTC，强制换算为北京时间，避免"更新于"显示成 UTC 时刻
  const bj = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(ts).replace('T', ' ');
  const upd = bj;
  const mineCnt = {};
  p.campus.forEach((c) => { mineCnt[c.name] = 0; });
  p.items.forEach((i) => { if (!i.late) mineCnt[i.c] = (mineCnt[i.c] || 0) + 1; });
  const campusStat = p.campus.map((c) => `${c.name.replace('校区', '')} ${mineCnt[c.name] || 0}`).join(' ｜ ');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#2563eb">
<title>我的课表</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:#f5f6f8;color:#111827;font:15px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;padding-bottom:32px}
.hd{background:#fff;padding:18px 16px 14px;border-bottom:1px solid #e5e7eb;position:sticky;top:0;z-index:9}
.hd h1{margin:0;font-size:19px;letter-spacing:-.2px}
.hd .sub{font-size:12px;color:#6b7280;margin-top:5px;line-height:1.6}
.warn{margin-top:9px;padding:8px 10px;border:1px solid #f5d0a9;background:#fffaf0;color:#9a5b12;border-radius:8px;font-size:12px;line-height:1.6}
.tabs{display:flex;gap:8px;padding:12px 16px 4px;overflow-x:auto}
.tab{flex:0 0 auto;border:1px solid #e5e7eb;background:#fff;color:#374151;border-radius:9px;padding:7px 14px;font-size:13px;font-family:inherit}
.tab.on{background:#2563eb;border-color:#2563eb;color:#fff}
.sum{display:flex;gap:8px;padding:10px 16px 2px;flex-wrap:wrap}
.chip{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:8px 12px;font-size:12px;color:#6b7280}
.chip b{display:block;font-size:18px;color:#111827;font-weight:650;margin-bottom:1px}
.wrap{padding:8px 16px 0}
.day{margin-top:14px}
.day .t{font-size:13px;color:#6b7280;margin:0 0 7px 2px;display:flex;align-items:baseline;gap:7px}
.day .t b{font-size:15px;color:#111827;font-weight:600}
.day .t .today{color:#2563eb;font-weight:600}
.ev{display:flex;gap:11px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 13px;margin-bottom:8px;align-items:flex-start}
.ev .bar{width:3px;border-radius:2px;align-self:stretch;flex:0 0 3px}
.ev .main{flex:1;min-width:0}
.ev .ti{font-size:14.5px;font-weight:600;line-height:1.35}
.ev .mt{font-size:12px;color:#6b7280;margin-top:4px}
.ev .tm{font-variant-numeric:tabular-nums;font-size:13px;color:#111827;font-weight:600;white-space:nowrap}
.ev.done{opacity:.55}
.ev.today{border-color:#bfdbfe;background:#f8fbff}
.empty{text-align:center;color:#9ca3af;font-size:13px;padding:34px 0}
.ft{padding:22px 16px 0;font-size:11.5px;color:#9ca3af;line-height:1.75}

.chip.late{border-style:dashed;background:#fafbfc}
.ev.late{background:repeating-linear-gradient(135deg,#f6f7f9,#f6f7f9 6px,#eef0f3 6px,#eef0f3 12px)}
.ev.late .bar{background:#9aa4b2!important}
.ev.late .ti{color:#4b5563}
.tag{display:inline-block;font-size:10px;padding:1px 5px;margin-right:4px;border:1px solid #d5dae1;border-radius:4px;color:#5b6572;background:#fff;vertical-align:1px}
</style></head>
<body>
<div class="hd">
  <h1>我的课表</h1>
  <div class="sub">${p.staff || ''} · 三校区合并<br>更新于 ${upd} ｜ ${campusStat}</div>
  ${(p.errors && p.errors.length) ? `<div class="warn">本次有校区未取到数据，页面可能缺课：${p.errors.map((e) => String(e).replace(/[<>]/g, '')).join('；')}。稍后会自动重试。</div>` : ''}
</div>
<div class="tabs" id="tabs"></div>
<div class="sum" id="sum"></div>
<div class="wrap" id="list"></div>
<div class="ft">数据来源：校宝教培管理系统，云端每日自动刷新。学员姓名已打码。<br>范围：${p.range}<br>本页是静态课表快照：没有任何登录入口，不需要也无法在这里输入账号密码。</div>
<script type="application/json" id="data">${data}</script>
<script>
(function(){
  var P=JSON.parse(document.getElementById('data').textContent);
  var IT=P.items||[];
  function pad(n){return n<10?'0'+n:''+n}
  function ymd(d){return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())}
  function add(d,n){var x=new Date(d.getTime());x.setDate(x.getDate()+n);return x}
  function mon(d){var x=new Date(d.getFullYear(),d.getMonth(),d.getDate());return add(x,-((x.getDay()+6)%7))}
  function hm(m){return pad(Math.floor(m/60))+':'+pad(m%60)}
  var WD=['周一','周二','周三','周四','周五','周六','周日'];
  var today=ymd(new Date()), base=mon(new Date()), off=0;
  var COL={};var PAL=['#2563eb','#f59e0b','#10b981','#8b5cf6'];
  (P.campus||[]).forEach(function(c,i){COL[c.name]=PAL[i%PAL.length]});
  IT.forEach(function(i){if(!COL[i.c])COL[i.c]=PAL[Object.keys(COL).length%PAL.length]});

  function render(){
    var m=add(base,off*7), days=[], ds=[];
    for(var i=0;i<7;i++){var d=add(m,i);days.push(d);ds.push(ymd(d))}
    document.getElementById('tabs').innerHTML=[-1,0,1].map(function(k){
      var lb=k===-1?'上周':k===0?'本周':'下周';
      return '<button class="tab'+(off===k?' on':'')+'" data-k="'+k+'">'+lb+'</button>';
    }).join('');
    var wk=IT.filter(function(i){return ds.indexOf(i.d)>-1});
    var wkC=wk.filter(function(i){return !i.late}), wkL=wk.filter(function(i){return i.late});
    var mins=0,cnt={};
    wkC.forEach(function(i){mins+=i.e-i.s;cnt[i.c]=(cnt[i.c]||0)+1});
    var stat=Object.keys(cnt).map(function(k){return k.replace('校区','')+' '+cnt[k]}).join(' · ')||'—';
    document.getElementById('sum').innerHTML=
      '<div class="chip"><b>'+wkC.length+'</b>节课</div>'+
      '<div class="chip"><b>'+(mins/60).toFixed(1)+'</b>小时</div>'+
      '<div class="chip late"><b>'+wkL.length+'</b>节晚辅</div>'+
      '<div class="chip"><b style="font-size:13px;padding-top:4px">'+stat+'</b>校区</div>';
    var h='';
    var any=false;
    days.forEach(function(d,i){
      var k=ds[i],list=wk.filter(function(x){return x.d===k});
      if(!list.length)return;
      any=true;
      h+='<div class="day"><div class="t"><b>'+WD[i]+'</b>'+(d.getMonth()+1)+'/'+d.getDate()+(k===today?' <span class="today">今天</span>':'')+'</div>';
      list.forEach(function(x){
        var c=COL[x.c]||'#2563eb';
        h+='<div class="ev'+(x.late?' late':'')+(x.done?' done':'')+(k===today?' today':'')+'">'+
           '<div class="bar" style="background:'+c+'"></div>'+
           '<div class="main"><div class="ti">'+(x.late?'<span class="tag">晚辅</span>':'')+x.t+'</div>'+
           '<div class="mt">'+x.c+(x.done?' · 已完成':'')+(x.late?' · 不计课时':'')+'</div></div>'+
           '<div class="tm">'+hm(x.s)+'<br><span style="color:#9ca3af;font-weight:400">'+hm(x.e)+'</span></div>'+
           '</div>';
      });
      h+='</div>';
    });
    document.getElementById('list').innerHTML=any?h:'<div class="empty">这一周没有课程</div>';
    Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){
      b.onclick=function(){off=parseInt(b.getAttribute('data-k'),10);render()};
    });
  }
  render();
})();
</script>
</body></html>`;
}

main().catch((e) => {
  console.error('FATAL ' + String(e && e.message ? e.message : e).slice(0, 500));
  process.exit(1);
});
