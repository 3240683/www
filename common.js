/* =========================================================
   旅費メモ - common.js
   全ページ（index.html / estimate.html / expense.html / ...）から
   <script src="common.js"></script> で読み込む共通ファイル。
   state管理・保存（localStorage）・計算ロジック・共通UI部品をまとめている。
========================================================= */
 
/* ▼▼▼ 追加: 画面が真っ白になる代わりに、エラー内容と復旧ボタンを表示する（ここから） ▼▼▼ */
(function(){
  function showFatal(msg){
    const app = document.getElementById('app');
    if(!app || app.innerHTML.trim()) return;      // すでに画面が表示されている場合は何もしない
    app.innerHTML =
      '<div style="max-width:560px;margin:40px auto;padding:20px;border:1px solid #c0392b;background:#fff;font-size:14px;line-height:1.7;">' +
      '<b style="color:#c0392b">画面を表示できませんでした</b>' +
      '<p id="fatal-msg" style="word-break:break-all;color:#555;margin:8px 0;"></p>' +
      '<p>ブラウザに保存されている古い形式のデータが原因の場合があります。下のボタンで保存データを初期化すると直ることがあります（この端末に保存した旅行データは消えます）。</p>' +
      '<button id="fatal-reset" style="padding:8px 14px;cursor:pointer;">保存データを初期化して再読み込み</button></div>';
    document.getElementById('fatal-msg').textContent = 'エラー内容：' + msg;
    document.getElementById('fatal-reset').onclick = ()=>{
      try{ localStorage.removeItem('tabihimemo:data:v1'); }catch(e){}
      location.href = 'index.html';
    };
  }
  window.addEventListener('error', e=> showFatal(e.message || String(e.error)));
  window.addEventListener('unhandledrejection', e=> showFatal((e.reason && e.reason.message) || String(e.reason)));
})();
/* ▲▲▲ 追加: エラー表示（ここまで） ▲▲▲ */

// 追加: 端末の現地時間での日付（YYYY-MM-DD）。toISOString() はUTCなので、日本の0〜9時に前日の日付になってしまう
function localDateStr(d){
  d = d || new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

const STORAGE_KEY = 'tabihimemo:data:v1';
 
let state = {
  profile: null,            // {name, age, license, drink, smoke}
  currentUserId: 'me',
  trips: [],                 // Trip[]
  currentTripId: null,
  roundingRotation: {},       // tripId -> last index used for rotation method
  deletedTrips: {}            // 追加: 削除した旅行ID -> 削除した時刻（クラウド同期で「削除済み」を伝えるため）
};

let __hashes = {};            // 追加: 旅行ID -> 読み込み時点の内容のハッシュ（変更を検出して更新日時を付けるため）
let __knownIds = new Set();   // 追加: 前回保存した時点の旅行ID一覧（削除の検出用）
 
function uid(prefix){ return prefix + '_' + Math.random().toString(36).slice(2,9); }
 
// ブラウザのlocalStorageに保存する（この端末・このブラウザ内のみ。無料・オフライン対応）
async function saveState(){
  try{
    const now = Date.now();
    // 変更があった旅行には更新日時（updatedAt）を付ける（クラウド同期で新旧を比べるため）
    state.trips.forEach(t=>{
      const h = tripHash(t);
      if(__hashes[t.id] !== h || !t.updatedAt){ t.updatedAt = now; __hashes[t.id] = tripHash(t); }
    });
    // 削除された旅行を記録する（呼び出し側の削除処理を変えずに検出できる）
    const ids = new Set(state.trips.map(t=>t.id));
    __knownIds.forEach(id=>{ if(!ids.has(id)) state.deletedTrips[id] = now; });
    ids.forEach(id=>{ delete state.deletedTrips[id]; });
    __knownIds = ids;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      profile: state.profile,
      currentUserId: state.currentUserId,
      trips: state.trips,
      currentTripId: state.currentTripId,
      deletedTrips: state.deletedTrips,
      knownTripIds: [...ids],
    }));
    if(typeof window.__afterSave === 'function') window.__afterSave();     // クラウド同期（cloud.js）が使う
  }catch(e){ console.error('保存に失敗しました', e); }
}
function tripHash(t){ const c = Object.assign({}, t); delete c.updatedAt; return hashString(JSON.stringify(c)); }

