/**
 * toio & Switch Controller コネクター
 * ----------------------------------------------------
 * Web Bluetooth API を用いて toio コア キューブを制御し、
 * Web Gamepad API を用いて Nintendo Switch コントローラーの入力を反映させます。
 * さらに toio のIDセンサー情報を読み取り、角度や簡易カードマークを可視化します。
 * 自律動作としての「ランダムデモ走行モード」に加え、
 * マットやカードに侵入した際に操作が一時的に狂う「操作シャッフルギミック」も搭載。
 */

// ==========================================================================
// BLE UUID定義 (toio仕様準拠)
// ==========================================================================
const TOIO_SERVICE_UUID = '10b20100-5b3b-4571-9508-cf3efcd7bbae';
const ID_CHAR_UUID      = '10b20101-5b3b-4571-9508-cf3efcd7bbae'; // IDリーダー
const MOTOR_CHAR_UUID   = '10b20102-5b3b-4571-9508-cf3efcd7bbae';
const LED_CHAR_UUID     = '10b20103-5b3b-4571-9508-cf3efcd7bbae';
const SOUND_CHAR_UUID   = '10b20104-5b3b-4571-9508-cf3efcd7bbae';

// ==========================================================================
// 簡易プレイマット・カード用 Standard ID 変換辞書
// ==========================================================================
const STANDARD_ID_MAP = {
  3670320: '0', 3670321: '1', 3670322: '2', 3670323: '3', 3670324: '4',
  3670325: '5', 3670326: '6', 3670327: '7', 3670328: '8', 3670329: '9',
  3670337: 'A', 3670338: 'B', 3670339: 'C', 3670340: 'D', 3670341: 'E',
  3670342: 'F', 3670343: 'G', 3670344: 'H', 3670345: 'I', 3670346: 'J',
  3670347: 'K', 3670348: 'L', 3670349: 'M', 3670350: 'N', 3670351: 'O',
  3670352: 'P', 3670353: 'Q', 3670354: 'R', 3670355: 'S', 3670356: 'T',
  3670357: 'U', 3670358: 'V', 3670359: 'W', 3670360: 'X', 3670361: 'Y',
  3670362: 'Z', 3670305: '!', 3670366: '↑', 3670335: '?', 3670315: '+',
  3670317: '−', 3670333: '=', 3670332: '←', 3670367: '↓', 3670334: '→',
  3670314: '×', 3670319: '÷', 3670309: '%'
};

// ==========================================================================
// 状態管理変数
// ==========================================================================
let toioDevice = null;
let idCharacteristic = null;
let motorCharacteristic = null;
let ledCharacteristic = null;
let soundCharacteristic = null;
let isConnectedToio = false;

// 位置情報管理
let currentAngle = null;
let isToioOnMat = false; // マットまたはカードの上にいるフラグ

// ゲームパッド関連
let activeGamepadIndex = null;
let gamepadAnimationId = null;
let prevButtonsState = {}; // ボタンのトグル監視用

// 自律ランダム走行関連
let isRandomDriving = false;
let randomDriveTimer = null;

// 自律走行の動作マッピング (前後・左右スピン・一時停止)
const RANDOM_DIRECTIONS = [
  { id: 'n',  name: '前進',   leftSpeed: 65, leftDir: 1, rightSpeed: 65, rightDir: 1 },
  { id: 's',  name: '後退',   leftSpeed: 65, leftDir: 2, rightSpeed: 65, rightDir: 2 },
  { id: 'e',  name: '右回転', leftSpeed: 55, leftDir: 1, rightSpeed: 55, rightDir: 2 },
  { id: 'w',  name: '左回転', leftSpeed: 55, leftDir: 2, rightSpeed: 55, rightDir: 1 },
  { id: 'center', name: '一時停止', leftSpeed: 0, leftDir: 1, rightSpeed: 0, rightDir: 1 }
];

// 操作シャッフルギミック関連
let isShuffleEnabled = true;       // ギミック自体が有効か（常時有効）
let isShuffledActive = false;      // 実際に今シャッフル状態か
let isShuffleCooldown = false;     // クールダウン中か
const SHUFFLE_DURATION_MS = 10000; // 操作が狂う時間 (10秒)
let cooldownTimer = null;          // 自動復旧用タイマー
let currentMapping = { n: 'n', s: 's', e: 'e', w: 'w' }; // 通常のマッピング

// プレイヤー情報
let playerName = localStorage.getItem('toio_player_name') || 'プレイヤー1';
let taBestPlayer = localStorage.getItem('toio_ta_best_player') || '';
let activePlayerName = ''; // タイムアタック開始時に確定したプレイヤー名

let taRanking = []; // ランキング配列
try {
  const savedRanking = localStorage.getItem('toio_ta_ranking');
  taRanking = savedRanking ? JSON.parse(savedRanking) : [];
  if (!Array.isArray(taRanking)) {
    taRanking = [];
  }
} catch (e) {
  taRanking = [];
}

// タイムアタック関連変数
let taState = 'idle'; // 'idle' | 'ready' | 'countdown' | 'running' | 'finished'
let taStartTime = 0;
let taElapsedTime = 0;
let taTimerInterval = null;
let taCountdownTimer = null;
let taCountdownVal = 3;
let taBestTime = localStorage.getItem('toio_ta_best') !== null ? parseFloat(localStorage.getItem('toio_ta_best')) : null;
let taLaps = [];                         // ラップタイム配列
let hasTriggeredExclamationTrap = false; // 「!」トラップ発動済みフラグ
let hasTriggeredQuestionTrap = false;    // 「?」トラップ発動済みフラグ
let lastDetectedCard = null;             // 直前に検出したカードマーク

// 送信制御（スロットリング＆変更検知）
let lastLeftSpeed = 0;
let lastLeftDir = 1;
let lastRightSpeed = 0;
let lastRightDir = 1;
let lastSentTime = 0;
const SEND_INTERVAL_MS = 60; // 送信間隔 (BLEの詰まりを防止)

// キーボード制御状態 (フォールバック用)
const keysPressed = {
  w: false, s: false, a: false, d: false,
  ArrowUp: false, ArrowDown: false, ArrowLeft: false, ArrowRight: false
};

// ==========================================================================
// DOM要素の取得
// ==========================================================================
const btnConnectToio = document.getElementById('btn-connect-toio');
const toioStatusIndicator = document.getElementById('toio-status-indicator');
const toioStatusText = document.getElementById('toio-status-text');
const toioControls = document.getElementById('toio-controls');

const padStatusIndicator = document.getElementById('pad-status-indicator');
const padStatusText = document.getElementById('pad-status-text');
const padPlaceholder = document.getElementById('pad-placeholder');
const padDetails = document.getElementById('pad-details');
const padName = document.getElementById('pad-name');

const leftStick = document.getElementById('left-stick');
const leftAxisVal = document.getElementById('left-axis-val');

