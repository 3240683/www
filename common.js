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
function categoryLabel(k){ const f = ESTIMATE_CATEGORIES.find(c=>c[0]===k); return f?f[1]:k; }

/* =========================================================
   Core calculations: 割り勘 / 立替 / 端数調整 / 最小送金
========================================================= */
function computeShares(trip){
  const members = trip.members;
  const n = members.length || 1;
  const unit = trip.roundingUnit || 1;
  const totalActual = trip.expenses.reduce((s,e)=> s + (Number(e.actual)||0), 0);

  const base = Math.floor((totalActual / n) / unit) * unit;
  let remainder = totalActual - base * n;
  const extraUnits = unit>0 ? Math.round(remainder / unit) : 0;

  const shareMap = {};
  members.forEach(m => shareMap[m.id] = base);

  let order = members.map(m=>m.id);
  const method = trip.roundingMethod || 'random';

  if(method === 'owner'){
    order = members.filter(m=>m.owner).map(m=>m.id).concat(members.filter(m=>!m.owner).map(m=>m.id));
  } else if(method === 'rotation'){
    const idx = state.roundingRotation[trip.id] || 0;
    order = members.map((m,i)=> members[(i+idx)%members.length].id);
    state.roundingRotation[trip.id] = (idx + 1) % members.length;
  } else if(method === 'payer_priority'){
    const payCount = {};
    members.forEach(m=> payCount[m.id]=0);
    trip.expenses.forEach(e=>{ if(payCount[e.payer]!==undefined) payCount[e.payer]++; });
    order = [...members].sort((a,b)=> payCount[a.id]-payCount[b.id]).map(m=>m.id);
  } else {
    order = [...order].sort(()=>Math.random()-0.5);
  }

  for(let i=0; i<extraUnits && i<order.length; i++){
    shareMap[order[i]] += unit;
  }
  let assigned = Object.values(shareMap).reduce((a,b)=>a+b,0);
  const leftover = totalActual - assigned;
  if(leftover !== 0 && members.length){
    shareMap[members[members.length-1].id] += leftover;
  }
  return { shareMap, totalActual };
}

function computeBalances(trip){
  const { shareMap, totalActual } = computeShares(trip);
  const paid = {};
  trip.members.forEach(m=> paid[m.id]=0);
  trip.expenses.forEach(e=>{ if(paid[e.payer]!==undefined) paid[e.payer] += Number(e.actual)||0; });

  const balances = {};
  trip.members.forEach(m=>{
    balances[m.id] = (paid[m.id]||0) - (shareMap[m.id]||0);
  });
  return { balances, paid, shareMap, totalActual };
}

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
