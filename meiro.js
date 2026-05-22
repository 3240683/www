
Thanks to p5.toio https://tetunori.github.io/p5.toio/ */

const cubes = [];
const targetMat = P5tId.SimpleTileMat; //使うマットを設定

let connectBtn; //接続ボタン
let fsBtn; //全画面表示ボタン

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

function draw() {
  //メインループ
  background(240, 252, 257); //水色
  let scaleFactor = min(width / BASE_W, height / BASE_H);
  push(); //pushで別座標系(マット)に一時的に移動・描画してpopで元座標系に戻る
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
}

function drawMat() {
  //マットの表示

  fill(`white`);
  stroke(150);
  strokeWeight(1);
  rect(MAT_X, MAT_Y, MAT_W, MAT_H);
  stroke(COLOR_MAIN);
  strokeWeight(1);

  if (targetMat === P5tId.SimpleTileMat) {
    //簡易マットの場合はマスの線を引く
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
  //キューブの位置表示（複数対応）

  for (let i = 0; i < cubes.length; i++) {
    let cube = cubes[i];
    if (typeof cube.x !== "number" || typeof cube.y !== "number") continue;
    let displayX = map(cube.x, 98, 402, MAT_X, MAT_X + MAT_W);
    let displayY = map(cube.y, 142, 358, MAT_Y, MAT_Y + MAT_H);
    const cubeSize = 36;

    push();
    translate(displayX, displayY);
    if (typeof cube.angle === "number") {
      rotate(cube.angle);
    }

    rectMode(CENTER);
    stroke(0);
    strokeWeight(2);
    fill(`white`);
    rect(0, 0, cubeSize, cubeSize, 1);
    fill(COLOR_MAIN);
    noStroke();
    rect(cubeSize / 3, 0, cubeSize / 4, cubeSize / 4);
    fill(`black`);
    if (typeof cube.angle === "number") {
      rotate(-cube.angle);
    }

    textAlign(CENTER, CENTER);
    textSize(10);
    text(i + 1, 0, 0);
    pop();
    fill(0);
    noStroke();
    textAlign(CENTER, CENTER);
    textSize(10);

    // 角度の計算と表示

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
  //キーボード操作
  if (key === "f" || key === "F") toggleFullscreen();
  const cube = cubes[0]; //最初に接続されたキューブのみ操作対象にする
  const s = 30,
    d = 25;
  if (!cube) return;
  
  switch (keyCode) {
    case UP_ARROW:
      cube.move(s, s, d);
      break;
    case DOWN_ARROW:
      cube.move(-s, -s, d);
      break;
    case LEFT_ARROW:
      cube.move(-s, s, d);
      break;
    case RIGHT_ARROW:
      cube.move(s, -s, d);
      break;
  }

  if (key === "m" || key === "M") {
    //Mキーでランダムな位置に動く
    const randX = floor(random(100)) - 50 + targetMat.centerX; //中心±50の乱数
    const randY = floor(random(100)) - 50 + targetMat.centerY; //中心±50の乱数
    cube.moveTo({ x: randX, y: randY }, 80);
    //cube.moveTo({x:targetMat.centerX,y:targetMat.centerY}, 80);
  }
}