const ledPicker = document.getElementById('led-picker');
const logBox = document.getElementById('log-box');
const btnClearLogs = document.getElementById('btn-clear-logs');
const guideToggle = document.getElementById('guide-toggle');
const guideContent = document.getElementById('guide-content');

// センサー情報表示用DOM
const coordAngle = document.getElementById('coord-angle');
const detectedCard = document.getElementById('detected-card');
const coordStatusText = document.getElementById('coord-status-text');

// ランダム走行用DOM
const btnRandomStart = document.getElementById('btn-random-start');
const btnRandomStop = document.getElementById('btn-random-stop');

const directionElements = {
  'n': document.getElementById('dir-n'),
  'w': document.getElementById('dir-w'),
  'center': document.getElementById('dir-center'),
  'e': document.getElementById('dir-e'),
  's': document.getElementById('dir-s')
};

// 操作シャッフル用DOM
const shuffleStatusPanel = document.getElementById('shuffle-status-panel');
const shuffleStatusText = document.getElementById('shuffle-status-text');
const shuffleIcon = document.getElementById('shuffle-icon');

// タイムアタック用DOM
const taStatus = document.getElementById('ta-status');
const taTimer = document.getElementById('ta-timer');
const taBest = document.getElementById('ta-best');
const taBestPlayerDisplay = document.getElementById('ta-best-player');
const playerNameInput = document.getElementById('player-name-input');
const playerNameError = document.getElementById('player-name-error');
const taLapsList = document.getElementById('ta-laps-list');
const taRankingList = document.getElementById('ta-ranking-list');
const btnResetBest = document.getElementById('btn-reset-best');
const btnResetRanking = document.getElementById('btn-reset-ranking');
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownNumber = document.getElementById('countdown-number');
const resultOverlay = document.getElementById('result-overlay');
const resultTimeVal = document.getElementById('result-time-val');
const resultRecordMsg = document.getElementById('result-record-msg');
const btnCloseResult = document.getElementById('btn-close-result');

