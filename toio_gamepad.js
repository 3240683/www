const cubes = [];
const targetMat = P5tId.SimpleTileMat; //使うマットを設定
 
let connectBtn; //接続ボタン
let fsBtn; //全画面表示ボタン

// ゲームパッド関連
let gamepadConnected = false;
const STICK_DEADZONE = 0.15; // スティックのデッドゾーン（小さな入力を無視）
const MOVE_SPEED = 30;       // 移動速度
const MOVE_DURATION = 25;    // 移動時間
 
// 元の設計サイズ
const BASE_W = 600;
const BASE_H = 500;
 
// マットの描画範囲
const MAT_X = 50;
const MAT_Y = 50;
const MAT_W = 500;
const MAT_H = 355;
const COLOR_MAIN = [0, 133, 250, 100]; //少し透明なシアン
 
function setup() {
  //初期設定
  createCanvas(windowWidth, windowHeight);
  connectBtn = createButton("toioを接続する");
  connectBtn.position(20, 20);
  connectBtn.mousePressed(connectToio);
  fsBtn = createButton("全画面表示");
  fsBtn.position(150, 20);
  fsBtn.mousePressed(toggleFullscreen);

  // ゲームパッドの接続・切断イベント
  window.addEventListener("gamepadconnected", (e) => {
    gamepadConnected = true;
    console.log(`コントローラー接続: ${e.gamepad.id}`);
  });
  window.addEventListener("gamepaddisconnected", (e) => {
    gamepadConnected = false;
    console.log("コントローラー切断");
  });
}
 
function connectToio() {
  //toioのキューブとの接続（複数対応）
  P5tCube.connectNewP5tCube().then((cube) => {
    cubes.push(cube);
    cube.turnLightOn("white");
    connectBtn.html("次のtoioを接続");
  });
}
 
function toggleFullscreen() {
  fullscreen(!fullscreen());
}
 
function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

// ゲームパッドの入力を取得してキューブを動かす
function handleGamepad() {
  const gamepads = navigator.getGamepads();
  if (!gamepads) return;

  // 最初に見つかった有効なゲームパッドを使用
  let gp = null;
  for (let i = 0; i < gamepads.length; i++) {
    if (gamepads[i]) { gp = gamepads[i]; break; }
  }
  if (!gp) return;

  const cube = cubes[0]; // 最初のキューブを操作対象にする
  if (!cube) return;

  // ---- 左スティック（軸0: 左右, 軸1: 上下） ----
  const axisX = gp.axes[0]; // 左: -1, 右: +1
  const axisY = gp.axes[1]; // 上: -1, 下: +1

  let leftMotor = 0;
  let rightMotor = 0;

  if (abs(axisX) > STICK_DEADZONE || abs(axisY) > STICK_DEADZONE) {
    // スティック入力をモーター差動に変換
    // 前後成分: -axisY（上スティック＝前進）
    // 回転成分: axisX（右スティック＝右回転）
    const forward = -axisY * MOVE_SPEED;
    const turn    =  axisX * MOVE_SPEED;
    leftMotor  = constrain(forward - turn, -MOVE_SPEED, MOVE_SPEED);
    rightMotor = constrain(forward + turn, -MOVE_SPEED, MOVE_SPEED);
    cube.move(leftMotor, rightMotor, MOVE_DURATION);
    return; // スティック優先：十字キーとの同時処理を避ける
  }

  // ---- 十字キー（PS4/PS5 ボタン番号） ----
  // 12: 上, 13: 下, 14: 左, 15: 右
  const dUp    = gp.buttons[12]?.pressed;
  const dDown  = gp.buttons[13]?.pressed;
  const dLeft  = gp.buttons[14]?.pressed;
  const dRight = gp.buttons[15]?.pressed;

  const s = MOVE_SPEED;
  const d = MOVE_DURATION;

  if (dUp)    cube.move( s,  s, d);
  if (dDown)  cube.move(-s, -s, d);
  if (dLeft)  cube.move(-s,  s, d);
  if (dRight) cube.move( s, -s, d);

  // ---- Mボタン相当（△ = ボタン3）でランダム移動 ----
  if (gp.buttons[3]?.pressed) {
    const randX = floor(random(100)) - 50 + targetMat.centerX;
    const randY = floor(random(100)) - 50 + targetMat.centerY;
    cube.moveTo({ x: randX, y: randY }, 80);
  }
}
 
