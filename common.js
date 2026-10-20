/* =========================================================
   旅費メモ - common.js
   全ページ（index.html / estimate.html / expense.html / ...）から
   <script src="common.js"></script> で読み込む共通ファイル。
   state管理・保存（localStorage）・計算ロジック・共通UI部品をまとめている。
========================================================= */
 
const STORAGE_KEY = 'tabihimemo:data:v1';
 
let state = {
  profile: null,            // {name, age, license, drink, smoke}
  currentUserId: 'me',
  trips: [],                 // Trip[]
  currentTripId: null,
  roundingRotation: {}        // tripId -> last index used for rotation method
};
 
function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,9); }
 
// ブラウザのlocalStorageに保存する（この端末・このブラウザ内のみ。無料・オフライン対応）
async function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profile: state.profile,
      trips: state.trips,
      currentTripId: state.currentTripId,
      roundingRotation: state.roundingRotation
    }));
  }catch(e){ console.error('保存に失敗しました', e); }
}
 
// localStorageから読み込む。render()は呼ばない（各ページが自分で描画するため）
async function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const data = JSON.parse(raw);
      state.profile = data.profile || null;
      state.trips = data.trips || [];
      state.currentTripId = data.currentTripId || null;
      state.roundingRotation = data.roundingRotation || {};
    }
  }catch(e){
    console.error('読み込みに失敗しました', e);
  }
}
 
function showToast(msg){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(()=> t.classList.remove('show'), 2200);
}
 
/* =========================================================
   Helpers
========================================================= */
function yen(n){
  const v = Math.round(n || 0);
  return (v<0?'-':'') + '¥' + Math.abs(v).toLocaleString('ja-JP');
}
function findTrip(id){ return state.trips.find(t=>t.id===id); }
function currentTrip(){ return findTrip(state.currentTripId); }
function memberName(trip, userId){
  const m = trip.members.find(m=>m.id===userId);
  return m ? m.name : '（不明）';
}
function isOwner(trip, userId){
  const m = trip.members.find(m=>m.id===userId);
  return !!(m && m.owner);
}
function tripStatusLabel(trip){
  const today = new Date().toISOString().slice(0,10);
  if(trip.settlements.length && trip.settlements.every(s=>s.paymentCompleted && s.receiptConfirmed)) return {text:'精算完了', done:true};
  if(trip.endDate && trip.endDate < today) return {text:'精算中', done:false};
  if(trip.startDate && trip.startDate > today) return {text:'旅行前', done:false};
  return {text:'旅行中', done:false};
}
 
