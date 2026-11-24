/* =========================================================
   旅費メモ - cloud.js
   メールアドレスでログインして、旅行データをクラウド（Firebase）に保存・同期する【任意機能】
   ・firebase-config.js に Firebase の設定を入れたときだけ有効になる（未設定なら何もしない）
   ・認証：メールリンク（パスワード不要）／保存先：Firestore の users/{uid}/ 以下（本人だけが読み書きできる）
   ・同期するもの：旅行データ・プロフィール（レシート画像は含まない）
   ・今回の範囲：「自分のデータを、ログインした別の端末でも使えるようにする」まで。
     他の人のアカウントと旅行を共有する機能（共同編集）は含まれない。
   ・index.html から <script src="cloud.js"></script> で読み込む（common.js より後）
========================================================= */
const Cloud = (function(){
  const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
  const EMAIL_KEY = 'tabihimemo:emailForSignIn';
  const SYNC_KEY  = 'tabihimemo:lastSync';
  const MAX_TRIP_BYTES = 900 * 1024;            // Firestore の1ドキュメントは約1MBまで

  let fb = null, remote = null, user = null;
  let ready = false, busy = false, inSync = false, message = '', timer = null, started = false;
  let pendingLink = false;        // ログイン用リンクで開いたが、メールアドレスの確認がまだ済んでいない状態（別の端末・アプリ内ブラウザで開いた場合）
  const listeners = [];

  const config = ()=> (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.apiKey && !/^YOUR/i.test(window.FIREBASE_CONFIG.apiKey)) ? window.FIREBASE_CONFIG : null;
  const configured = ()=> !!config() || !!remote;
  const emit = ()=> listeners.forEach(fn=>{ try{ fn(); }catch(e){ console.error(e); } });
  const setMessage = (m)=>{ message = m || ''; emit(); };

  /* ---------------------------------------------------------
     同期の計画（Firebase に依存しない純粋な関数。新旧の判定だけを行う）
     local:   [{id, updatedAt, ...}]       この端末の旅行
     deleted: { id: 削除した時刻 }          この端末で削除した旅行
     remoteDocs: [{id, updatedAt, deleted, json}]  クラウド側（deleted:true は「削除済み」の印）
  --------------------------------------------------------- */
  function planSync(local, deleted, remoteDocs){
    const plan = { upload: [], download: [], deleteLocal: [], tombstone: [] };
    const L = new Map(local.map(t=> [t.id, t]));
    const R = new Map(remoteDocs.map(d=> [d.id, d]));
    const ids = new Set([...L.keys(), ...R.keys(), ...Object.keys(deleted || {})]);
    ids.forEach(id=>{
      const l = L.get(id), r = R.get(id), ld = (deleted || {})[id];
      if(l){
        if(!r) plan.upload.push(l.id);
        else if(r.deleted){ (l.updatedAt || 0) > (r.updatedAt || 0) ? plan.upload.push(id) : plan.deleteLocal.push(id); }   // 削除より後に編集したなら復活させる
        else if((l.updatedAt || 0) > (r.updatedAt || 0)) plan.upload.push(id);
        else if((l.updatedAt || 0) < (r.updatedAt || 0)) plan.download.push(id);
      } else if(r && !r.deleted){
        if(ld && ld > (r.updatedAt || 0)) plan.tombstone.push({ id, at: ld });   // この端末で削除したあとに、クラウド側は更新されていない
        else plan.download.push(id);                                              // 初めて見る旅行、または削除後に他の端末で更新された旅行
      } else if(!r && ld){
        plan.tombstone.push({ id, at: ld });                                      // クラウド側にはまだ無い削除（印だけ残す）
      }
    });
    return plan;
  }

  /* ---------------------------------------------------------
     同期の実行
  --------------------------------------------------------- */
  async function syncNow(){
    if(!user || !remote) throw new Error('ログインしていません');
    if(busy) return null;
    busy = true; inSync = true; emit();
    const result = { up:0, down:0, removed:0, skipped:[] };
    try{
      const remoteDocs = await remote.listTrips();
      const plan = planSync(state.trips, state.deletedTrips, remoteDocs);
      const R = new Map(remoteDocs.map(d=> [d.id, d]));

      // クラウド → この端末
      plan.download.forEach(id=>{
        let t; try{ t = JSON.parse(R.get(id).json); }catch(e){ result.skipped.push(id); return; }
        t.id = id; t.updatedAt = R.get(id).updatedAt; normalizeTrip(t);
        const i = state.trips.findIndex(x=> x.id === id);
        i >= 0 ? (state.trips[i] = t) : state.trips.unshift(t);
        __hashes[id] = tripHash(t);                 // この変更は「同期で取り込んだもの」なので、更新日時を付け直さない
        __knownIds.add(id); delete state.deletedTrips[id]; result.down++;
      });
      plan.deleteLocal.forEach(id=>{
        state.trips = state.trips.filter(x=> x.id !== id);
        __knownIds.delete(id); delete __hashes[id];
        state.deletedTrips[id] = R.get(id).updatedAt; result.removed++;
      });
      // この端末 → クラウド
      for(const id of plan.upload){
        const t = state.trips.find(x=> x.id === id); const json = JSON.stringify(t);
        if(json.length > MAX_TRIP_BYTES){ result.skipped.push(id); continue; }
        await remote.putTrip(id, { json, updatedAt: t.updatedAt, deleted: false }); result.up++;
      }
      for(const tb of plan.tombstone){ await remote.putTrip(tb.id, { json:'', updatedAt: tb.at, deleted: true }); }

      // プロフィール: この端末に無ければクラウドのものを使い、あれば最新をクラウドへ
      const rp = await remote.getProfile();
      if(!state.profile && rp && rp.profileJson){ try{ state.profile = JSON.parse(rp.profileJson); }catch(e){} }
      else if(state.profile){
        const pj = JSON.stringify(state.profile);
        if(!rp || rp.profileJson !== pj) await remote.putProfile({ profileJson: pj, email: user.email || '', updatedAt: Date.now() });
      }

      inSync = true; await saveState();
      localStorage.setItem(SYNC_KEY, String(Date.now()));
      message = result.skipped.length ? `同期しました（容量が大きすぎて${result.skipped.length}件は保存できませんでした）` : '同期しました';
      return result;
    } catch(e){
      console.error(e); message = '同期に失敗しました：' + (e && e.message ? e.message : e);
      throw e;
    } finally { busy = false; inSync = false; emit(); }
  }

  // 保存のたびに、少し待ってから自動で同期する（ログイン中のみ）
  function scheduleSync(){
    if(!user || !remote || inSync) return;
    clearTimeout(timer); timer = setTimeout(()=>{ syncNow().catch(()=>{}); }, 3000);
  }

  /* ---------------------------------------------------------
     Firebase の準備・ログイン
  --------------------------------------------------------- */
  async function init(){
    if(fb) return fb;
    if(!config()) throw new Error('Firebase の設定がありません（firebase-config.js）');
    const [appM, authM, fsM] = await Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')
    ]);
    const app = appM.initializeApp(config());
    fb = { app, authM, fsM, auth: authM.getAuth(app), db: fsM.getFirestore(app) };
    return fb;
  }
  function firestoreRemote(uid){
    const { db, fsM } = fb;
    const trips = fsM.collection(db, 'users', uid, 'trips');
    return {
      async listTrips(){
        const snap = await fsM.getDocs(trips);
        return snap.docs.map(d=>{ const v = d.data(); return { id: d.id, updatedAt: v.updatedAt || 0, deleted: !!v.deleted, json: v.json || '' }; });
      },
      async putTrip(id, v){ await fsM.setDoc(fsM.doc(db, 'users', uid, 'trips', id), v); },
      async getProfile(){ const s = await fsM.getDoc(fsM.doc(db, 'users', uid)); return s.exists() ? s.data() : null; },
      async putProfile(v){ await fsM.setDoc(fsM.doc(db, 'users', uid), v, { merge: true }); }
    };
  }
  const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');

  // Firebase のエラーを、原因と対処が分かる日本語にする（コードも末尾に表示して、原因を特定しやすくする）
  function explainError(e){
    const code = (e && e.code) || '';
    const tail = code ? `（${code}）` : '';
    const map = {
      'auth/invalid-action-code': 'このログインリンクは、期限切れか、すでに使われています。もう一度「ログインリンクを送る」を押して、届いた新しいメールのリンクを開いてください。メールを開いたときにセキュリティ機能がリンクを先に開いてしまう場合は、リンクを長押し（右クリック）してコピーし、ブラウザのアドレス欄に貼り付けて開いてください。',
      'auth/expired-action-code': 'このログインリンクは期限切れです。もう一度「ログインリンクを送る」を押してください。',
      'auth/invalid-email': 'メールアドレスが、リンクを送ったアドレスと一致しません。リンクを送ったときと同じアドレスを入力してください。',
      'auth/network-request-failed': '通信に失敗しました。ネットワークを確認して、もう一度お試しください。',
      'auth/unauthorized-continue-uri': 'このサイトのドメインが Firebase の「承認済みドメイン」に登録されていません（Authentication → 設定 → 承認済みドメイン）。',
      'auth/unauthorized-domain': 'このサイトのドメインが Firebase の「承認済みドメイン」に登録されていません（Authentication → 設定 → 承認済みドメイン）。',
      'auth/operation-not-allowed': 'Firebase 側で「メールリンク」のログイン方法が有効になっていません（Authentication → Sign-in method）。',
      'auth/quota-exceeded': 'メールの送信回数の上限に達しました。しばらく待つか、明日もう一度お試しください。',
      'auth/too-many-requests': '短時間に試行しすぎました。しばらく待ってから、もう一度お試しください。',
      'auth/user-disabled': 'このアカウントは無効になっています。',
      'permission-denied': 'データの保存が許可されていません。Firestore のルールの設定（CLOUD_SETUP.md の手順3）を確認してください。'
    };
    return (map[code] || ('ログインできませんでした：' + (e && e.message ? e.message : e))) + (map[code] ? tail : '');
  }

  async function sendLoginLink(email){
    email = (email || '').trim();
    if(!validEmail(email)) throw new Error('メールアドレスの形式が正しくありません');
    try{
      await init();
      const url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'index.html';
      await fb.authM.sendSignInLinkToEmail(fb.auth, email, { url, handleCodeInApp: true });
    }catch(e){ console.error(e); throw new Error(explainError(e)); }
    localStorage.setItem(EMAIL_KEY, email);
    setMessage(`${email} にログイン用のリンクを送りました。届くまで数分かかることがあります（届かないときは迷惑メールも確認してください）。リンクは、このブラウザで開くのがいちばん確実です。別の端末やメールアプリ内で開いた場合は、メールアドレスの入力を求められます。`);
  }
  async function logout(){
    if(fb) await fb.authM.signOut(fb.auth);
    user = null; if(fb) remote = null;
    message = 'ログアウトしました'; emit();
  }

  // ページを開いたときの開始処理（メールのリンクから戻ってきた場合のログイン完了／ログイン状態の復元）
  // メールのリンクからログインを完了する（メールアドレスの確認つき）
  async function completeLink(email){
    email = (email || '').trim();
    if(!validEmail(email)){ setMessage('メールアドレスの形式が正しくありません'); return; }
    try{
      await init();
      await fb.authM.signInWithEmailLink(fb.auth, email, location.href);
      localStorage.removeItem(EMAIL_KEY);
      history.replaceState(null, '', location.pathname);              // URLに残った認証用の文字列を消す
      pendingLink = false;
      setMessage('ログインしました');
    }catch(e){
      console.error(e);
      if(e && e.code !== 'auth/invalid-email'){                        // アドレスの打ち間違い以外は、このリンクではもうログインできない
        pendingLink = false;
        try{ history.replaceState(null, '', location.pathname); }catch(_){}
      }
      setMessage(explainError(e));
    }
  }

  // ページを開いたときの開始処理（メールのリンクから戻ってきた場合のログイン完了／ログイン状態の復元）
  async function start(onChange){
    if(onChange) listeners.push(onChange);
    if(started) return; started = true;
    window.__afterSave = scheduleSync;
    if(!config()){ ready = true; emit(); return; }
    try{
      await init();
      const { authM, auth } = fb;
      authM.onAuthStateChanged(auth, async (u)=>{
        user = u || null; remote = u ? firestoreRemote(u.uid) : null; ready = true; emit();
        if(u) syncNow().catch(()=>{});                                  // ログインできたら、すぐに同期する
      });
      if(authM.isSignInWithEmailLink(auth, location.href)){
        const email = localStorage.getItem(EMAIL_KEY);
        if(email) await completeLink(email);
        else { pendingLink = true; ready = true; emit(); }              // 別の端末・アプリ内ブラウザで開いた: 画面でメールアドレスを確認する
      }
    }catch(e){ console.error(e); ready = true; message = explainError(e); emit(); }
  }

  /* ---------------------------------------------------------
     画面（index.html の旅行一覧に表示するカード）
  --------------------------------------------------------- */
  function renderCard(){
    const msg = message ? `<p class="muted" id="cloud-msg" style="margin-top:10px;">${escapeHtml(message)}</p>` : '<p class="muted" id="cloud-msg"></p>';
    const head = (tag)=> `<div class="section-title"><h2>アカウント・クラウド同期</h2><span class="muted">${tag}</span></div>`;
    if(!configured()) return `
    <div class="card" id="cloud-card">${head('未設定')}
      <p class="muted">メールアドレスでログインして、旅行データを別の端末でも使えるようにする機能です。使うには Firebase の設定が必要です（手順は <b>CLOUD_SETUP.md</b> を参照）。設定するまでは、これまでどおりこの端末だけで動作します。</p>
    </div>`;
    if(!ready) return `<div class="card" id="cloud-card">${head('確認中…')}<p class="muted">ログイン状態を確認しています。</p></div>`;
    if(!user && pendingLink) return `
    <div class="card" id="cloud-card">${head('メールアドレスの確認')}
      <p>ログイン用のリンクから開きました。確認のため、<b>リンクを送ったときのメールアドレス</b>を入力してください（別の端末やメールアプリ内で開いたときに必要です）。</p>
      <div class="field"><label for="cloud-email-confirm">メールアドレス</label>
        <input type="email" id="cloud-email-confirm" autocomplete="email" placeholder="例）you@example.com"></div>
      <div class="btn-row"><button class="btn accent" id="btn-cloud-complete">ログインを完了する</button></div>
      ${msg}
    </div>`;
    if(!user) return `
    <div class="card" id="cloud-card">${head('未ログイン')}
      <p class="muted">メールアドレスを入力すると、ログイン用のリンクが届きます（パスワードは不要です）。ログインすると、旅行データが別の端末とも同期されます。</p>
      <div class="field"><label for="cloud-email">メールアドレス</label>
        <input type="email" id="cloud-email" autocomplete="email" placeholder="例）you@example.com" value="${escapeHtml(localStorage.getItem(EMAIL_KEY) || '')}"></div>
      <div class="btn-row"><button class="btn accent" id="btn-cloud-login" ${busy ? 'disabled' : ''}>ログインリンクを送る</button></div>
      ${msg}
    </div>`;
    const last = Number(localStorage.getItem(SYNC_KEY) || 0);
    return `
    <div class="card" id="cloud-card">${head('ログイン中')}
      <p>${escapeHtml(user.email || '')} でログインしています。</p>
      <p class="muted">最後の同期：${last ? new Date(last).toLocaleString('ja-JP') : 'まだ同期していません'}　／　保存のたびに自動で同期します（レシート画像は同期されません）。</p>
      <div class="btn-row">
        <button class="btn secondary" id="btn-cloud-sync" ${busy ? 'disabled' : ''}>${busy ? '同期中…' : '今すぐ同期'}</button>
        <button class="btn ghost" id="btn-cloud-logout">ログアウト</button>
      </div>
      ${msg}
    </div>`;
  }
  function bindCard(){
    const login = document.getElementById('btn-cloud-login');
    if(login) login.onclick = async ()=>{
      try{ await sendLoginLink(document.getElementById('cloud-email').value); }
      catch(e){ setMessage(e && e.message ? e.message : String(e)); }
    };
    const complete = document.getElementById('btn-cloud-complete');
    if(complete) complete.onclick = ()=> completeLink(document.getElementById('cloud-email-confirm').value);
    const sync = document.getElementById('btn-cloud-sync');
    if(sync) sync.onclick = ()=> syncNow().then(r=>{ if(r) showToast(`同期しました（送信${r.up}件・受信${r.down}件）`); }).catch(()=>{});
    const out = document.getElementById('btn-cloud-logout');
    if(out) out.onclick = ()=> logout();
  }

  return {
    start, renderCard, bindCard, syncNow, sendLoginLink, logout, planSync, configured, completeLink, explainError,
    get user(){ return user; }, get busy(){ return busy; },
    // テスト用: Firebase を使わずに、任意の保存先とユーザーを差し込む
    _useRemote(r, u){ remote = r; user = u; ready = true; emit(); },
    _setFb(x){ fb = x; },
    _resetStart(){ started = false; pendingLink = false; },
    get pendingLink(){ return pendingLink; }
  };
})();