// localStorageから読み込む。render()は呼ばない（各ページが自分で描画するため）
async function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const data = JSON.parse(raw);
      state.profile = data.profile || null;
      state.currentUserId = data.currentUserId || 'me';
      state.trips = Array.isArray(data.trips) ? data.trips.filter(Boolean) : [];
      state.currentTripId = data.currentTripId || null;
      state.trips.forEach(normalizeTrip);      // 追加: 古い形式のデータでも動くように不足項目を補う
      state.deletedTrips = (data.deletedTrips && typeof data.deletedTrips === 'object') ? data.deletedTrips : {};
      __knownIds = new Set(Array.isArray(data.knownTripIds) ? data.knownTripIds : state.trips.map(t=>t.id));
    }
  }catch(e){
    console.error('読み込みに失敗しました', e);
  }
  __hashes = {}; state.trips.forEach(t=>{ __hashes[t.id] = tripHash(t); });
  await purgeTempReceipts();
}

/* ▼▼▼ 追加: 旅行データの不足項目を補う（古いバージョンで保存したデータ対策）（ここから） ▼▼▼ */
function normalizeTrip(t){
  const str = v => (typeof v === 'string' ? v : '');
  t.title = str(t.title); t.departure = str(t.departure); t.destination = str(t.destination);
  t.startDate = str(t.startDate); t.endDate = str(t.endDate);
  if(!Array.isArray(t.members)) t.members = [];
  t.members = t.members.filter(Boolean);
  if(!t.members.length){
    t.members = [{ id: state.currentUserId, name: (state.profile && state.profile.name) || '自分', owner: true }];
  }
  if(!t.estimate || typeof t.estimate !== 'object') t.estimate = {};
  ESTIMATE_CATEGORIES.forEach(([k])=>{ t.estimate[k] = Number(t.estimate[k]) || 0; });
  if(!Array.isArray(t.expenses)) t.expenses = [];
  t.expenses = t.expenses.filter(Boolean);
  t.expenses.forEach(e=>{
    if(!e.id) e.id = uid('exp');
    if(!e.payer && t.members[0]) e.payer = t.members[0].id;
  });
  if(!Array.isArray(t.settlements)) t.settlements = [];
  if(!t.invite) t.invite = null;
  t.notifications = Object.assign({ settlement:true, reminder:true, deadline:true }, t.notifications || {});
  if(!t.roundingUnit) t.roundingUnit = 1;
  if(!t.roundingMethod) t.roundingMethod = 'random';
}
/* ▲▲▲ 追加: 旅行データの補完（ここまで） ▲▲▲ */
 
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
  const today = localDateStr();      // 変更: UTCではなく端末の現地時間の日付で判定する
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
 
/* ▼▼▼ 変更: 精算の再計算で、精算完了済み（送金・受取の両方が確認済み）の記録を消さないようにする（ここから） ▼▼▼ */
// 以前は、完了済みの記録を捨てて、完了した支払いを残高にも反映していなかったため、
// 精算後に実費を追加して再計算すると、支払い済みの金額が再び「未払い」として現れていた。
// 変更後: 完了済みの送金は「すでに支払われた」として残高に反映し、記録も残す。未完了の分だけを、残りの金額で作り直す。
function isSettlementDone(s){ return !!(s && s.paymentCompleted && s.receiptConfirmed); }

function computeOpenTransfers(trip){
  const done = (trip.settlements || []).filter(isSettlementDone);
  const { balances } = computeBalances(trip);
  done.forEach(s=>{
    if(balances[s.payer] !== undefined)    balances[s.payer]    += Number(s.amount) || 0;   // 払った側: 借りが減る
    if(balances[s.receiver] !== undefined) balances[s.receiver] -= Number(s.amount) || 0;   // 受け取った側: 貸しが減る
  });
  return computeMinimalTransfers(balances);
}

function ensureSettlements(trip){
  const old = Array.isArray(trip.settlements) ? trip.settlements : [];
  const done = old.filter(isSettlementDone);
  const open = computeOpenTransfers(trip).map(t=>{
    const reuse = old.find(s=> s.payer===t.payer && s.receiver===t.receiver && !isSettlementDone(s));
    if(reuse){
      // 金額が変わったときは、以前の「支払い済み／受取済み」の回答は別の金額に対するものなので取り消す
      if(reuse.amount !== t.amount){ reuse.paymentCompleted = false; reuse.receiptConfirmed = false; reuse.completedAt = null; }
      reuse.amount = t.amount;
      return reuse;
    }
    return { id: uid('stl'), payer: t.payer, receiver: t.receiver, amount: t.amount, paymentCompleted:false, receiptConfirmed:false, completedAt:null };
  });
  trip.settlements = done.concat(open);
}

// 保存済みの精算結果が、現在の実費・参加者から計算した内容と食い違っているか（実費を追加・編集したあとなど）
function settlementsStale(trip){
  const old = Array.isArray(trip.settlements) ? trip.settlements : [];
  if(!old.length) return false;                    // まだ一度も計算していない場合は対象外
  const open = old.filter(s=> !isSettlementDone(s));
  const expected = computeOpenTransfers(trip);
  if(expected.length !== open.length) return true;
  return expected.some(t=> !open.find(s=> s.payer===t.payer && s.receiver===t.receiver && s.amount===t.amount));
}