function draw() {
  //メインループ
  background(240, 252, 257); //水色
  let scaleFactor = min(width / BASE_W, height / BASE_H);
  push();
  translate(width / 2, height / 2);
  scale(scaleFactor);
  translate(-BASE_W / 2, -BASE_H / 2);
  drawMat();
 
  if (cubes.length === 0) {
    fill(100);
    noStroke();
    textSize(20);
    textAlign(CENTER, CENTER);
    text("左上のボタンから接続してください", BASE_W / 2, BASE_H / 6);
  } else {
    drawCubes();
  }

  pop();

  // ゲームパッド処理（座標変換の外で呼ぶ）
  handleGamepad();

  // コントローラー状態表示
  drawGamepadStatus();
}

function drawGamepadStatus() {
  // 画面右上にコントローラー接続状態を表示
  const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
  let connected = false;
  for (let i = 0; i < gamepads.length; i++) {
    if (gamepads[i]) { connected = true; break; }
  }

  noStroke();
  textAlign(RIGHT, TOP);
  textSize(13);
  if (connected) {
    fill(0, 180, 80);
    text("🎮 コントローラー接続中", width - 15, 15);
  } else {
    fill(180, 100, 0);
    text("🎮 コントローラー未接続", width - 15, 15);
  }
}
 
function drawMat() {
  fill(`white`);
  stroke(150);
  strokeWeight(1);
  rect(MAT_X, MAT_Y, MAT_W, MAT_H);
  stroke(COLOR_MAIN);
  strokeWeight(1);
 
  if (targetMat === P5tId.SimpleTileMat) {
    for (let i = 1; i < 7; i++) {
      let x = MAT_X + (MAT_W / 7) * i;
      line(x, MAT_Y, x, MAT_Y + MAT_H);
    }
    for (let j = 1; j < 5; j++) {
      let y = MAT_Y + (MAT_H / 5) * j;
      line(MAT_X, y, MAT_X + MAT_W, y);
    }
  }
 
  noStroke();
  fill(COLOR_MAIN);
  circle(MAT_W / 2 + MAT_X, MAT_H / 2 + MAT_Y, 3);
  textSize(8);
  textAlign(CENTER, TOP);
  text(
    `${targetMat.centerX}, ${targetMat.centerY}`,
    MAT_W / 2 + MAT_X,
    MAT_H / 2 + MAT_Y
  );
  text(`${targetMat.maxX}, ${targetMat.maxY}`, MAT_W + MAT_X, MAT_H + MAT_Y);
  textAlign(CENTER, BOTTOM);
  text(`${targetMat.minX}, ${targetMat.minY}`, MAT_X, MAT_Y);
}
 
function drawCubes() {
  for (let i = 0; i < cubes.length; i++) {
    let cube = cubes[i];
    if (typeof cube.x !== "number" || typeof cube.y !== "number") continue;
    let displayX = map(cube.x, 98, 402, MAT_X, MAT_X + MAT_W);
    let displayY = map(cube.y, 142, 358, MAT_Y, MAT_Y + MAT_H);
    const cubeSize = 36;
 
    push();
    translate(displayX, displayY);
    if (typeof cube.angle === "number") rotate(cube.angle);
    rectMode(CENTER);
    stroke(0);
    strokeWeight(2);
    fill(`white`);
    rect(0, 0, cubeSize, cubeSize, 1);
    fill(COLOR_MAIN);
    noStroke();
    rect(cubeSize / 3, 0, cubeSize / 4, cubeSize / 4);
    fill(`black`);
    if (typeof cube.angle === "number") rotate(-cube.angle);
    textAlign(CENTER, CENTER);
    textSize(10);
    text(i + 1, 0, 0);
    pop();

    fill(0);
    noStroke();
    textAlign(CENTER, CENTER);
    textSize(10);
    let angleString = "---";
    if (typeof cube.angle === "number" && !isNaN(cube.angle)) {
      let angleDeg = ((cube.angle * 180) / PI) % 360;
      angleString = nf(angleDeg, 1, 2) + "°";
    }
    text(
      `Cube ${i + 1}\nX: ${cube.x}, Y: ${cube.y}\n∠ ${angleString}`,
      displayX,
      displayY + 45
    );
  }
}
 
function keyPressed() {
  if (key === "f" || key === "F") toggleFullscreen();
  const cube = cubes[0];
  const s = 30, d = 25;
  if (!cube) return;
  switch (keyCode) {
    case UP_ARROW:    cube.move( s,  s, d); break;
    case DOWN_ARROW:  cube.move(-s, -s, d); break;
    case LEFT_ARROW:  cube.move(-s,  s, d); break;
    case RIGHT_ARROW: cube.move( s, -s, d); break;
  }
  if (key === "m" || key === "M") {
    const randX = floor(random(100)) - 50 + targetMat.centerX;
    const randY = floor(random(100)) - 50 + targetMat.centerY;
    cube.moveTo({ x: randX, y: randY }, 80);
  }
}