// ==========================================================================
// ログ出力用ユーティリティ
// ==========================================================================
function addLog(message, type = 'info') {
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${message}`;
  
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;
}

// ==========================================================================
// toio (Web Bluetooth) 制御ロジック
// ==========================================================================
btnConnectToio.addEventListener('click', async () => {
  if (isConnectedToio) {
    disconnectToio();
    return;
  }
  await connectToio();
});

async function connectToio() {
  addLog("toioのBluetoothスキャンを開始します...", "system");
  try {
    toioDevice = await navigator.bluetooth.requestDevice({
      filters: [{ services: [TOIO_SERVICE_UUID] }]
    });

    addLog(`デバイスが選択されました: ${toioDevice.name}`, "system");
    
    toioDevice.addEventListener('gattserverdisconnected', onToioDisconnected);

    addLog("GATTサーバーに接続中...", "system");
    const server = await toioDevice.gatt.connect();

    addLog("プライマリサービスを取得中...", "system");
    const service = await server.getPrimaryService(TOIO_SERVICE_UUID);

    addLog("キャラクタリスティックを取得中...", "system");
    idCharacteristic = await service.getCharacteristic(ID_CHAR_UUID);
    motorCharacteristic = await service.getCharacteristic(MOTOR_CHAR_UUID);
    ledCharacteristic = await service.getCharacteristic(LED_CHAR_UUID);
    soundCharacteristic = await service.getCharacteristic(SOUND_CHAR_UUID);

    addLog("IDセンサー通知登録中...", "system");
    await idCharacteristic.startNotifications();
    idCharacteristic.addEventListener('characteristicvaluechanged', handleIdNotification);

    isConnectedToio = true;
    updateToioUI(true);
    addLog("toioコアキューブに正常に接続しました！", "success");

    await playSound(2);
    const defaultColor = hexToRgb(ledPicker.value);
    await setLED(defaultColor.r, defaultColor.g, defaultColor.b);

  } catch (error) {
    addLog(`接続に失敗しました: ${error.message}`, "error");
    console.error("Bluetooth connection failed:", error);
    disconnectToio();
  }
}

function disconnectToio() {
  if (toioDevice && toioDevice.gatt.connected) {
    addLog("GATT接続を切断します...", "system");
    toioDevice.gatt.disconnect();
  } else {
    onToioDisconnected();
  }
}

function onToioDisconnected() {
  stopRandomDrive();
  stopShuffleGimmick();
  
  isConnectedToio = false;
  toioDevice = null;
  idCharacteristic = null;
  motorCharacteristic = null;
  ledCharacteristic = null;
  soundCharacteristic = null;
  
  isToioOnMat = false;
  currentAngle = null;
  
  updateToioUI(false);
  updateCoordinatesUI(null, null, false);
  addLog("toioコアキューブとの接続が解除されました。", "error");
}

function updateToioUI(connected) {
  if (connected) {
    toioStatusIndicator.classList.add('connected');
    toioStatusText.textContent = "接続済み";
    toioStatusText.style.color = "var(--neon-green)";
    btnConnectToio.innerHTML = '<i data-lucide="x-square"></i> toio から切断する';
    btnConnectToio.style.background = 'linear-gradient(135deg, var(--neon-red), #d60047)';
    btnConnectToio.style.boxShadow = '0 4px 15px var(--shadow-red)';
    toioControls.classList.remove('disabled-until-connected');
  } else {
    toioStatusIndicator.classList.remove('connected');
    toioStatusText.textContent = "未接続";
    toioStatusText.style.color = "var(--neon-red)";
    btnConnectToio.innerHTML = '<i data-lucide="bluetooth"></i> toio に接続する';
    btnConnectToio.style.background = 'linear-gradient(135deg, var(--neon-blue), #0099b8)';
    btnConnectToio.style.boxShadow = '0 4px 15px var(--shadow-blue)';
    toioControls.classList.add('disabled-until-connected');
  }
  lucide.createIcons();
}

// ==========================================================================
// IDリーダー センサー値の通知処理 (標準ID・簡易カード対応)
// ==========================================================================
function handleIdNotification(event) {
  const data = event.target.value;
  if (data.byteLength < 1) return;

  const infoType = data.getUint8(0);

  if (infoType === 0x01) {
    // 1) Position ID (マットの上に乗っている状態)
    if (data.byteLength < 7) return;

    const angle = data.getUint16(5, true);
    currentAngle = angle;
    isToioOnMat = true;

    // トラップ発動判定
    if (isShuffleEnabled && !isShuffleCooldown) {
      triggerShuffleGimmick("マット侵入");
    }

    updateCoordinatesUI(angle, null, true);
  } 
  else if (infoType === 0x02) {
    // 2) Standard ID (簡易カードの上に乗っている状態)
    if (data.byteLength < 7) return;

    const standardId = data.getUint32(1, true); // リトルエンディアン UInt32
    const angle = data.getUint16(5, true);      // リトルエンディアン UInt16

    const cardMark = STANDARD_ID_MAP[standardId] || '不明';
    currentAngle = angle;
    isToioOnMat = true;

    // デバッグログ：カード検出時に1度だけ出力
    if (cardMark !== lastDetectedCard && lastDetectedCard !== `${cardMark}_warned`) {
      addLog(`カード検出: [${cardMark}] (ID: ${standardId})`, "system");
      lastDetectedCard = cardMark;
    }

    // タイムアタック：スタートカード（→）、ゴールカード（1）、リトライカード（0）の検知処理
    if (cardMark === '→') {
      if (taState === 'idle' || taState === 'finished') {
        setupTimeAttack();
      } else {
        // スタートカード検知警告：カウントダウン中や走行中など、本当にスタックしている時のみ明示
        if (taState === 'countdown' || taState === 'running') {
          if (lastDetectedCard === '→') {
            lastDetectedCard = '→_warned'; // 一時的に別マークにして警告の連発を防ぐ
            addLog(`⚠️ スタート位置 [→] を検出しましたが、現在のタイムアタック状態 [${taState}] では初期設定できません。「0」カードに置いてリセットしてください。`, "error");
          }
        }
      }
    } else if (cardMark === '1' && taState === 'running') {
      finishTimeAttack();
    } else if (cardMark === '0') {
      resetTimeAttackToIdle();
    }

    // トラップ発動判定（! と ? のカードを踏んだときのみ操作シャッフルを発動、1挑戦に各1回限り）
    if (isShuffleEnabled) {
      if (cardMark === '!' && !hasTriggeredExclamationTrap) {
        hasTriggeredExclamationTrap = true;
        triggerShuffleGimmick("⚠️ 罠 [!] 検知");

        // タイムアタック中ならラップタイム記録
        if (taState === 'running') {
          const lapTime = performance.now() - taStartTime;
          taLaps.push({ card: '!', time: lapTime });
          updateLapsUI();
          addLog(`⏱️ ラップ記録 [!] : ${formatTime(lapTime)}`, "success");
        }
      } else if (cardMark === '?' && !hasTriggeredQuestionTrap) {
        hasTriggeredQuestionTrap = true;
        triggerShuffleGimmick("⚠️ 罠 [?] 検知");

        // タイムアタック中ならラップタイム記録
        if (taState === 'running') {
          const lapTime = performance.now() - taStartTime;
          taLaps.push({ card: '?', time: lapTime });
          updateLapsUI();
          addLog(`⏱️ ラップ記録 [?] : ${formatTime(lapTime)}`, "success");
        }
      }
    }

    updateCoordinatesUI(angle, cardMark, true);
  }
  else if (infoType === 0x03 || infoType === 0x04) {
    // 3) Position ID / Standard ID Missed (マットやカードから離れた状態)
    const wasOnMat = isToioOnMat;
    isToioOnMat = false;
    lastDetectedCard = null; // 離脱時に検出カード履歴をリセット
    
    // 自律走行中にマット/カードから落ちた場合は安全のため緊急停止
    if (isRandomDriving && wasOnMat) {
      addLog("マット外への脱落を検知したため、自動走行を緊急停止しました。", "error");
      stopRandomDrive();
    }



    updateCoordinatesUI(null, null, false);
  }
}

/**
 * 簡易センサー情報UIの更新
 */
function updateCoordinatesUI(angle, cardMark, isOnMat) {
  if (isOnMat) {
    coordAngle.textContent = angle !== null ? `${angle}°` : "---";
    detectedCard.textContent = cardMark !== null ? cardMark : "---";
    coordStatusText.textContent = cardMark !== null ? "カード検出中" : "マット内";
    coordStatusText.className = "status-val on-mat";
  } else {
    coordAngle.textContent = "---";
    detectedCard.textContent = "---";
    coordStatusText.textContent = "マット外";
    coordStatusText.className = "status-val off-mat";
  }
}

// ==========================================================================
// 操作シャッフル (パニックトラップ) クールダウンタイマー制御
// ==========================================================================
// ==========================================================================
// ==========================================================================
// プレイヤー名入力イベント
// ==========================================================================
playerNameInput.addEventListener('input', (e) => {
  playerName = e.target.value.trim() || 'プレイヤー1';
  localStorage.setItem('toio_player_name', playerName);
  checkPlayerNameDuplicate();
});

/**
 * プレイヤー名重複チェック
 */
function checkPlayerNameDuplicate() {
  const name = playerNameInput.value.trim();
  if (!name) return false;

  const isDuplicate = taRanking.some(item => item.name.toLowerCase() === name.toLowerCase());
  
  if (isDuplicate) {
    playerNameError.classList.remove('hidden');
    playerNameInput.classList.add('input-error');
  } else {
    playerNameError.classList.add('hidden');
    playerNameInput.classList.remove('input-error');
  }

  // READYの時のみ、リアルタイムでタイムアタックステータスのUI表示を連動して更新
  if (taState === 'ready') {
    updateTaUI();
  }
  
  return isDuplicate;
}

/**
 * ランキング（リーダーボード）UIの更新
 */
function updateRankingUI() {
  taRankingList.innerHTML = '';
  if (taRanking.length === 0) {
    const li = document.createElement('li');
    li.className = 'ranking-empty';
    li.textContent = '記録がありません';
    taRankingList.appendChild(li);
    return;
  }

  taRanking.forEach((item, idx) => {
    const li = document.createElement('li');
    li.className = `ranking-item rank-${idx + 1}`;
    
    const infoDiv = document.createElement('div');
    infoDiv.className = 'rank-info';
    
    const numSpan = document.createElement('span');
    numSpan.className = 'rank-num';
    numSpan.textContent = `#${idx + 1}`;
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'rank-name';
    nameSpan.textContent = item.name;
    
    infoDiv.appendChild(numSpan);
    infoDiv.appendChild(nameSpan);
    
    const timeDateDiv = document.createElement('div');
    timeDateDiv.className = 'rank-time-date';
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'rank-time';
    timeSpan.textContent = formatTime(item.time);
    
    const dateSpan = document.createElement('span');
    dateSpan.className = 'rank-date';
    dateSpan.textContent = item.date;
    
    timeDateDiv.appendChild(timeSpan);
    timeDateDiv.appendChild(dateSpan);
    
    li.appendChild(infoDiv);
    li.appendChild(timeDateDiv);
    taRankingList.appendChild(li);
  });
}

/**
 * ラップタイム表示UIの更新
 */
function updateLapsUI() {
  taLapsList.innerHTML = '';
  if (taLaps.length === 0) {
    const li = document.createElement('li');
    li.className = 'lap-empty';
    li.textContent = 'ラップタイムはありません';
    taLapsList.appendChild(li);
    return;
  }
  taLaps.forEach((lap, idx) => {
    const li = document.createElement('li');
    li.className = `lap-item ${lap.card === '!' ? 'lap-warn' : ''}`;
    
    const labelSpan = document.createElement('span');
    labelSpan.className = 'lap-label';
    labelSpan.textContent = `LAP ${idx + 1} (${lap.card})`;
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'lap-time';
    timeSpan.textContent = formatTime(lap.time);
    
    li.appendChild(labelSpan);
    li.appendChild(timeSpan);
    taLapsList.appendChild(li);
  });
}