// 指定した参加者が支払者になっている実費の件数（この件数がある人を削除すると、精算が正しく計算できなくなる）
function paidExpenseCount(trip, memberId){
  return (trip.expenses || []).filter(e=> e.payer === memberId).length;
}
/* ▲▲▲ 変更: 精算の再計算（ここまで） ▲▲▲ */

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
      ${escapeHtml(state.profile.name)} さん<br>
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
  if(runTimeNotifications(trip)) await saveState();     // 追加: 日付などの条件で出す通知（入力リマインダー・支払い期限）
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
 


/* =========================================================
   レシート画像の保存（IndexedDB）
   ・expense.html から移動して共通化（書き出し・読み込み、一時保存の片付けでも使うため）
   ・旅行データ側には画像のID（receiptId）だけを持たせる。外部には送信されない。
========================================================= */
const RCP_DB = 'tabihimemo-receipts', RCP_STORE = 'receipts';
function idbOpen(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(RCP_DB, 1);
    req.onupgradeneeded = ()=> req.result.createObjectStore(RCP_STORE);
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
async function idbRun(mode, fn){
  const db = await idbOpen();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction(RCP_STORE, mode);
    const req = fn(tx.objectStore(RCP_STORE));
    tx.oncomplete = ()=>{ db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = tx.onabort = ()=>{ db.close(); reject(tx.error); };
  });
}
const idbPut    = (id, blob)=> idbRun('readwrite', st=> st.put(blob, id));
const idbGet    = (id)=>       idbRun('readonly',  st=> st.get(id));
const idbDelete = (id)=>       idbRun('readwrite', st=> st.delete(id));
const idbKeys   = ()=>         idbRun('readonly',  st=> st.getAllKeys());

// 一時保存の画像（receiptTemp:true）は、このタブ（セッション）の間だけ残し、新しくサイトを開いたときに片付ける。
// 最長でも24時間。「ずっと保存」にした画像（receiptTemp なし）は残る。
const TEMP_RECEIPT_MAX_MS = 24 * 3600 * 1000;
async function purgeTempReceipts(){
  try{
    const mk = sessionStorage.getItem('tabihimemo:session');
    if(mk && Date.now() - Number(mk) < TEMP_RECEIPT_MAX_MS) return;       // 同じセッションの間は消さない
    sessionStorage.setItem('tabihimemo:session', String(Date.now()));
    let changed = false;
    for(const t of state.trips){
      for(const e of (t.expenses || [])){
        if(e.receiptId && e.receiptTemp){
          try{ await idbDelete(e.receiptId); }catch(_){}
          delete e.receiptId; delete e.receiptTemp; changed = true;
        }
      }
    }
    if(changed) await saveState();
  }catch(e){ console.warn('一時保存の画像の片付けに失敗しました', e); }
}

