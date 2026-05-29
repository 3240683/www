/**
 * toio & Switch Controller コネクター
 * ----------------------------------------------------
 * Web Bluetooth API を用いて toio コア キューブを制御し、
 * Web Gamepad API を用いて Nintendo Switch コントローラーの入力を反映させます。
 */

// ==========================================================================
// BLE UUID定義 (toio仕様準拠)
// ==========================================================================
const TOIO_SERVICE_UUID = '10b20100-5b3b-4571-9508-cf3efcd7bbae';
const MOTOR_CHAR_UUID   = '10b20102-5b3b-4571-9508-cf3efcd7bbae';
const LED_CHAR_UUID     = '10b20103-5b3b-4571-9508-cf3efcd7bbae';
const SOUND_CHAR_UUID   = '10b20104-5b3b-4571-9508-cf3efcd7bbae';

// ==========================================================================
// 状態管理変数
// ==========================================================================
let toioDevice = null;
let motorCharacteristic = null;
let ledCharacteristic = null;
let soundCharacteristic = null;
let isConnectedToio = false;

// ゲームパッド関連
let activeGamepadIndex = null;
let gamepadAnimationId = null;
let prevButtonsState = {}; // ボタンのトグル監視用

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
    
    // 切断イベント監視
    toioDevice.addEventListener('gattserverdisconnected', onToioDisconnected);

    addLog("GATTサーバーに接続中...", "system");
    const server = await toioDevice.gatt.connect();

    addLog("プライマリサービスを取得中...", "system");
    const service = await server.getPrimaryService(TOIO_SERVICE_UUID);

    addLog("キャラクタリスティックを取得中...", "system");
    motorCharacteristic = await service.getCharacteristic(MOTOR_CHAR_UUID);
    ledCharacteristic = await service.getCharacteristic(LED_CHAR_UUID);
    soundCharacteristic = await service.getCharacteristic(SOUND_CHAR_UUID);

    isConnectedToio = true;
    updateToioUI(true);
    addLog("toioコアキューブに正常に接続しました！", "success");

    // 接続成功時にピッと音を鳴らし、LEDを初期カラーにする
    await playSound(2); // 接続音
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
  isConnectedToio = false;
  toioDevice = null;
  motorCharacteristic = null;
  ledCharacteristic = null;
  soundCharacteristic = null;
  updateToioUI(false);
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
    
    // テレメトリをリセット
    updateTelemetry(0, 0);
  }
  lucide.createIcons();
}

/**
 * モーターの制御コマンドを送信
 * @param {number} leftSpeed - 左モーター速度 (0-255)
 * @param {number} leftDir - 左モーター方向 (1: 前進, 2: 後退)
 * @param {number} rightSpeed - 右モーター速度 (0-255)
 * @param {number} rightDir - 右モーター方向 (1: 前進, 2: 後退)
 */