/**
 * トラップ起動処理 (4秒間シャッフル発動 ➡ 自動通常復帰 & クールダウン)
 */
function triggerShuffleGimmick(source) {
  isShuffleCooldown = true; 
  isShuffledActive = true;
  
  shuffleMapping();
  updateShuffleUI(true);

  const durationSec = SHUFFLE_DURATION_MS / 1000;
  addLog(`⚠️【トラップ発動】${source}を検知！${durationSec}秒間操作がシャッフルされます！`, "error");
  playSound(1); 
  setLED(255, 0, 0, 50); 

  if (cooldownTimer) clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    isShuffleCooldown = false; 
    isShuffledActive = false;
    resetMapping(); 
    updateShuffleUI(false);
    
    addLog("【自動復旧】操作が通常に戻りました。再度マットやカードに乗るとシャッフルされます。", "success");
    playSound(2); 
    setLED(0, 195, 227, 50); 
  }, SHUFFLE_DURATION_MS);
}

function shuffleMapping() {
  const inputs = ['n', 's', 'e', 'w'];
  const outputs = [...inputs];
  
  for (let i = outputs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [outputs[i], outputs[j]] = [outputs[j], outputs[i]];
  }

  currentMapping = {
    n: outputs[0],
    s: outputs[1],
    e: outputs[2],
    w: outputs[3]
  };

  addLog(`シャッフル割当: [前進⇒${getDirJapaneseName(outputs[0])}] [後退⇒${getDirJapaneseName(outputs[1])}] [右回⇒${getDirJapaneseName(outputs[2])}] [左回⇒${getDirJapaneseName(outputs[3])}]`, "controller");
}

function resetMapping() {
  currentMapping = { n: 'n', s: 's', e: 'e', w: 'w' };
}

function stopShuffleGimmick() {
  if (cooldownTimer) {
    clearTimeout(cooldownTimer);
    cooldownTimer = null;
  }
  isShuffleCooldown = false;
  isShuffledActive = false;
  resetMapping();
  updateShuffleUI(false);
}

function updateShuffleUI(shuffled) {
  if (shuffled) {
    shuffleStatusPanel.className = 'shuffle-status-panel shuffled';
    shuffleStatusText.textContent = '⚠️ 操作シャッフル発動中！';
    shuffleIcon.setAttribute('data-lucide', 'alert-triangle');
  } else {
    shuffleStatusPanel.className = 'shuffle-status-panel normal';
    shuffleStatusText.textContent = '通常操作モード';
    shuffleIcon.setAttribute('data-lucide', 'shield-check');
  }
  lucide.createIcons();
}

function getDirJapaneseName(id) {
  if (id === 'n') return '前進';
  if (id === 's') return '後退';
  if (id === 'e') return '右回転';
  if (id === 'w') return '左回転';
  return id;
}

// ==========================================================================
// ランダム8方向走行ロジック (自律走行)
// ==========================================================================
btnRandomStart.addEventListener('click', () => {
  startRandomDrive();
});

btnRandomStop.addEventListener('click', () => {
  addLog("自動走行を停止しました。", "system");
  stopRandomDrive();
});

function startRandomDrive() {
  if (!isConnectedToio) return;
  if (isRandomDriving) return;

  // 自律走行開始時はシャッフル状態（発動中のタイマーなど）を一旦リセット
  stopShuffleGimmick();

  isRandomDriving = true;
  btnRandomStart.disabled = true;
  btnRandomStop.disabled = false;
  
  addLog("ランダム8方向自動走行を開始しました。(操縦入力で自動停止)", "success");
  
  setLED(57, 255, 20);
  playSound(3);
  
  tickRandomDrive();
}

function stopRandomDrive(reason = null) {
  if (!isRandomDriving) return;

  isRandomDriving = false;
  btnRandomStart.disabled = false;
  btnRandomStop.disabled = true;

  if (randomDriveTimer) {
    clearTimeout(randomDriveTimer);
    randomDriveTimer = null;
  }

  clearActiveDirectionUI();
  controlMotors(0, 1, 0, 1);

  if (reason) {
    addLog(`【割り込み】${reason}を検知したため、自動走行を解除しました。`, "system");
    playSound(1);
  }
}

function clearActiveDirectionUI() {
  Object.keys(directionElements).forEach(key => {
    directionElements[key].classList.remove('active');
  });
}

function tickRandomDrive() {
  if (!isRandomDriving || !isConnectedToio) return;

  if (!isToioOnMat) {
    clearActiveDirectionUI();
    directionElements['center'].classList.add('active');
    controlMotors(0, 1, 0, 1);
  } else {
    const nextDir = RANDOM_DIRECTIONS[Math.floor(Math.random() * RANDOM_DIRECTIONS.length)];
    
    clearActiveDirectionUI();
    if (directionElements[nextDir.id]) {
      directionElements[nextDir.id].classList.add('active');
    }
    
    addLog(`自動走行 - 動作変更: ${nextDir.name}`, "system");
    
    controlMotors(nextDir.leftSpeed, nextDir.leftDir, nextDir.rightSpeed, nextDir.rightDir);
    
    if (nextDir.id !== 'center') {
      const r = Math.floor(Math.random() * 256);
      const g = Math.floor(Math.random() * 256);
      const b = Math.floor(Math.random() * 256);
      setLED(r, g, b);
    } else {
      setLED(255, 0, 0);
    }
  }

  const nextDuration = 1000 + Math.random() * 1200;
  randomDriveTimer = setTimeout(tickRandomDrive, nextDuration);
}

// ==========================================================================
// モーターの制御コマンドを送信 (スロットリング & 変更検知)
// ==========================================================================
async function controlMotors(leftSpeed, leftDir, rightSpeed, rightDir) {
  if (!motorCharacteristic || !isConnectedToio) return;

  const now = performance.now();
  
  const isDuplicate = (
    leftSpeed === lastLeftSpeed &&
    leftDir === lastLeftDir &&
    rightSpeed === lastRightSpeed &&
    rightDir === lastRightDir
  );
  
  if (isDuplicate && (now - lastSentTime < SEND_INTERVAL_MS)) {
    return;
  }

  const data = new Uint8Array([
    0x01, // 制御タイプ: 時間指定なし
    0x01, // 左モーターID
    leftDir,
    leftSpeed,
    0x02, // 右モーターID
    rightDir,
    rightSpeed
  ]);

  try {
    await motorCharacteristic.writeValueWithoutResponse(data);
    
    lastLeftSpeed = leftSpeed;
    lastLeftDir = leftDir;
    lastRightSpeed = rightSpeed;
    lastRightDir = rightDir;
    lastSentTime = now;
  } catch (err) {
    console.warn("モーター送信エラー (再試行します):", err);
  }
}

