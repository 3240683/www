/**
 * toio & Switch Controller コネクター
 * ----------------------------------------------------
 * Web Bluetooth API を用いて toio コア キューブを制御し、
 * Web Gamepad API を用いて Nintendo Switch コントローラーの入力を反映させます。
 * さらに toio のIDセンサー情報を読み取り、マット上の座標と角度を可視化します。
 * 自律動作としての「ランダムデモ走行モード」に加え、
 * マットに侵入した際に操作が狂う「操作シャッフルギミック」も搭載。
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
// 状態管理変数
// ==========================================================================
let toioDevice = null;
let idCharacteristic = null;
let motorCharacteristic = null;
let ledCharacteristic = null;
let soundCharacteristic = null;
let isConnectedToio = false;

// 位置情報管理
let currentX = null;
let currentY = null;
let currentAngle = null;
let isToioOnMat = false;

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
let isShuffleEnabled = false;   // ギミック自体が有効か
let isShuffledActive = false;   // 実際に今シャッフル状態か
let currentMapping = { n: 'n', s: 's', e: 'e', w: 'w' }; // 通常のマッピング

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

const leftSpeedBar = document.getElementById('left-speed-bar');
const leftSpeedVal = document.getElementById('left-speed-val');
const rightSpeedBar = document.getElementById('right-speed-bar');
const rightSpeedVal = document.getElementById('right-speed-val');

const ledPicker = document.getElementById('led-picker');
const logBox = document.getElementById('log-box');
const btnClearLogs = document.getElementById('btn-clear-logs');
const guideToggle = document.getElementById('guide-toggle');
const guideContent = document.getElementById('guide-content');

// 座標表示用DOM
const coordX = document.getElementById('coord-x');
const coordY = document.getElementById('coord-y');
const coordAngle = document.getElementById('coord-angle');
const coordStatusText = document.getElementById('coord-status-text');
const mapCanvas = document.getElementById('toio-map');
const ctx = mapCanvas.getContext('2d');

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
const chkShuffleEnable = document.getElementById('chk-shuffle-enable');
const shuffleStatusPanel = document.getElementById('shuffle-status-panel');
const shuffleStatusText = document.getElementById('shuffle-status-text');
const shuffleIcon = document.getElementById('shuffle-icon');

// toioの標準マット座標範囲
const MIN_MAT_X = 45;
const MAX_MAT_X = 455;
const MIN_MAT_Y = 45;
const MAX_MAT_Y = 455;

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
// マップ描画ロジック (2D Canvas)
// ==========================================================================
function initMapCanvas() {
  drawMap(null, null, null, false);
}

/**
 * Canvasにマットとtoioを描画
 */
function drawMap(x, y, angle, isOnMat) {
  const width = mapCanvas.width;
  const height = mapCanvas.height;
  
  ctx.fillStyle = '#0d0f1a';
  ctx.fillRect(0, 0, width, height);
  
  ctx.strokeStyle = 'rgba(0, 195, 227, 0.08)';
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let i = 0; i < width; i += gridSize) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i, height);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(0, i);
    ctx.lineTo(width, i);
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 2;
  ctx.strokeRect(20, 20, width - 40, height - 40);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
  ctx.font = '10px Inter';
  ctx.textAlign = 'center';
  ctx.fillText('TOIO PLAY MAT AREA', width / 2, 35);
  
  if (isOnMat && x !== null && y !== null && angle !== null) {
    const canvasX = mapRange(x, MIN_MAT_X, MAX_MAT_X, 20, width - 20);
    const canvasY = mapRange(y, MIN_MAT_Y, MAX_MAT_Y, 20, height - 20);
    
    ctx.save();
    ctx.translate(canvasX, canvasY);
    ctx.rotate((angle * Math.PI) / 180);
    
    ctx.fillStyle = '#ffffff';
    ctx.shadowBlur = 12;
    ctx.shadowColor = 'rgba(0, 195, 227, 0.6)';
    ctx.beginPath();
    ctx.roundRect(-13, -13, 26, 26, 4);
    ctx.fill();
    ctx.shadowBlur = 0;
    
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(-8, -15, 16, 2);
    ctx.fillRect(-8, 13, 16, 2);

    ctx.fillStyle = 'var(--neon-blue)';
    ctx.beginPath();
    ctx.moveTo(8, -6);
    ctx.lineTo(13, 0);
    ctx.lineTo(8, 6);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'var(--neon-blue)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(8, 0);
    ctx.stroke();

    ctx.restore();
    
    ctx.strokeStyle = 'rgba(0, 195, 227, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(canvasX, 0);
    ctx.lineTo(canvasX, height);
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(0, canvasY);
    ctx.lineTo(width, canvasY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function mapRange(value, inMin, inMax, outMin, outMax) {
  const result = outMin + ((value - inMin) * (outMax - outMin)) / (inMax - inMin);
  return Math.max(outMin, Math.min(outMax, result));
}

initMapCanvas();

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
  stopShuffleGimmick(); // シャッフルの解除
  
  isConnectedToio = false;
  toioDevice = null;
  idCharacteristic = null;
  motorCharacteristic = null;
  ledCharacteristic = null;
  soundCharacteristic = null;
  
  isToioOnMat = false;
  currentX = null;
  currentY = null;
  currentAngle = null;
  
  updateToioUI(false);
  updateCoordinatesUI(null, null, null, false);
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
    
    updateTelemetry(0, 0);
    initMapCanvas();
  }
  lucide.createIcons();
}