async function controlMotors(leftSpeed, leftDir, rightSpeed, rightDir) {
  if (!motorCharacteristic || !isConnectedToio) return;

  const now = performance.now();
  
  // 値が前回と同じで、かつ送信間隔が規定時間未満ならスキップ (パケット詰まり防止)
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
    
    // 前回の状態を更新
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
  
  // 1回点灯のコマンド構造
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

// LEDカラーピッカーのイベント
ledPicker.addEventListener('input', (e) => {
  const rgb = hexToRgb(e.target.value);
  setLED(rgb.r, rgb.g, rgb.b);
});

// プリセットカラーボタンのイベント
document.querySelectorAll('.color-preset').forEach(btn => {
  btn.addEventListener('click', (e) => {
    const hex = e.target.dataset.color;
    ledPicker.value = hex;
    const rgb = hexToRgb(hex);
    setLED(rgb.r, rgb.g, rgb.b);
    addLog(`LEDカラーを変更しました: ${hex}`, "system");
  });
});

// クイック効果音ボタンのイベント
document.querySelectorAll('[data-sound]').forEach(btn => {
  btn.addEventListener('click', (e) => {
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
  
  // 最初に見つかったゲームパッドをアクティブにする
  if (activeGamepadIndex === null) {
    activeGamepadIndex = gp.index;
    showGamepadUI(gp);
    
    // スキャンポーリングループを開始
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
    
    // モーターを安全に停止
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

/**
 * 毎フレーム毎のコントローラー情報のポーリング
 */
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
  // --- A) アナログスティックの取得 (左スティックを標準とする) ---
  // standard mappingの場合: axes[0]がX軸、axes[1]がY軸
  // DirectInputなどの場合も大体最初の2軸が左スティック
  let axisX = gp.axes[0] || 0;
  let axisY = gp.axes[1] || 0;

  // デッドゾーン (遊び) 処理。わずかな傾きで暴走するのを防ぐ
  const DEADZONE = 0.15;
  let xValue = Math.abs(axisX) > DEADZONE ? axisX : 0;
  let yValue = Math.abs(axisY) > DEADZONE ? axisY : 0;

  // 画面のバーチャルスティックの描画更新
  updateVirtualStickUI(xValue, yValue);

  // --- B) ボタン入力の監視 (A, B, X, Y) ---
  // WindowsのGamepad APIにおける標準マッピング：
  // buttons[0] = A/B (下)
  // buttons[1] = B/A (右)
  // buttons[2] = X/Y (左)
  // buttons[3] = Y/X (上)
  // ※OSや接続モードにより入れ替わるため、画面の光り方を連動させます。
  const buttonMap = {
    A: gp.buttons[1] || gp.buttons[0] || { pressed: false }, // 通常、Aはインデックス1または0
    B: gp.buttons[0] || gp.buttons[1] || { pressed: false },
    X: gp.buttons[3] || gp.buttons[2] || { pressed: false },
    Y: gp.buttons[2] || gp.buttons[3] || { pressed: false }
  };
  
  // もし mapping が "standard" でない場合、独自に調整
  let btnA = gp.buttons[1]?.pressed || false;
  let btnB = gp.buttons[0]?.pressed || false;
  let btnX = gp.buttons[3]?.pressed || false;
  let btnY = gp.buttons[2]?.pressed || false;
  
  // Joy-Con(L)単体や一部マッピングでインデックスが異なる場合のフォールバック
  if (gp.buttons.length < 4) {
    btnA = gp.buttons[0]?.pressed || false;
    btnB = gp.buttons[1]?.pressed || false;
    btnX = false;
    btnY = false;
  }

  updateButtonNodesUI(btnA, btnB, btnX, btnY);

  // ボタンが押された「瞬間」を検知してインタラクションを実行
  detectButtonPress('A', btnA, () => {
    addLog("[A] ボタンが押されました - 緑LED & 接続音", "controller");
    setLED(57, 255, 20); // ネオングリーン
    playSound(2); // 接続音
  });
  detectButtonPress('B', btnB, () => {
    addLog("[B] ボタンが押されました - 赤LED & ダメージ音", "controller");
    setLED(255, 0, 85); // ネオンレッド
    playSound(1); // ダメージ音
  });
  detectButtonPress('X', btnX, () => {
    addLog("[X] ボタンが押されました - 青LED & レベルアップ音", "controller");
    setLED(0, 195, 227); // ネオンブルー
    playSound(3); // レベルアップ音
  });
  detectButtonPress('Y', btnY, () => {
    addLog("[Y] ボタンが押されました - 黄LED & コイン音", "controller");
    setLED(255, 230, 0); // ネオンイエロー
    playSound(9); // コイン音
  });

  // キーボードが現在アクティブでなければ、スティック値を元にモーター速度を計算
  if (!isKeyboardControlling()) {
    // Y軸は上がマイナス方向なので符号反転。
    // xValueは旋回（右がプラス、左がマイナス）
    const steerY = -yValue; // 前進方向: +1.0, 後退方向: -1.0
    const steerX = xValue;  // 右旋回: +1.0, 左旋回: -1.0

    // スティック値から差動二輪への変換式
    let leftMotor = steerY + steerX;
    let rightMotor = steerY - steerX;

    // クリッピング [-1.0, 1.0]
    leftMotor = Math.max(-1.0, Math.min(1.0, leftMotor));
    rightMotor = Math.max(-1.0, Math.min(1.0, rightMotor));

    // toioの速度スケール（0〜85程度に設定。制御しやすくするため最大115より少し下げる）
    const SPEED_SCALE = 85; 
    
    // スティック入力が極めて小さいときは完全に停止させる
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

    // toioにモーター制御コマンドを送信
    controlMotors(leftSpeed, leftDir, rightSpeed, rightDir);

    // テレメトリ表示の更新
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
  // スティックスペースの最大半径 (px)
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
  // 入力フォーム等で打たれている場合は無視
  if (e.target.tagName === 'INPUT') return;

  if (e.key in keysPressed || e.key === 'w' || e.key === 's' || e.key === 'a' || e.key === 'd') {
    keysPressed[e.key] = true;
    processKeyboardDrive();
  }

  // 1, 2, 3, 4 キーでの効果音＆LED変更
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
    // キーが何も押されていなければ停止
    if (activeGamepadIndex === null) {
      controlMotors(0, 1, 0, 1);
      updateTelemetry(0, 0);
    }
    return;
  }

  // キーの組み合わせによる操作コマンドの計算
  const fwd = keysPressed.w || keysPressed.ArrowUp;
  const bwd = keysPressed.s || keysPressed.ArrowDown;
  const left = keysPressed.a || keysPressed.ArrowLeft;
  const right = keysPressed.d || keysPressed.ArrowRight;

  let leftSpeed = 0;
  let rightSpeed = 0;
  let leftDir = 1;
  let rightDir = 1;
  
  // 操縦パラメータ
  const DRIVE_SPEED = 60; // キーボード時の走行速度
  const TURN_SPEED = 40;  // 旋回時の走行速度

  if (fwd && !bwd) {
    if (left && !right) {
      // 左前進旋回
      leftSpeed = TURN_SPEED;
      rightSpeed = DRIVE_SPEED;
    } else if (right && !left) {
      // 右前進旋回
      leftSpeed = DRIVE_SPEED;
      rightSpeed = TURN_SPEED;
    } else {
      // 直進前進
      leftSpeed = DRIVE_SPEED;
      rightSpeed = DRIVE_SPEED;
    }
    leftDir = 1;
    rightDir = 1;
  } else if (bwd && !fwd) {
    if (left && !right) {
      // 左後退旋回
      leftSpeed = TURN_SPEED;
      rightSpeed = DRIVE_SPEED;
    } else if (right && !left) {
      // 右後退旋回
      leftSpeed = DRIVE_SPEED;
      rightSpeed = TURN_SPEED;
    } else {
      // 直進後退
      leftSpeed = DRIVE_SPEED;
      rightSpeed = DRIVE_SPEED;
    }
    leftDir = 2;
    rightDir = 2;
  } else if (left && !right) {
    // 超信地左旋回 (その場で左回転)
    leftSpeed = TURN_SPEED;
    rightSpeed = TURN_SPEED;
    leftDir = 2;
    rightDir = 1;
  } else if (right && !left) {
    // 超信地右旋回 (その場で右回転)
    leftSpeed = TURN_SPEED;
    rightSpeed = TURN_SPEED;
    leftDir = 1;
    rightDir = 2;
  }

  controlMotors(leftSpeed, leftDir, rightSpeed, rightDir);

  // テレメトリの更新
  const signedLeft = leftDir === 1 ? leftSpeed : -leftSpeed;
  const signedRight = rightDir === 1 ? rightSpeed : -rightSpeed;
  updateTelemetry(signedLeft, signedRight);
}

// ==========================================================================
// テレメトリ UI 更新ロジック
// ==========================================================================
function updateTelemetry(leftSpeed, rightSpeed) {
  // leftSpeed, rightSpeed は -255〜255 (符号で前後を示す)
  updateSpeedBar(leftSpeedBar, leftSpeedVal, leftSpeed);
  updateSpeedBar(rightSpeedBar, rightSpeedVal, rightSpeed);
}

function updateSpeedBar(barEl, valEl, speed) {
  const percent = Math.min(100, Math.round((Math.abs(speed) / 115) * 100));
  barEl.style.width = `${percent}%`;
  
  // 前進と後退で色を切り替える
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

// ログクリア
btnClearLogs.addEventListener('click', () => {
  logBox.innerHTML = '';
  addLog("ログをクリアしました。", "system");
});

// 操作ガイド折りたたみトグル
guideToggle.addEventListener('click', () => {
  guideContent.classList.toggle('hidden');
  const isHidden = guideContent.classList.contains('hidden');
  addLog(`ヘルプガイドを${isHidden ? '閉じました' : '開きました'}。`, "system");
});