/**
 * LED（インジケーター）制御
 */
async function setLED(r, g, b, duration = 0) {
  if (!ledCharacteristic || !isConnectedToio) return;
  
  const data = new Uint8Array([
    0x03,      // 制御タイプ: 時間指定点灯
    duration,  // 0: 無制限
    0x01,      // ランプの数 (1固定)
    0x01,      // ランプのID (1固定)
    r,
    g,
    b
  ]);

  try {
    await ledCharacteristic.writeValue(data);
  } catch (err) {
    addLog(`LEDコマンド送信エラー: ${err.message}`, "error");
  }
}

/**
 * サウンド（効果音）再生
 */
async function playSound(soundId, volume = 255) {
  if (!soundCharacteristic || !isConnectedToio) return;

  const data = new Uint8Array([
    0x02,     // 制御タイプ: 効果音再生
    soundId,  // 効果音ID (0-10)
    volume    // 音量 (0-255)
  ]);

  try {
    await soundCharacteristic.writeValue(data);
  } catch (err) {
    addLog(`サウンドコマンド送信エラー: ${err.message}`, "error");
  }
}

ledPicker.addEventListener('input', (e) => {
  if (isRandomDriving) stopRandomDrive("LED操作");
  const rgb = hexToRgb(e.target.value);
  setLED(rgb.r, rgb.g, rgb.b);
});

document.querySelectorAll('.color-preset').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (isRandomDriving) stopRandomDrive("プリセットカラー操作");
    const hex = e.target.dataset.color;
    ledPicker.value = hex;
    const rgb = hexToRgb(hex);
    setLED(rgb.r, rgb.g, rgb.b);
    addLog(`LEDカラーを変更しました: ${hex}`, "system");
  });
});

document.querySelectorAll('[data-sound]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    if (isRandomDriving) stopRandomDrive("効果音操作");
    const soundId = parseInt(e.currentTarget.dataset.sound, 10);
    playSound(soundId);
    addLog(`効果音を送信しました: ID ${soundId}`, "system");
  });
});

// ==========================================================================
// Web Gamepad API 制御ロジック
// ==========================================================================
window.addEventListener("gamepadconnected", (e) => {
  const gp = e.gamepad;
  addLog(`コントローラーを検出しました: ${gp.id}`, "success");
  
  if (activeGamepadIndex === null) {
    activeGamepadIndex = gp.index;
    showGamepadUI(gp);
    
    if (!gamepadAnimationId) {
      gamepadAnimationId = requestAnimationFrame(pollGamepadLoop);
    }
  }
});

window.addEventListener("gamepaddisconnected", (e) => {
  addLog(`コントローラーが切断されました: ${e.gamepad.id}`, "error");
  
  if (activeGamepadIndex === e.gamepad.index) {
    activeGamepadIndex = null;
    hideGamepadUI();
    
    if (gamepadAnimationId) {
      cancelAnimationFrame(gamepadAnimationId);
      gamepadAnimationId = null;
    }
    
    if (isConnectedToio) {
      controlMotors(0, 1, 0, 1);
    }
  }
});

function showGamepadUI(gp) {
  padStatusIndicator.classList.add('connected');
  padStatusText.textContent = "検出済み";
  padStatusText.style.color = "var(--neon-green)";
  
  padPlaceholder.classList.add('hidden');
  padDetails.classList.remove('hidden');
  padName.textContent = gp.id;
  
  addLog(`コントローラー "${gp.id.substring(0, 20)}..." で操作可能です。`, "controller");
}

function hideGamepadUI() {
  padStatusIndicator.classList.remove('connected');
  padStatusText.textContent = "コントローラー未検出";
  padStatusText.style.color = "var(--neon-red)";
  
  padPlaceholder.classList.remove('hidden');
  padDetails.classList.add('hidden');
}

function pollGamepadLoop() {
  if (activeGamepadIndex === null) return;
  
  const gamepads = navigator.getGamepads();
  const gp = gamepads[activeGamepadIndex];
  
  if (gp) {
    handleGamepadInput(gp);
  }
  
  gamepadAnimationId = requestAnimationFrame(pollGamepadLoop);
}

/**
 * コントローラーの入力を処理し、toioに反映 (シャffle適用)
 */