/* =========================================================
   データの書き出し・読み込み（バックアップ／別の端末への引き継ぎ）
   ・サーバーを使わず、ファイル（JSON）で受け渡す
========================================================= */
function blobToDataURL(blob){
  return new Promise((resolve, reject)=>{ const r = new FileReader(); r.onload = ()=> resolve(r.result); r.onerror = ()=> reject(r.error); r.readAsDataURL(blob); });
}
function dataURLToBlob(url){
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url || '');
  if(!m) throw new Error('画像データの形式が正しくありません');
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}
// 書き出すデータを組み立てる（includeImages: レシート画像も含めるか。画像は容量が大きくなる）
async function buildBackup(includeImages){
  const receipts = {};
  let skipped = 0;
  if(includeImages){
    const ids = new Set();
    state.trips.forEach(t=> (t.expenses || []).forEach(e=>{ if(e.receiptId) ids.add(e.receiptId); }));
    for(const id of ids){
      try{ const b = await idbGet(id); if(b) receipts[id] = await blobToDataURL(b); else skipped++; }catch(_){ skipped++; }
    }
  }
  return { backup: { app:'tabihimemo', version:1, exportedAt:new Date().toISOString(),
    profile: state.profile, currentUserId: state.currentUserId, trips: state.trips, receipts }, skippedImages: skipped };
}
function downloadJson(obj, filename){
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj)], { type:'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}
// 読み込んだファイルを確認する（別の形式のファイルを誤って読み込まないように）
function parseBackup(text){
  let d;
  try{ d = JSON.parse(text); }catch(e){ throw new Error('ファイルの形式が正しくありません（JSONとして読めません）'); }
  if(!d || d.app !== 'tabihimemo' || !Array.isArray(d.trips)) throw new Error('旅費メモのバックアップファイルではありません');
  if(d.version && d.version > 1) throw new Error('新しいバージョンのバックアップです。アプリを更新してから読み込んでください');
  return d;
}
// mode: 'merge' = いまのデータに追加（同じ旅行は重複させない） / 'replace' = いまのデータをすべて置き換える
async function applyBackup(d, mode){
  const incoming = d.trips.filter(t=> t && typeof t === 'object' && t.id).map(t=> JSON.parse(JSON.stringify(t)));
  let added = 0, skipped = 0;
  if(mode === 'replace'){
    state.trips = incoming; added = incoming.length;
    if(d.profile) state.profile = d.profile;
  } else {
    for(const t of incoming){
      const same = state.trips.find(x=> x.id === t.id);
      if(same){
        if(tripHash(same) === tripHash(t)){ skipped++; continue; }       // まったく同じ内容なら追加しない
        t.id = uid('trip'); t.title = (t.title || '') + '（読み込み）';  // 同じIDで内容が違う場合は、別の旅行として追加する
      }
      state.trips.unshift(t); added++;
    }
    if(!state.profile && d.profile) state.profile = d.profile;
  }
  state.trips.forEach(normalizeTrip);
  // 画像を戻す（すでにあるIDは上書きしない）
  let imgs = 0;
  for(const [id, url] of Object.entries(d.receipts || {})){
    try{ const have = await idbGet(id); if(!have){ await idbPut(id, dataURLToBlob(url)); imgs++; } }catch(_){}
  }
  await saveState();
  return { added, skipped, images: imgs };
}

/* =========================================================
   通知（旅行ごとの履歴 trip.notificationHistory に積む）
   ・type: 'settlement'（精算）/ 'reminder'（入力リマインダー）/ 'deadline'（支払い期限）
   ・設定でOFFにした種類は発生しない。通知は、この端末の履歴にだけ残る（相手の端末には届かない）
========================================================= */
const PAYMENT_DEADLINE_DAYS = 7;       // 旅行終了日からこの日数が過ぎても精算が終わっていなければ「支払い期限」の通知を出す
function pushTripNotification(trip, type, message, opts){
  opts = opts || {};
  if(!trip.notifications) trip.notifications = { settlement:true, reminder:true, deadline:true, message:true };
  if(trip.notifications[type] === false) return false;
  if(!Array.isArray(trip.notificationHistory)) trip.notificationHistory = [];
  if(opts.key && trip.notificationHistory.some(n=> n.key === opts.key)) return false;     // 同じ通知は重ねて出さない
  const item = {
    id: 'notification_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    type, message, senderId: state.currentUserId, recipientId: null, createdAt: new Date().toISOString()
  };
  if(opts.key) item.key = opts.key;
  trip.notificationHistory.unshift(item);
  if(trip.notificationHistory.length > 200) trip.notificationHistory.length = 200;
  try{ if('Notification' in window && Notification.permission === 'granted') new Notification('旅費メモ', { body: message }); }catch(_){}
  return true;
}
// 日付などの条件で出す通知（旅行ページを開いたときに確認する。同じ内容は1日1回まで）
function runTimeNotifications(trip){
  const today = localDateStr();
  let made = 0;
  const hasExp = (trip.expenses || []).length > 0;
  if(trip.endDate && today > trip.endDate && !hasExp){
    made += pushTripNotification(trip, 'reminder', `「${trip.title}」の旅行が終了しましたが、実費がまだ記録されていません。`, { key:`reminder-empty-${trip.id}` }) ? 1 : 0;
  }
  if(trip.startDate && trip.endDate && today >= trip.startDate && today <= trip.endDate && !(trip.expenses || []).some(e=> e.date === today)){
    made += pushTripNotification(trip, 'reminder', '今日の支出をまだ記録していません。レシートを撮影して記録しましょう。', { key:`reminder-day-${trip.id}-${today}` }) ? 1 : 0;
  }
  const open = (trip.settlements || []).filter(s=> !isSettlementDone(s));
  if(trip.endDate && open.length){
    const limit = localDateStr(new Date(new Date(trip.endDate + 'T00:00:00').getTime() + PAYMENT_DEADLINE_DAYS * 864e5));
    if(today > limit) made += pushTripNotification(trip, 'deadline', `精算の支払いがまだ完了していません（未完了${open.length}件）。旅行終了から${PAYMENT_DEADLINE_DAYS}日が過ぎています。`, { key:`deadline-${trip.id}-${today}` }) ? 1 : 0;
  }
  return made;
}