// ==========================================================================
// IDリーダー センサー値の通知処理
// ==========================================================================
function handleIdNotification(event) {
  const data = event.target.value;
  if (data.byteLength < 1) return;

  const infoType = data.getUint8(0);

  if (infoType === 0x01) {
    // Position ID（マットの上に乗っている状態）
    if (data.byteLength < 7) return;

    const x = data.getUint16(1, true);
    const y = data.getUint16(3, true);
    const angle = data.getUint16(5, true);

    currentX = x;
    currentY = y;
    currentAngle = angle;
    
    const wasOnMat = isToioOnMat;
    isToioOnMat = true;

    // シャッフルトラップ発動判定 (新しくマットに乗った瞬間)
    if (isShuffleEnabled && !isShuffledActive) {
      isShuffledActive = true;
      shuffleMapping();
      updateShuffleUI(true);
    }

    updateCoordinatesUI(x, y, angle, true);
  } else if (infoType === 0x03) {
    // Position ID Missed（マットから離れた状態）
    const wasOnMat = isToioOnMat;
    isToioOnMat = false;
    
    // 自律走行中にマットから落ちた場合は安全のため緊急停止
    if (isRandomDriving && wasOnMat) {
      addLog("マット外への脱落を検知したため、自動走行を緊急停止しました。", "error");
      stopRandomDrive();
    }

    // シャッフルトラップ解除判定
    if (isShuffledActive) {
      isShuffledActive = false;
      resetMapping();
      updateShuffleUI(false);
      addLog("マットから離れたため、操作が正常に戻りました。", "system");
    }

    updateCoordinatesUI(null, null, null, false);
  }
}

/**
 * 座標表示UIとCanvasの更新
 */
function updateCoordinatesUI(x, y, angle, isOnMat) {
  if (isOnMat) {
    coordX.textContent = x;
    coordY.textContent = y;
    coordAngle.textContent = `${angle}°`;
    coordStatusText.textContent = "マット内";
    coordStatusText.className = "status-val on-mat";
    drawMap(x, y, angle, true);
  } else {
    coordX.textContent = "---";
    coordY.textContent = "---";
    coordAngle.textContent = "---";
    coordStatusText.textContent = "マット外";
    coordStatusText.className = "status-val off-mat";
    drawMap(currentX, currentY, currentAngle, false);
  }
}

// ==========================================================================
// 操作シャッフル (パニックトラップ) ロジック
// ==========================================================================
chkShuffleEnable.addEventListener('change', (e) => {
  isShuffleEnabled = e.target.checked;
  if (isShuffleEnabled) {
    addLog("操作シャッフルギミックを有効にしました。マットに乗ると発動します！", "system");
    // すでにマットの上に乗っている状態でチェックを入れた場合は即発動
    if (isToioOnMat && !isShuffledActive) {
      isShuffledActive = true;
      shuffleMapping();
      updateShuffleUI(true);
    }
  } else {
    addLog("操作シャッフルギミックを無効にしました。", "system");
    stopShuffleGimmick();
  }
});

function shuffleMapping() {
  const inputs = ['n', 's', 'e', 'w'];
  const outputs = [...inputs];
  
  // Fisher-Yates アルゴリズムでマッピング順をシャッフル
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

  addLog(`⚠️ マット侵入！操作がシャッフルされました！ [前進⇒${getDirJapaneseName(outputs[0])}]`, "error");
  playSound(1); // ダメージ音を流して警告
  
  // LEDを赤に一瞬点滅
  setLED(255, 0, 0, 50);
}