function handleGamepadInput(gp) {
  let axisX = gp.axes[0] || 0;
  let axisY = gp.axes[1] || 0;

  const DEADZONE = 0.15;
  let xValue = Math.abs(axisX) > DEADZONE ? axisX : 0;
  let yValue = Math.abs(axisY) > DEADZONE ? axisY : 0;

  updateVirtualStickUI(xValue, yValue);

  let btnA = gp.buttons[1]?.pressed || false;
  let btnB = gp.buttons[0]?.pressed || false;
  let btnX = gp.buttons[3]?.pressed || false;
  let btnY = gp.buttons[2]?.pressed || false;
  
  if (gp.buttons.length < 4) {
    btnA = gp.buttons[0]?.pressed || false;
    btnB = gp.buttons[1]?.pressed || false;
    btnX = false;
    btnY = false;
  }

  updateButtonNodesUI(btnA, btnB, btnX, btnY);

  // 全ボタンの押し下げ監視デバッグログ
  gp.buttons.forEach((btn, idx) => {
    const btnKey = `raw_btn_${idx}`;
    if (btn.pressed) {
      if (!prevButtonsState[btnKey]) {
        addLog(`🎮 コントローラー: ボタン ${idx} が押されました。`, "controller");
        prevButtonsState[btnKey] = true;
      }
    } else {
      prevButtonsState[btnKey] = false;
    }
  });

  detectButtonPress('A', btnA, () => {
    if (isRandomDriving) stopRandomDrive("コントローラー操作");
    addLog("[A] ボタンが押されました - 緑LED & 接続音", "controller");
    setLED(57, 255, 20);
    playSound(2);
  });
  detectButtonPress('B', btnB, () => {
    if (isRandomDriving) stopRandomDrive("コントローラー操作");
    addLog("[B] ボタンが押されました - 赤LED & ダメージ音", "controller");
    setLED(255, 0, 85);
    playSound(1);
  });
  detectButtonPress('X', btnX, () => {
    if (isRandomDriving) stopRandomDrive("コントローラー操作");
    addLog("[X] ボタンが押されました - 青LED & レベルアップ音", "controller");
    setLED(0, 195, 227);
    playSound(3);
  });
  detectButtonPress('Y', btnY, () => {
    if (isRandomDriving) stopRandomDrive("コントローラー操作");
    addLog("[Y] ボタンが押されました - 黄LED & コイン音", "controller");
    setLED(255, 230, 0);
    playSound(9);
  });

  // L/R または Joy-Con 単体時の SL/SR の同時押しによるスタート判定
  // 1) 通常L/R、またはJoy-Con単体のSL/SR (ボタン4と5)
  // 2) 通常ZL/ZR、または一部OSのJoy-Con単体SL/SR (ボタン6と7)
  // 3) 一部OSのJoy-Con単体SL/SRペア (ボタン14と15, または15と16)
  const isPair1 = gp.buttons[4]?.pressed && gp.buttons[5]?.pressed;
  const isPair2 = gp.buttons[6]?.pressed && gp.buttons[7]?.pressed;
  const isPair3 = gp.buttons[14]?.pressed && gp.buttons[15]?.pressed;
  const isPair4 = gp.buttons[15]?.pressed && gp.buttons[16]?.pressed;

  const isBumperSimultaneousPressed = isPair1 || isPair2 || isPair3 || isPair4;

  if (isBumperSimultaneousPressed && taState === 'ready') {
    startCountdown();
  }

  if (Math.abs(xValue) > 0 || Math.abs(yValue) > 0) {
    if (isRandomDriving) {
      stopRandomDrive("コントローラーのスティック操作");
    }
  }

  if (!isKeyboardControlling() && !isRandomDriving) {
    // タイムアタックでカウントダウン中、準備中（フライング防止）、またはゴール後（finished）は操縦入力をロック
    const isTaLocked = (taState === 'ready' || taState === 'countdown' || taState === 'finished');

    let leftSpeed = 0;
    let rightSpeed = 0;
    let leftDir = 1;
    let rightDir = 1;

    if (!isTaLocked) {
      const steerY = -yValue; 
      const steerX = xValue;  

      const in_n = Math.max(0, steerY);
      const in_s = Math.max(0, -steerY);
      const in_e = Math.max(0, steerX);
      const in_w = Math.max(0, -steerX);

      let act_n = 0, act_s = 0, act_e = 0, act_w = 0;
      
      if (currentMapping.n === 'n') act_n += in_n; else if (currentMapping.n === 's') act_s += in_n; else if (currentMapping.n === 'e') act_e += in_n; else if (currentMapping.n === 'w') act_w += in_n;
      if (currentMapping.s === 'n') act_n += in_s; else if (currentMapping.s === 's') act_s += in_s; else if (currentMapping.s === 'e') act_e += in_s; else if (currentMapping.s === 'w') act_w += in_s;
      if (currentMapping.e === 'n') act_n += in_e; else if (currentMapping.e === 's') act_s += in_e; else if (currentMapping.e === 'e') act_e += in_e; else if (currentMapping.e === 'w') act_w += in_e;
      if (currentMapping.w === 'n') act_n += in_w; else if (currentMapping.w === 's') act_s += in_w; else if (currentMapping.w === 'e') act_e += in_w; else if (currentMapping.w === 'w') act_w += in_w;

      let leftMotor = act_n - act_s + act_e - act_w;
      let rightMotor = act_n - act_s - act_e + act_w;

      leftMotor = Math.max(-1.0, Math.min(1.0, leftMotor));
      rightMotor = Math.max(-1.0, Math.min(1.0, rightMotor));

      const SPEED_SCALE = 85; 
      
      if (Math.abs(leftMotor) > 0.05) {
        leftSpeed = Math.round(Math.abs(leftMotor) * SPEED_SCALE);
        leftDir = leftMotor >= 0 ? 1 : 2;
      }
      
      if (Math.abs(rightMotor) > 0.05) {
        rightSpeed = Math.round(Math.abs(rightMotor) * SPEED_SCALE);
        rightDir = rightMotor >= 0 ? 1 : 2;
      }
    }

    controlMotors(leftSpeed, leftDir, rightSpeed, rightDir);
  }
}

/**
 * ボタンが押されたエッジ（瞬間の立ち上がり）を検出する
 */
function detectButtonPress(btnId, isPressed, callback) {
  if (isPressed && !prevButtonsState[btnId]) {
    callback();
  }
  prevButtonsState[btnId] = isPressed;
}

/**
 * バーチャルスティックのUI位置更新
 */
function updateVirtualStickUI(x, y) {
  const MAX_RADIUS = 26;
  const targetX = x * MAX_RADIUS;
  const targetY = y * MAX_RADIUS;
  
  leftStick.style.transform = `translate(${targetX}px, ${targetY}px)`;
  leftAxisVal.textContent = `X: ${x.toFixed(2)}, Y: ${y.toFixed(2)}`;
}

/**
 * コントローラーボタンノードのUI表示変更
 */
function updateButtonNodesUI(btnA, btnB, btnX, btnY) {
  toggleBtnClass('btn-a', btnA);
  toggleBtnClass('btn-b', btnB);
  toggleBtnClass('btn-x', btnX);
  toggleBtnClass('btn-y', btnY);
}

function toggleBtnClass(elementId, isPressed) {
  const el = document.getElementById(elementId);
  if (isPressed) {
    el.classList.add('pressed');
  } else {
    el.classList.remove('pressed');
  }
}

// ==========================================================================
// キーボード操作ロジック (フォールバック、シャッフル適用)
// ==========================================================================
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  if (e.key in keysPressed || e.key === 'w' || e.key === 's' || e.key === 'a' || e.key === 'd') {
    if (isRandomDriving) {
      stopRandomDrive("キーボード操作");
    }
    keysPressed[e.key] = true;

    // タイムアタック：上(W/↑)と下(S/↓)の同時押し検知
    const isUpPressed = keysPressed.w || keysPressed.ArrowUp;
    const isDownPressed = keysPressed.s || keysPressed.ArrowDown;
    if (isUpPressed && isDownPressed && taState === 'ready') {
      startCountdown();
    }

    processKeyboardDrive();
  }

  if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
    if (isRandomDriving) stopRandomDrive("キーボード操作");
  }

  if (e.key === '1') {
    setLED(57, 255, 20); playSound(2); addLog("[Keyboard 1] 緑LED & 接続音", "system");
  } else if (e.key === '2') {
    setLED(255, 0, 85); playSound(1); addLog("[Keyboard 2] 赤LED & ダメージ音", "system");
  } else if (e.key === '3') {
    setLED(0, 195, 227); playSound(3); addLog("[Keyboard 3] 青LED & レベルアップ音", "system");
  } else if (e.key === '4') {
    setLED(255, 230, 0); playSound(9); addLog("[Keyboard 4] 黄LED & コイン音", "system");
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key in keysPressed || e.key === 'w' || e.key === 's' || e.key === 'a' || e.key === 'd') {
    keysPressed[e.key] = false;
    processKeyboardDrive();
  }
});

function isKeyboardControlling() {
  return (
    keysPressed.w || keysPressed.s || keysPressed.a || keysPressed.d ||
    keysPressed.ArrowUp || keysPressed.ArrowDown || keysPressed.ArrowLeft || keysPressed.ArrowRight
  );
}