// 金額入力欄にカンマ区切り表示を適用する
function formatMoneyInput(el){
  const digits = String(el.value).replace(/[^0-9]/g,'');
  const caretWasAtEnd = el.selectionStart === el.value.length;
  el.value = digits === '' ? '' : Number(digits).toLocaleString('ja-JP');
  if(caretWasAtEnd){
    el.setSelectionRange(el.value.length, el.value.length);
  }
}
// カンマ区切り表示の入力欄から数値を取り出す
function getNumberValue(id){
  const el = document.getElementById(id);
  if(!el) return 0;
  return Number(String(el.value).replace(/[^0-9]/g,'')) || 0;
}
function escapeHtml(str){
  return String(str==null?'':str).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function toggleRow(id, label, desc, checked){
  return `
  <div class="toggle-row">
    <div><div class="label">${label}</div><div class="desc">${desc}</div></div>
    <label class="switch">
      <input type="checkbox" id="${id}" ${checked?'checked':''}>
      <span class="track"></span><span class="thumb"></span>
    </label>
  </div>`;
}
// 汎用の「はい/いいえ」確認モーダル（#modal-root が存在するページで使用）
function openYesNoModal(question, onYes, onNo){
  const root = document.getElementById('modal-root');
  if(!root) return;
  root.innerHTML = `
  <div class="modal-overlay" id="yn-overlay">
    <div class="modal" style="max-width:400px;">
      <p style="font-size:15px; margin:0 0 20px 0;">${escapeHtml(question)}</p>
      <div class="btn-row">
        <button class="btn accent" id="yn-yes">はい</button>
        <button class="btn secondary" id="yn-no">いいえ</button>
      </div>
    </div>
  </div>`;
  document.getElementById('yn-yes').onclick = ()=>{ root.innerHTML=''; if(onYes) onYes(); };
  document.getElementById('yn-no').onclick = ()=>{ root.innerHTML=''; if(onNo) onNo(); };
  document.getElementById('yn-overlay').addEventListener('click', (e)=>{
    if(e.target.id==='yn-overlay'){ root.innerHTML=''; if(onNo) onNo(); }
  });
}
function modalHost(){ return `<div id="modal-root"></div>`; }
 
const ESTIMATE_CATEGORIES = [
  ['transport','交通費'], ['lodging','宿泊費'], ['food','食費'],
  ['sightseeing','観光費'], ['souvenir','お土産'], ['other','その他']
];
 
/* =========================================================
   分担ルール（費目・役割・分担方法・割り勘/立替/端数調整の計算）
========================================================= */
 
// 実費記録で使う費目（見積もり費目 + 分担ルールを分けたい費目）
const EXPENSE_CATEGORIES = ESTIMATE_CATEGORIES.filter(c=>c[0]!=='other').concat([
  ['alcohol','お酒代'], ['fuel','ガソリン代'], ['highway','高速道路料金'], ['parking','駐車場代'],
  ['other','その他']   // 「その他」は常に一番下
]);
// 費目ごとの分担方法の初期値（変更も可能）
const CATEGORY_DEFAULT_SPLIT = { alcohol:'auto_drinkers', fuel:'auto_nondriver' };
 
// 参加者の役割
const ROLES = ['運転者','同乗者','引率者','学生','教員'];
function roleOptions(selected){
  return '<option value="">未設定</option>' +
    ROLES.map(r=>`<option value="${r}" ${r===selected?'selected':''}>${r}</option>`).join('');
}
function memberTagsHtml(m){
  const t = [];
  if(m.role) t.push(m.role);
  if(m.drink) t.push('飲酒');
  if(m.exempt) t.push('今回免除');
  return t.length ? `<span class="role-badge">${t.join('・')}</span>` : '';
}
 
// 分担方法（上にあるものほど優先度が高い。グループごとにプルダウンで見出し表示）
const SPLIT_GROUPS = ['よく使う','人を選んで負担'];
const SPLIT_MODES = [
  ['equal','全員均等割り', 0],
  ['auto_nondriver','運転者以外で割り勘（役割から自動）', 0],
  ['auto_drinkers','飲酒する人だけで割り勘（自動）', 0],
  ['exclude','特定の人を除外して割り勘', 0],
  ['only','特定の人だけで負担（負担者を選択）', 1],
  ['users','利用者だけで負担（利用者を選択）', 1],
];
function splitModeOptionsHtml(){
  return SPLIT_GROUPS.map((g,gi)=>`<optgroup label="${g}">${
    SPLIT_MODES.filter(m=>m[2]===gi).map(([k,l])=>`<option value="${k}">${l}</option>`).join('')
  }</optgroup>`).join('');
}
function splitModeLabel(mode){
  const f = SPLIT_MODES.find(m=>m[0]===mode);
  return f ? f[1] : '全員均等割り';
}
 
/* =========================================================
   Core calculations: 割り勘 / 立替 / 端数調整 / 最小送金
   費用1件ごとに「誰が負担するか」を決め、端数処理を行って分担額を出す
========================================================= */
 
function hashString(str){
  let h = 2166136261;
  for(let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// 同じ費用IDなら毎回同じ並びになるシャッフル（表示のたびに金額が変わらないようにする）
function seededShuffle(arr, seedStr){
  const a = [...arr];
  let s = hashString(seedStr) || 1;
  for(let i=a.length-1;i>0;i--){
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i+1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function computePayCount(trip){
  const payCount = {};
  trip.members.forEach(m=> payCount[m.id]=0);
  trip.expenses.forEach(e=>{ if(payCount[e.payer]!==undefined) payCount[e.payer]++; });
  return payCount;
}
 
// 分担方法から負担対象者のIDを求める（⑪ 今回は負担しない人は自動的に外れる）
function resolveTargets(trip, ex){
  const mode = ex.splitMode || 'equal';
  const ms = trip.members;
  const active = ms.filter(m=>!m.exempt);
  const base = active.length ? active : ms;
  const ids = list => list.map(m=>m.id);
  const amounts = ex.splitAmounts || {};
  const ratios = ex.splitRatios || {};
  switch(mode){
    case 'exclude':        return ids(base.filter(m=>!(ex.splitExcluded||[]).includes(m.id)));
    case 'only':
    case 'users':          return ids(ms.filter(m=>(ex.splitTargets||[]).includes(m.id)));
    case 'auto_nondriver': return ids(base.filter(m=>m.role!=='運転者'));
    case 'auto_drinkers':  return ids(base.filter(m=>!!m.drink));
    case 'auto_role':      return ids(base.filter(m=>m.role!==ex.splitRole));
    case 'amounts':        return ids(ms.filter(m=>(Number(amounts[m.id])||0)>0));
    case 'ratio':          return ids(ms.filter(m=>(Number(ratios[m.id])||0)>0));
    default:               return ids(base);
  }
}
 
// 端数を誰が負担するか（trip.roundingMethod に従う）
function remainderOrder(trip, ex, ids, exIndex, payCount){
  const method = trip.roundingMethod || 'random';
  const idx = id => trip.members.findIndex(m=>m.id===id);
  const isOwnerId = id => { const m = trip.members.find(x=>x.id===id); return !!(m && m.owner); };
  let order = [...ids].sort((a,b)=> idx(a)-idx(b));
  if(method === 'owner'){
    order = order.filter(isOwnerId).concat(order.filter(id=>!isOwnerId(id)));
  } else if(method === 'rotation'){
    const off = order.length ? exIndex % order.length : 0;
    order = order.slice(off).concat(order.slice(0, off));
  } else if(method === 'payer_priority'){
    // 立替回数が多い人ほど負担を軽減 → 立替回数が少ない順に端数を負担
    order = order.map((id,i)=>({id,i}))
      .sort((a,b)=> ((payCount[a.id]||0)-(payCount[b.id]||0)) || (a.i-b.i))
      .map(o=>o.id);
  } else {
    order = seededShuffle(order, ex.id || String(exIndex));
  }
  return order;
}
 
// 均等割り＋端数調整（合計が必ず元の金額と一致する）
function distributeEqual(trip, ex, exIndex, payCount, ids, amount, unit){
  const shares = {};
  trip.members.forEach(m=> shares[m.id]=0);
  const n = ids.length;
  const base = Math.floor(amount / n / unit) * unit;
  ids.forEach(id=> shares[id] = base);
  let rem = amount - base * n;
  const order = remainderOrder(trip, ex, ids, exIndex, payCount);
  const extra = Math.floor(rem / unit);
  for(let i=0;i<extra;i++){ shares[order[i % n]] += unit; }
  rem -= extra * unit;
  if(rem > 0) shares[order[0]] += rem;
  return shares;
}
 
// 費用1件の分担額 { memberId: 金額 }
function splitExpense(trip, ex, exIndex, payCount){
  const amount = Math.round(Number(ex.actual)||0);
  const unit = trip.roundingUnit || 1;
  const mode = ex.splitMode || 'equal';
  const allIds = trip.members.map(m=>m.id);
  const zero = () => { const o={}; allIds.forEach(id=>o[id]=0); return o; };
  if(amount <= 0 || !allIds.length) return zero();
 
  if(mode === 'amounts'){
    const a = ex.splitAmounts || {};
    const sum = allIds.reduce((s,id)=> s + (Number(a[id])||0), 0);
    if(sum === amount){
      const shares = zero();
      allIds.forEach(id=> shares[id] = Number(a[id])||0);
      return shares;
    }
    // 参加者の増減などで合計が合わなくなった場合は全員均等にフォールバック
    return distributeEqual(trip, ex, exIndex, payCount, allIds, amount, unit);
  }
 
  if(mode === 'ratio'){
    const r = ex.splitRatios || {};
    const ids = resolveTargets(trip, ex);
    const total = ids.reduce((s,id)=> s + (Number(r[id])||0), 0);
    if(total > 0){
      const shares = zero();
      const raw = ids.map(id=>({ id, v: amount * (Number(r[id])||0) / total }));
      raw.forEach(x=> shares[x.id] = Math.floor(x.v / unit) * unit);
      let rem = amount - raw.reduce((s,x)=> s + shares[x.id], 0);
      const byFrac = [...raw].sort((a,b)=> (b.v - shares[b.id]) - (a.v - shares[a.id]));
      let i = 0;
      while(rem >= unit){ shares[byFrac[i % byFrac.length].id] += unit; rem -= unit; i++; }
      if(rem > 0) shares[byFrac[0].id] += rem;
      return shares;
    }
  }
 
  let ids = resolveTargets(trip, ex);
  if(!ids.length) ids = allIds;
  return distributeEqual(trip, ex, exIndex, payCount, ids, amount, unit);
}
 
function computeShares(trip){
  const payCount = computePayCount(trip);
  const shareMap = {};
  trip.members.forEach(m=> shareMap[m.id]=0);
  const perExpense = [];
  let totalActual = 0;
  trip.expenses.forEach((ex, i)=>{
    const sh = splitExpense(trip, ex, i, payCount);
    perExpense.push(sh);
    totalActual += Math.round(Number(ex.actual)||0);
    Object.keys(sh).forEach(id=>{ shareMap[id] = (shareMap[id]||0) + sh[id]; });
  });
  return { shareMap, totalActual, perExpense };
}
 
// 立替金額(支払った額) - 分担額(share) の収支を出す（⑦ 支払者と負担者は別々に扱う）
function computeBalances(trip){
  const { shareMap, totalActual, perExpense } = computeShares(trip);
  const paid = {};
  trip.members.forEach(m=> paid[m.id]=0);
  trip.expenses.forEach(e=>{ if(paid[e.payer]!==undefined) paid[e.payer] += Number(e.actual)||0; });
 
  const balances = {};
  trip.members.forEach(m=>{
    balances[m.id] = (paid[m.id]||0) - (shareMap[m.id]||0);
  });
  return { balances, paid, shareMap, totalActual, perExpense };
}
 
// 分担方法の短い説明（一覧表示用）
function describeSplit(trip, ex){
  const names = list => (list||[]).map(id=>memberName(trip,id)).join('・');
  switch(ex.splitMode || 'equal'){
    case 'exclude':        return '除外：' + (names(ex.splitExcluded) || 'なし');
    case 'only':           return '負担者：' + names(ex.splitTargets);
    case 'users':          return '利用者：' + names(ex.splitTargets);
    case 'amounts':        return '個別金額';
    case 'ratio':          return '割合で分担';
    case 'auto_nondriver': return '運転者以外';
    case 'auto_drinkers':  return '飲酒する人のみ';
    case 'auto_role':      return (ex.splitRole||'') + 'を除く';
    default:               return '全員均等';
  }
}
 
function categoryLabel(k){ const f = EXPENSE_CATEGORIES.find(c=>c[0]===k); return f?f[1]:k; }
 
function computeMinimalTransfers(balances){
  const creditors = [];
  const debtors = [];
  Object.entries(balances).forEach(([id, v])=>{
    const val = Math.round(v);
    if(val > 0) creditors.push({id, amount: val});
    else if(val < 0) debtors.push({id, amount: -val});
  });
  creditors.sort((a,b)=> b.amount - a.amount);
  debtors.sort((a,b)=> b.amount - a.amount);
 
  const transfers = [];
  let ci = 0, di = 0;
  while(ci < creditors.length && di < debtors.length){
    const c = creditors[ci], d = debtors[di];
    const amount = Math.min(c.amount, d.amount);
    if(amount > 0){
      transfers.push({ payer: d.id, receiver: c.id, amount });
    }
    c.amount -= amount;
    d.amount -= amount;
    if(c.amount <= 0) ci++;
    if(d.amount <= 0) di++;
  }
  return transfers;
}
 
function ensureSettlements(trip){
  const { balances } = computeBalances(trip);
  const transfers = computeMinimalTransfers(balances);
  const newList = transfers.map(t=>{
    const reuse = trip.settlements.find(s=> s.payer===t.payer && s.receiver===t.receiver && !s.receiptConfirmed);
    if(reuse){ reuse.amount = t.amount; return reuse; }
    return { id: uid('stl'), payer: t.payer, receiver: t.receiver, amount: t.amount, paymentCompleted:false, receiptConfirmed:false, completedAt:null };
  });
  trip.settlements = newList;
}
 
function settlementStatus(s){
  return (s.paymentCompleted && s.receiptConfirmed) ? 'done' : 'unpaid';
}
function roundingMethodLabel(m){
  return {random:'ランダム', rotation:'持ち回り', owner:'管理者負担', payer_priority:'立替者優先'}[m] || m;
}
 
/* =========================================================
   マルチページ共通: 上部バー・旅行タブのナビゲーション
========================================================= */
function topbar(showWho){
  return `
  <div class="topbar">
    <div class="brand">
      <div class="stamp">旅</div>
      <h1>旅費メモ</h1>
    </div>
    ${showWho && state.profile ? `
    <div class="who">
      ${state.profile.name} さん<br>
      <a href="index.html?edit=profile">プロフィールを編集</a>
    </div>` : ''}
  </div>`;
}
 
// 旅行詳細の各ページ（見積もり・実費記録・精算…）で共通のタブ一覧
const PAGES = [
  ['estimate.html','見積もり'],
  ['expense.html','実費記録'],
  ['settlement.html','精算'],
  ['payment.html','支払い管理'],
  ['members.html','参加者'],
  ['invite.html','招待'],
  ['notify.html','通知設定'],
];
 
// 現在のページ名(例: 'estimate.html')と旅行情報から、共通の枠(戻るリンク・タブ・本文)を組み立てる
function renderTripShell(activePage, trip, bodyHtml){
  const tabsHtml = PAGES.map(([href,label])=>
    `<a class="tab-btn ${activePage===href?'active':''}" href="${href}?trip=${trip.id}">${label}</a>`
  ).join('');
  return `
  <main>
    <a class="back-link" href="index.html">← 旅行一覧に戻る</a>
    <div class="trip-header">
      <div>
        <h2>${escapeHtml(trip.title)}</h2>
        <div class="route">${escapeHtml(trip.departure)} → ${escapeHtml(trip.destination)} ｜ ${trip.startDate} 〜 ${trip.endDate}</div>
      </div>
    </div>
    <div class="tabs">${tabsHtml}</div>
    ${bodyHtml}
  </main>
  ${modalHost()}`;
}
 
// 旅行詳細の各ページ（estimate.html など）が呼び出す共通の初期化処理。
// 1) state読み込み 2) プロフィール・旅行の有無を確認してなければindex.htmlへ 3) 枠を描画 4) ページ固有のrender/bindを実行
let __page = { key:null, render:null, bind:null };
 
async function initTripPage(pageKey, renderFn, bindFn){
  await loadState();
  if(!state.profile){ location.href = 'index.html'; return; }
 
  const params = new URLSearchParams(location.search);
  const tripId = params.get('trip') || state.currentTripId;
  const trip = findTrip(tripId);
  if(!trip){ location.href = 'index.html'; return; }
 
  state.currentTripId = trip.id;
  __page = { key: pageKey, render: renderFn, bind: bindFn };
  renderTripPage();
}
 
// 状態を保存したうえで、現在のページを再描画する（保存系の操作の後に呼ぶ）
function rerenderPage(){
  saveState();
  renderTripPage();
}
 
function renderTripPage(){
  const trip = findTrip(state.currentTripId);
  if(!trip){ location.href = 'index.html'; return; }
  document.getElementById('app').innerHTML =
    topbar(true) + renderTripShell(__page.key, trip, __page.render(trip));
  __page.bind(trip);
}
 