function resetMapping() {
  currentMapping = { n: 'n', s: 's', e: 'e', w: 'w' };
}

function stopShuffleGimmick() {
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
// ランダム8方向走行ロジック
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

  // 自律走行時はシャッフルギミックをOFFにするのが安全
  if (isShuffleEnabled) {
    chkShuffleEnable.checked = false;
    isShuffleEnabled = false;
    stopShuffleGimmick();
    addLog("自律走行のため、操作シャッフルを自動的にOFFにしました。", "system");
  }

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
  updateTelemetry(0, 0);

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
    updateTelemetry(0, 0);
  } else {
    const nextDir = RANDOM_DIRECTIONS[Math.floor(Math.random() * RANDOM_DIRECTIONS.length)];
    
    clearActiveDirectionUI();
    if (directionElements[nextDir.id]) {
      directionElements[nextDir.id].classList.add('active');
    }
    
    addLog(`自動走行 - 動作変更: ${nextDir.name}`, "system");
    
    controlMotors(nextDir.leftSpeed, nextDir.leftDir, nextDir.rightSpeed, nextDir.rightDir);

    const signedLeft = nextDir.leftDir === 1 ? nextDir.leftSpeed : -nextDir.leftSpeed;
    const signedRight = nextDir.rightDir === 1 ? nextDir.rightSpeed : -nextDir.rightSpeed;
    updateTelemetry(signedLeft, signedRight);
    
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
 * コントローラーの入力を処理し、toioに反映
 */
function handleGamepadInput(gp) {
  // --- A) アナログスティックの取得 (左スティック) ---
  let axisX = gp.axes[0] || 0;
  let axisY = gp.axes[1] || 0;

  const DEADZONE = 0.15;
  let xValue = Math.abs(axisX) > DEADZONE ? axisX : 0;
  let yValue = Math.abs(axisY) > DEADZONE ? axisY : 0;

  updateVirtualStickUI(xValue, yValue);

  // --- B) ボタン入力の監視 ---
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

  // ボタン押下検知時の自動走行解除 ＆ アクション実行
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

  // スティック操作があった場合の自動走行解除 ＆ モーター駆動
  if (Math.abs(xValue) > 0 || Math.abs(yValue) > 0) {
    if (isRandomDriving) {
      stopRandomDrive("コントローラーのスティック操作");
    }
  }

  // キーボードがアクティブでなく、かつランダム走行中でない場合にスティック値を適用
  if (!isKeyboardControlling() && !isRandomDriving) {
    const steerY = -yValue; // 前進方向: +1.0, 後退方向: -1.0
    const steerX = xValue;  // 右旋回: +1.0, 左旋回: -1.0

    // 通常状態とシャッフル状態で入力をマッピング
    // 意思の特定
    const in_n = Math.max(0, steerY);
    const in_s = Math.max(0, -steerY);
    const in_e = Math.max(0, steerX);
    const in_w = Math.max(0, -steerX);

    // アクション強度の計算 (シャッフル適用)
    let act_n = 0, act_s = 0, act_e = 0, act_w = 0;
    
    // マッピング変換
    if (currentMapping.n === 'n') act_n += in_n; else if (currentMapping.n === 's') act_s += in_n; else if (currentMapping.n === 'e') act_e += in_n; else if (currentMapping.n === 'w') act_w += in_n;
    if (currentMapping.s === 'n') act_n += in_s; else if (currentMapping.s === 's') act_s += in_s; else if (currentMapping.s === 'e') act_e += in_s; else if (currentMapping.s === 'w') act_w += in_s;
    if (currentMapping.e === 'n') act_n += in_e; else if (currentMapping.e === 's') act_s += in_e; else if (currentMapping.e === 'e') act_e += in_e; else if (currentMapping.e === 'w') act_w += in_e;
    if (currentMapping.w === 'n') act_n += in_w; else if (currentMapping.w === 's') act_s += in_w; else if (currentMapping.w === 'e') act_e += in_w; else if (currentMapping.w === 'w') act_w += in_w;

    // 左右モーター比率の合成
    let leftMotor = act_n - act_s + act_e - act_w;
    let rightMotor = act_n - act_s - act_e + act_w;

    leftMotor = Math.max(-1.0, Math.min(1.0, leftMotor));
    rightMotor = Math.max(-1.0, Math.min(1.0, rightMotor));

    const SPEED_SCALE = 85; 
    
    let leftSpeed = 0;
    let rightSpeed = 0;
    let leftDir = 1;
    let rightDir = 1;

    if (Math.abs(leftMotor) > 0.05) {
      leftSpeed = Math.round(Math.abs(leftMotor) * SPEED_SCALE);
      leftDir = leftMotor >= 0 ? 1 : 2;
    }
    
    if (Math.abs(rightMotor) > 0.05) {
      rightSpeed = Math.round(Math.abs(rightMotor) * SPEED_SCALE);
      rightDir = rightMotor >= 0 ? 1 : 2;
    }

    controlMotors(leftSpeed, leftDir, rightSpeed, rightDir);

    const signedLeft = leftDir === 1 ? leftSpeed : -leftSpeed;
    const signedRight = rightDir === 1 ? rightSpeed : -rightSpeed;
    updateTelemetry(signedLeft, signedRight);
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
// キーボード操作ロジック (フォールバック)
// ==========================================================================
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;

  if (e.key in keysPressed || e.key === 'w' || e.key === 's' || e.key === 'a' || e.key === 'd') {
    if (isRandomDriving) {
      stopRandomDrive("キーボード操作");
    }
    keysPressed[e.key] = true;
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
      updateTelemetry(0, 0);
    }
    return;
  }

  const fwd = keysPressed.w || keysPressed.ArrowUp ? 1.0 : 0.0;
  const bwd = keysPressed.s || keysPressed.ArrowDown ? 1.0 : 0.0;
  const left = keysPressed.a || keysPressed.ArrowLeft ? 1.0 : 0.0;
  const right = keysPressed.d || keysPressed.ArrowRight ? 1.0 : 0.0;

  // アクション強度の計算 (シャッフル適用)
  let act_n = 0, act_s = 0, act_e = 0, act_w = 0;
  
  if (currentMapping.n === 'n') act_n += fwd; else if (currentMapping.n === 's') act_s += fwd; else if (currentMapping.n === 'e') act_e += fwd; else if (currentMapping.n === 'w') act_w += fwd;
  if (currentMapping.s === 'n') act_n += bwd; else if (currentMapping.s === 's') act_s += bwd; else if (currentMapping.s === 'e') act_e += bwd; else if (currentMapping.s === 'w') act_w += bwd;
  if (currentMapping.e === 'n') act_n += right; else if (currentMapping.e === 's') act_s += right; else if (currentMapping.e === 'e') act_e += right; else if (currentMapping.e === 'w') act_w += right;
  if (currentMapping.w === 'n') act_n += left; else if (currentMapping.w === 's') act_s += left; else if (currentMapping.w === 'e') act_e += left; else if (currentMapping.w === 'w') act_w += left;

  // 左右モーター比率の合成
  let leftMotor = act_n - act_s + act_e - act_w;
  let rightMotor = act_n - act_s - act_e + act_w;

  leftMotor = Math.max(-1.0, Math.min(1.0, leftMotor));
  rightMotor = Math.max(-1.0, Math.min(1.0, rightMotor));
  
  const DRIVE_SPEED = 60;

  let leftSpeed = Math.round(Math.abs(leftMotor) * DRIVE_SPEED);
  let rightSpeed = Math.round(Math.abs(rightMotor) * DRIVE_SPEED);
  let leftDir = leftMotor >= 0 ? 1 : 2;
  let rightDir = rightMotor >= 0 ? 1 : 2;

  controlMotors(leftSpeed, leftDir, rightSpeed, rightDir);

  const signedLeft = leftDir === 1 ? leftSpeed : -leftSpeed;
  const signedRight = rightDir === 1 ? rightSpeed : -rightSpeed;
  updateTelemetry(signedLeft, signedRight);
}

// ==========================================================================
// テレメトリ UI 更新ロジック
// ==========================================================================
function updateTelemetry(leftSpeed, rightSpeed) {
  updateSpeedBar(leftSpeedBar, leftSpeedVal, leftSpeed);
  updateSpeedBar(rightSpeedBar, rightSpeedVal, rightSpeed);
}

function updateSpeedBar(barEl, valEl, speed) {
  const percent = Math.min(100, Math.round((Math.abs(speed) / 115) * 100));
  barEl.style.width = `${percent}%`;
  
  if (speed > 0) {
    barEl.style.background = 'linear-gradient(90deg, var(--neon-blue), var(--neon-green))';
    valEl.textContent = `+${speed}`;
  } else if (speed < 0) {
    barEl.style.background = 'linear-gradient(90deg, var(--neon-red), #d60047)';
    valEl.textContent = `${speed}`;
  } else {
    barEl.style.width = '0%';
    valEl.textContent = '0';
  }
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