function processKeyboardDrive() {
  if (!isKeyboardControlling()) {
    if (activeGamepadIndex === null && !isRandomDriving) {
      controlMotors(0, 1, 0, 1);
    }
    return;
  }

  // タイムアタックでカウントダウン中、準備中（フライング防止）、またはゴール後（finished）は操縦入力をロック
  const isTaLocked = (taState === 'ready' || taState === 'countdown' || taState === 'finished');

  let leftSpeed = 0;
  let rightSpeed = 0;
  let leftDir = 1;
  let rightDir = 1;

  if (!isTaLocked) {
    const fwd = keysPressed.w || keysPressed.ArrowUp ? 1.0 : 0.0;
    const bwd = keysPressed.s || keysPressed.ArrowDown ? 1.0 : 0.0;
    const left = keysPressed.a || keysPressed.ArrowLeft ? 1.0 : 0.0;
    const right = keysPressed.d || keysPressed.ArrowRight ? 1.0 : 0.0;

    let act_n = 0, act_s = 0, act_e = 0, act_w = 0;
    
    if (currentMapping.n === 'n') act_n += fwd; else if (currentMapping.n === 's') act_s += fwd; else if (currentMapping.n === 'e') act_e += fwd; else if (currentMapping.n === 'w') act_w += fwd;
    if (currentMapping.s === 'n') act_n += bwd; else if (currentMapping.s === 's') act_s += bwd; else if (currentMapping.s === 'e') act_e += bwd; else if (currentMapping.s === 'w') act_w += bwd;
    if (currentMapping.e === 'n') act_n += right; else if (currentMapping.e === 's') act_s += right; else if (currentMapping.e === 'e') act_e += right; else if (currentMapping.e === 'w') act_w += right;
    if (currentMapping.w === 'n') act_n += left; else if (currentMapping.w === 's') act_s += left; else if (currentMapping.w === 'e') act_e += left; else if (currentMapping.w === 'w') act_w += left;

    let leftMotor = act_n - act_s + act_e - act_w;
    let rightMotor = act_n - act_s - act_e + act_w;

    leftMotor = Math.max(-1.0, Math.min(1.0, leftMotor));
    rightMotor = Math.max(-1.0, Math.min(1.0, rightMotor));
    
    const DRIVE_SPEED = 60;

    leftSpeed = Math.round(Math.abs(leftMotor) * DRIVE_SPEED);
    rightSpeed = Math.round(Math.abs(rightMotor) * DRIVE_SPEED);
    leftDir = leftMotor >= 0 ? 1 : 2;
    rightDir = rightMotor >= 0 ? 1 : 2;
  }

  controlMotors(leftSpeed, leftDir, rightSpeed, rightDir);
}

// ==========================================================================
// ヘルパー関数群
// ==========================================================================
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

btnClearLogs.addEventListener('click', () => {
  logBox.innerHTML = '';
  addLog("ログをクリアしました。", "system");
});

guideToggle.addEventListener('click', () => {
  guideContent.classList.toggle('hidden');
  const isHidden = guideContent.classList.contains('hidden');
  addLog(`ヘルプガイドを${isHidden ? '閉じました' : '開きました'}。`, "system");
});

// ==========================================================================
// タイムアタック (Time Attack) 制御ロジック
// ==========================================================================

// 初期ロード時のベストタイム表示
function initTaBestTimeDisplay() {
  if (taBestTime !== null) {
    taBest.textContent = formatTime(taBestTime);
    if (taBestPlayer) {
      taBestPlayerDisplay.textContent = `by ${taBestPlayer}`;
    } else {
      taBestPlayerDisplay.textContent = '';
    }
  } else {
    taBest.textContent = "--:--.--";
    taBestPlayerDisplay.textContent = '';
  }
}

// タイムアタック強制リセット (0 カード検知時)
function resetTimeAttackToIdle() {
  if (taState === 'idle') return; // すでに待機中なら何もしない

  stopRandomDrive(); // 自律走行中なら停止
  stopShuffleGimmick(); // 操作シャッフルを解除・リセット

  if (taTimerInterval) {
    cancelAnimationFrame(taTimerInterval);
    taTimerInterval = null;
  }
  if (taCountdownTimer) {
    clearTimeout(taCountdownTimer);
    taCountdownTimer = null;
  }

  taState = 'idle';
  taElapsedTime = 0;
  hasTriggeredExclamationTrap = false;
  hasTriggeredQuestionTrap = false;
  taLaps = []; // ラップタイムを初期化
  updateLapsUI(); // UI更新
  
  taTimer.textContent = "00:00.00";
  countdownOverlay.classList.add('hidden');
  resultOverlay.classList.add('hidden');
  
  updateTaUI();
  
  addLog("🔄 リトライカード [0] を検出：タイムアタックを強制リセットしました。", "system");
  
  playSound(1); // ダメージ音（リセット音代用）
  setLED(255, 0, 85, 50); // 一時的にネオンレッドで警告点灯
}

// タイムアタック初期設定 (→ カード検知時)
function setupTimeAttack() {
  if (taState === 'ready') return; // すでに準備完了なら何もしない

  stopRandomDrive(); // 自律走行中なら停止
  stopShuffleGimmick(); // 操作シャッフルを解除・リセット

  if (taTimerInterval) {
    cancelAnimationFrame(taTimerInterval);
    taTimerInterval = null;
  }
  if (taCountdownTimer) {
    clearTimeout(taCountdownTimer);
    taCountdownTimer = null;
  }

  taState = 'ready';
  taElapsedTime = 0;
  hasTriggeredExclamationTrap = false;
  hasTriggeredQuestionTrap = false;
  taLaps = []; // ラップタイムを初期化
  updateLapsUI(); // UI更新
  
  taTimer.textContent = "00:00.00";
  countdownOverlay.classList.add('hidden');
  resultOverlay.classList.add('hidden');
  
  updateTaUI();
  
  addLog("🏁 スタート位置 [→] を検出：操作初期化＆タイマーをリセットしました。", "success");
  addLog("👉 コントローラーの「L＋R」同時押し（キーボードはW＋S / ↑＋↓）でスタート！", "system");
  
  playSound(2); // 接続音
  setLED(255, 230, 0, 0); // ネオンイエロー点灯
}

// 3秒カウントダウン開始
function startCountdown() {
  if (taState !== 'ready') return;

  // プレイヤー名の重複チェックガード
  if (checkPlayerNameDuplicate()) {
    addLog("⚠️ このプレイヤー名はすでにランキングに登録されています。別の名前を入力してください。", "error");
    playSound(1); // 警告音
    return;
  }

  // 走行用のプレイヤー名を現在の入力値で確定・ロックする
  activePlayerName = playerNameInput.value.trim() || 'プレイヤー1';

  taState = 'countdown';
  taCountdownVal = 3;
  
  updateTaUI();
  
  countdownOverlay.classList.remove('hidden');
  countdownNumber.textContent = taCountdownVal;
  
  addLog("⏳ スタートカウントダウンを開始します...", "system");
  playSound(1); // ピッ
  setLED(255, 0, 0, 50); // カウントダウン中赤点灯

  taCountdownTimer = setTimeout(tickCountdown, 1000);
}

function tickCountdown() {
  taCountdownVal--;
  if (taCountdownVal > 0) {
    countdownNumber.textContent = taCountdownVal;
    playSound(1); // ピッ
    taCountdownTimer = setTimeout(tickCountdown, 1000);
  } else {
    // GO!
    countdownNumber.textContent = "GO!";
    playSound(3); // ファンファーレ（レベルアップ音）
    setLED(57, 255, 20, 0); // ネオングリーン

    startTaTimer();

    // 1秒後にオーバーレイを隠す
    taCountdownTimer = setTimeout(() => {
      countdownOverlay.classList.add('hidden');
    }, 1000);
  }
}

// タイマースタート
function startTaTimer() {
  taState = 'running';
  updateTaUI();
  
  taStartTime = performance.now();
  addLog("🚀 タイマースタート！ゴール [1] を目指して操縦してください！", "success");
  
  taTimerInterval = requestAnimationFrame(updateTaTimerLoop);
}

// タイマーループ
function updateTaTimerLoop() {
  if (taState !== 'running') return;

  const now = performance.now();
  taElapsedTime = now - taStartTime;
  
  taTimer.textContent = formatTime(taElapsedTime);
  
  taTimerInterval = requestAnimationFrame(updateTaTimerLoop);
}

// タイム表示フォーマット (ミリ秒 -> MM:SS.CC)
function formatTime(ms) {
  const totalSeconds = ms / 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const centiseconds = Math.floor((ms % 1000) / 10);
  
  const mStr = String(minutes).padStart(2, '0');
  const sStr = String(seconds).padStart(2, '0');
  const cStr = String(centiseconds).padStart(2, '0');
  
  return `${mStr}:${sStr}.${cStr}`;
}

// タイマーUI表示の更新
function updateTaUI() {
  taStatus.className = "ta-status-label";
  
  if (taState === 'idle') {
    taStatus.textContent = "READY - スタート位置 \"→\" に置いてください";
  } else if (taState === 'ready') {
    // プレイヤー名の重複を判定
    const isDuplicate = taRanking.some(item => item.name.toLowerCase() === playerNameInput.value.trim().toLowerCase());
    if (isDuplicate) {
      taStatus.textContent = "警告：プレイヤー名がランキングと重複しています";
      taStatus.className = "ta-status-label countdown"; // 赤字警告
    } else {
      taStatus.textContent = "準備完了 - L＋R 同時押しでスタート！";
      taStatus.classList.add('ready');
    }
  } else if (taState === 'countdown') {
    taStatus.textContent = "カウントダウン中...";
    taStatus.classList.add('countdown');
  } else if (taState === 'running') {
    taStatus.textContent = "計測中！";
    taStatus.classList.add('running');
  } else if (taState === 'finished') {
    taStatus.textContent = "ゴールイン！";
    taStatus.classList.add('finished');
  }
}

// タイムアタック完走 (1 カード検知時)
function finishTimeAttack() {
  if (taState !== 'running') return;

  taState = 'finished';
  updateTaUI();

  if (taTimerInterval) {
    cancelAnimationFrame(taTimerInterval);
    taTimerInterval = null;
  }

  const timeStr = formatTime(taElapsedTime);
  addLog(`🎉 ゴール！ タイム: ${timeStr} (by ${activePlayerName})`, "success");
  playSound(9); // コイン音（ゴールファンファーレ）
  setLED(0, 195, 227, 0); // 青点灯

  resultTimeVal.textContent = timeStr;

  // タイムをランキングに登録
  const newRecordItem = {
    name: activePlayerName,
    time: taElapsedTime,
    date: new Date().toLocaleDateString('ja-JP')
  };
  taRanking.push(newRecordItem);
  taRanking.sort((a, b) => a.time - b.time); // 昇順ソート
  taRanking = taRanking.slice(0, 5); // 上位5件
  localStorage.setItem('toio_ta_ranking', JSON.stringify(taRanking));
  updateRankingUI(); // ランキング表示を更新

  const isNewRecord = (taBestTime === null || taElapsedTime < taBestTime);

  if (isNewRecord) {
    taBestTime = taElapsedTime;
    taBestPlayer = activePlayerName;
    localStorage.setItem('toio_ta_best', taBestTime);
    localStorage.setItem('toio_ta_best_player', taBestPlayer);
    
    taBest.textContent = formatTime(taBestTime);
    taBestPlayerDisplay.textContent = `by ${taBestPlayer}`;
    addLog(`🏆 新記録達成！ベストタイム更新: ${formatTime(taBestTime)} (by ${taBestPlayer})`, "success");
    
    resultRecordMsg.textContent = `🏆 NEW RECORD! (by ${taBestPlayer}) 🏆`;
    resultRecordMsg.style.color = "var(--neon-green)";
    resultRecordMsg.style.textShadow = "0 0 10px rgba(57, 255, 20, 0.6)";

    // ベスト更新フラッシュ効果（LED）
    flashLED(0, 195, 227, 3);
  } else {
    resultRecordMsg.textContent = `BEST TIME: ${formatTime(taBestTime)} (by ${taBestPlayer || '不明'})`;
    resultRecordMsg.style.color = "var(--neon-yellow)";
    resultRecordMsg.style.textShadow = "0 0 10px rgba(255, 230, 0, 0.4)";
  }

  resultOverlay.classList.remove('hidden');
  
  // ゴールした瞬間にtoioを完全停止
  controlMotors(0, 1, 0, 1);
}

// ベストタイムのリセット
btnResetBest.addEventListener('click', () => {
  if (confirm("ベストタイムの記録をリセットしますか？")) {
    taBestTime = null;
    taBestPlayer = '';
    localStorage.removeItem('toio_ta_best');
    localStorage.removeItem('toio_ta_best_player');
    initTaBestTimeDisplay();
    addLog("ベストタイムの記録をリセットしました。", "system");
  }
});

// ランキングのリセット
btnResetRanking.addEventListener('click', () => {
  if (confirm("ランキングの記録をすべて削除しますか？")) {
    taRanking = [];
    localStorage.removeItem('toio_ta_ranking');
    updateRankingUI();
    checkPlayerNameDuplicate(); // 重複エラー警告の解消
    addLog("ランキングの記録を削除しました。", "system");
  }
});

// LEDの複数回フラッシュ効果
async function flashLED(r, g, b, count) {
  for (let i = 0; i < count; i++) {
    await setLED(r, g, b, 20);
    await new Promise(resolve => setTimeout(resolve, 200));
    await setLED(0, 0, 0, 20);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  await setLED(r, g, b, 0);
}

// 結果オーバーレイ閉じるイベント
btnCloseResult.addEventListener('click', () => {
  resultOverlay.classList.add('hidden');
});

// 初期化実行
playerNameInput.value = playerName;
initTaBestTimeDisplay();
updateRankingUI();
checkPlayerNameDuplicate();
