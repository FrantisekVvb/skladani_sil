const svg = document.querySelector("svg.tile");
const plus = document.getElementById("plus");
const objectHit = document.getElementById("object-hit");
const objectWrap = document.getElementById("object-wrap");
const startBtn = document.getElementById("start-btn");
const resetBtn = document.getElementById("reset-btn");
const resultantBtn = document.getElementById("resultant-btn");
const snap90Btn = document.getElementById("snap90-btn");

if (!svg || !plus || !objectHit || !objectWrap || !startBtn || !resetBtn || !resultantBtn || !snap90Btn) {
  throw new Error("Missing required elements.");
}

const MAX_ARROWS = 5;
const OBJECT_MASS = 1;
const ACCEL_SCALE = 3;
const FORCE_STEP = 1;
const MIN_FORCE = 1;
const RESULTANT_ZERO_THRESHOLD = 0.5;
const CONSTRUCTION_STEP_MS = 750;
const RESULTANT_COLOR = "#FF184A";
const CIRCLE_R = 25.4297;
const JET_NOZZLE_RIGHT = 156;
const JET_HEIGHT = 72;
const JET_WIDTH = 160;
const JET_SCALE_MIN = 0.09;
const JET_SCALE_LINEAR_FACTOR = 0.0055;
const JET_SCALE_LOG_FACTOR = 0.05;
const JET_SCALE_LOG_WEIGHT = 0.75;
const arrows = [];

let drag = null;
let animating = false;
let constructionAnimating = false;
let animationFrameId = null;
let constructionGroup = null;
let position = { x: 0, y: 0 };
let velocity = { x: 0, y: 0 };
let simulationForce = { fx: 0, fy: 0 };
let lastFrameTime = null;
let snap90Active = false;
let resultantVisible = false;
let jetMotorTemplate = null;
let jetMotorCounter = 0;

function clientToSvgPoint(clientX, clientY) {
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const p = pt.matrixTransform(ctm.inverse());
  return { x: p.x, y: p.y };
}

function getPlusCenter() {
  const b = plus.getBBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function getArrowOrigin() {
  return getPlusCenter();
}

async function loadJetMotorTemplate() {
  const response = await fetch("assets/tryskovy-motor.svg");
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  jetMotorTemplate = doc.documentElement;
}

function createJetMotorGraphic(uniqueId) {
  const nested = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  nested.setAttribute("width", String(JET_WIDTH));
  nested.setAttribute("height", String(JET_HEIGHT));
  nested.setAttribute("viewBox", "0 0 160 72");
  nested.setAttribute("fill", "none");
  nested.setAttribute("overflow", "visible");

  for (const child of jetMotorTemplate.children) {
    nested.appendChild(document.importNode(child, true));
  }

  const outer = nested.querySelector("#jet-outer");
  const inner = nested.querySelector("#jet-inner");
  if (outer) outer.id = `jet-outer-${uniqueId}`;
  if (inner) inner.id = `jet-inner-${uniqueId}`;

  nested.querySelectorAll('[fill="url(#jet-outer)"]').forEach((node) => {
    node.setAttribute("fill", `url(#jet-outer-${uniqueId})`);
  });
  nested.querySelectorAll('[fill="url(#jet-inner)"]').forEach((node) => {
    node.setAttribute("fill", `url(#jet-inner-${uniqueId})`);
  });

  return nested;
}

function ensureJetMotor(arrow) {
  if (arrow.jetMotor || !jetMotorTemplate) return;

  const uniqueId = ++jetMotorCounter;
  const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
  group.setAttribute("class", "jet-motor");
  group.setAttribute("visibility", "hidden");
  group.setAttribute("aria-hidden", "true");
  group.appendChild(createJetMotorGraphic(uniqueId));
  objectHit.insertBefore(group, plus);
  arrow.jetMotor = group;
}

function getJetScale(magnitude) {
  const linear = JET_SCALE_LINEAR_FACTOR * magnitude;
  const logarithmic = JET_SCALE_LOG_FACTOR * Math.log10(magnitude);
  return (
    JET_SCALE_MIN +
    (1 - JET_SCALE_LOG_WEIGHT) * linear +
    JET_SCALE_LOG_WEIGHT * logarithmic
  );
}

function updateJetMotor(arrow) {
  if (!arrow.force || !animating) {
    if (arrow.jetMotor) arrow.jetMotor.setAttribute("visibility", "hidden");
    return;
  }

  ensureJetMotor(arrow);
  if (!arrow.jetMotor) return;

  const angle = Math.atan2(arrow.force.dy, arrow.force.dx);
  const origin = getArrowOrigin();
  const mountX = origin.x - Math.cos(angle) * CIRCLE_R;
  const mountY = origin.y - Math.sin(angle) * CIRCLE_R;
  const deg = (angle * 180) / Math.PI;
  const scale = getJetScale(arrow.force.magnitude);

  arrow.jetMotor.setAttribute("visibility", "visible");
  arrow.jetMotor.classList.toggle("is-active", animating);
  arrow.jetMotor.setAttribute(
    "transform",
    `translate(${mountX} ${mountY}) rotate(${deg}) scale(${scale}) translate(${-JET_NOZZLE_RIGHT} ${-JET_HEIGHT / 2})`
  );
}

function syncJetMotors() {
  for (const arrow of arrows) {
    updateJetMotor(arrow);
  }
}

function formatForce(newtons) {
  return `${Math.round(newtons)} N`;
}

function snapForceLength(len) {
  const snapped = Math.round(len / FORCE_STEP) * FORCE_STEP;
  if (snapped < MIN_FORCE) return 0;
  return snapped;
}

function snapTipToAxis(fromX, fromY, toX, toY) {
  if (!snap90Active) return { toX, toY };

  const dx = toX - fromX;
  const dy = toY - fromY;

  if (Math.abs(dx) >= Math.abs(dy)) {
    return { toX, toY: fromY };
  }

  return { toX: fromX, toY };
}

function getForceLabelLayout(tipX, tipY, angle) {
  const headLen = 8;
  const labelGap = 10;
  const labelOffset = headLen + labelGap;
  let labelX = tipX + Math.cos(angle) * labelOffset;
  let labelY = tipY + Math.sin(angle) * labelOffset;
  let labelAngle = (angle * 180) / Math.PI;
  let textAnchor = "start";

  if (labelAngle > 90 || labelAngle < -90) {
    labelAngle += 180;
    textAnchor = "end";
  }

  const absDeg = Math.abs((angle * 180) / Math.PI);
  const perpOffset = 8;
  const nearHorizontal = absDeg < 20 || absDeg > 160;
  const nearVertical = absDeg > 70 && absDeg < 110;

  if (nearHorizontal) {
    labelY -= perpOffset;
  } else if (nearVertical) {
    labelX += perpOffset;
  }

  return { labelX, labelY, labelAngle, textAnchor };
}

function applyForceLabel(label, tipX, tipY, angle, magnitude) {
  const { labelX, labelY, labelAngle, textAnchor } = getForceLabelLayout(
    tipX,
    tipY,
    angle
  );

  label.setAttribute("x", String(labelX));
  label.setAttribute("y", String(labelY));
  label.setAttribute("text-anchor", textAnchor);
  label.setAttribute("dominant-baseline", "middle");
  label.setAttribute("transform", `rotate(${labelAngle} ${labelX} ${labelY})`);
  label.textContent = formatForce(magnitude);
}

function updateArrow(arrow, fromX, fromY, toX, toY) {
  const snappedTip = snapTipToAxis(fromX, fromY, toX, toY);
  toX = snappedTip.toX;
  toY = snappedTip.toY;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  const snappedLen = snapForceLength(len);

  if (snappedLen === 0) {
    arrow.group.setAttribute("display", "none");
    arrow.label.setAttribute("display", "none");
    arrow.force = null;
    updateJetMotor(arrow);
    syncResultantIfVisible();
    return false;
  }

  const angle = Math.atan2(dy, dx);
  const tipX = fromX + Math.cos(angle) * snappedLen;
  const tipY = fromY + Math.sin(angle) * snappedLen;
  const forceDx = Math.cos(angle) * snappedLen;
  const forceDy = Math.sin(angle) * snappedLen;

  arrow.group.removeAttribute("display");

  arrow.line.setAttribute("x1", String(fromX));
  arrow.line.setAttribute("y1", String(fromY));
  arrow.line.setAttribute("x2", String(tipX));
  arrow.line.setAttribute("y2", String(tipY));

  const headLen = 8;
  const headAngle = Math.PI / 7;

  const a1 = angle + Math.PI - headAngle;
  const a2 = angle + Math.PI + headAngle;
  const x1 = tipX + Math.cos(a1) * headLen;
  const y1 = tipY + Math.sin(a1) * headLen;
  const x2 = tipX + Math.cos(a2) * headLen;
  const y2 = tipY + Math.sin(a2) * headLen;

  arrow.headA.setAttribute("x1", String(tipX));
  arrow.headA.setAttribute("y1", String(tipY));
  arrow.headA.setAttribute("x2", String(x1));
  arrow.headA.setAttribute("y2", String(y1));

  arrow.headB.setAttribute("x1", String(tipX));
  arrow.headB.setAttribute("y1", String(tipY));
  arrow.headB.setAttribute("x2", String(x2));
  arrow.headB.setAttribute("y2", String(y2));

  arrow.tipHandle.setAttribute("cx", String(tipX));
  arrow.tipHandle.setAttribute("cy", String(tipY));
  arrow.tipHandle.removeAttribute("display");

  applyForceLabel(arrow.label, tipX, tipY, angle, snappedLen);
  arrow.label.removeAttribute("display");
  svg.appendChild(arrow.label);

  arrow.force = { dx: forceDx, dy: forceDy, magnitude: snappedLen };
  updateJetMotor(arrow);
  syncResultantIfVisible();
  return true;
}

function createArrow() {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("class", "force-arrow");
  g.setAttribute("fill", "none");
  g.setAttribute("stroke", "#00805B");
  g.setAttribute("stroke-width", "2.5");
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");
  g.setAttribute("aria-hidden", "true");

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  const headA = document.createElementNS("http://www.w3.org/2000/svg", "line");
  const headB = document.createElementNS("http://www.w3.org/2000/svg", "line");
  const tipHandle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  tipHandle.setAttribute("class", "arrow-tip-handle");
  tipHandle.setAttribute("r", "10");
  tipHandle.setAttribute("fill", "transparent");
  tipHandle.setAttribute("stroke", "none");
  const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
  label.setAttribute("class", "force-label");
  label.setAttribute("stroke", "none");

  g.appendChild(line);
  g.appendChild(headA);
  g.appendChild(headB);
  g.appendChild(tipHandle);
  svg.appendChild(g);
  svg.appendChild(label);

  tipHandle.addEventListener("pointerdown", onTipPointerDown);
  tipHandle.addEventListener("pointermove", onPointerMove);
  tipHandle.addEventListener("pointerup", endDrag);
  tipHandle.addEventListener("pointercancel", endDrag);

  return { group: g, line, headA, headB, tipHandle, label, jetMotor: null, force: null };
}

function removeArrow(arrow) {
  arrow.group.remove();
  arrow.label.remove();
  if (arrow.jetMotor) arrow.jetMotor.remove();
  const index = arrows.indexOf(arrow);
  if (index >= 0) arrows.splice(index, 1);
  syncResultantIfVisible();
  updateButtons();
}

function getForceVectors() {
  return arrows
    .filter((arrow) => arrow.force)
    .map((arrow) => ({ dx: arrow.force.dx, dy: arrow.force.dy }));
}

function shouldSkipParallelogramAnimation(forces) {
  if (!snap90Active || forces.length === 0) return false;

  const allHorizontal = forces.every((force) => Math.abs(force.dy) < 0.01);
  const allVertical = forces.every((force) => Math.abs(force.dx) < 0.01);

  return allHorizontal || allVertical;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearConstructionOnly() {
  if (constructionGroup) {
    constructionGroup.remove();
    constructionGroup = null;
  }
}

function clearConstruction() {
  clearConstructionOnly();
  constructionAnimating = false;
  resultantVisible = false;
}

function ensureConstructionGroup() {
  if (constructionGroup) return constructionGroup;

  constructionGroup = document.createElementNS("http://www.w3.org/2000/svg", "g");
  constructionGroup.setAttribute("id", "force-construction");
  constructionGroup.setAttribute("class", "force-construction");
  svg.appendChild(constructionGroup);
  return constructionGroup;
}

function createConstructionLine(x1, y1, x2, y2, dashed = true) {
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  line.setAttribute("stroke", "#FF8158");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("fill", "none");
  if (dashed) line.setAttribute("stroke-dasharray", "6 4");
  ensureConstructionGroup().appendChild(line);
  return line;
}

function animateLineGrow(line, duration) {
  const x1 = Number(line.getAttribute("x1"));
  const y1 = Number(line.getAttribute("y1"));
  const x2 = Number(line.getAttribute("x2"));
  const y2 = Number(line.getAttribute("y2"));
  const length = Math.hypot(x2 - x1, y2 - y1);
  if (length === 0) return Promise.resolve();

  const dash = line.getAttribute("stroke-dasharray");
  line.setAttribute("stroke-dasharray", String(length));
  line.setAttribute("stroke-dashoffset", String(length));

  return new Promise((resolve) => {
    const start = performance.now();

    function frame(now) {
      const progress = Math.min(1, (now - start) / duration);
      line.setAttribute("stroke-dashoffset", String(length * (1 - progress)));

      if (progress < 1) {
        requestAnimationFrame(frame);
        return;
      }

      if (dash) line.setAttribute("stroke-dasharray", dash);
      else line.removeAttribute("stroke-dasharray");
      line.removeAttribute("stroke-dashoffset");
      resolve();
    }

    requestAnimationFrame(frame);
  });
}

function addOpenArrowHead(group, tipX, tipY, angle, color, strokeWidth = 2.5) {
  const headLen = 8;
  const headAngle = Math.PI / 7;
  const a1 = angle + Math.PI - headAngle;
  const a2 = angle + Math.PI + headAngle;

  const headA = document.createElementNS("http://www.w3.org/2000/svg", "line");
  const headB = document.createElementNS("http://www.w3.org/2000/svg", "line");

  for (const head of [headA, headB]) {
    head.setAttribute("stroke", color);
    head.setAttribute("stroke-width", String(strokeWidth));
    head.setAttribute("stroke-linecap", "round");
    head.setAttribute("fill", "none");
    group.appendChild(head);
  }

  headA.setAttribute("x1", String(tipX));
  headA.setAttribute("y1", String(tipY));
  headA.setAttribute("x2", String(tipX + Math.cos(a1) * headLen));
  headA.setAttribute("y2", String(tipY + Math.sin(a1) * headLen));

  headB.setAttribute("x1", String(tipX));
  headB.setAttribute("y1", String(tipY));
  headB.setAttribute("x2", String(tipX + Math.cos(a2) * headLen));
  headB.setAttribute("y2", String(tipY + Math.sin(a2) * headLen));

  return [headA, headB];
}

function positionResultantLabel(label, tipX, tipY, angle, magnitude) {
  applyForceLabel(label, tipX, tipY, angle, magnitude);
}

function renderResultantArrow(origin, partialX, partialY) {
  const { fx, fy, magnitude } = applyResultantThreshold(partialX, partialY);
  const resultantEnd = {
    x: origin.x + fx,
    y: origin.y + fy,
  };
  const angle = Math.atan2(fy, fx);
  const group = ensureConstructionGroup();
  const resultantLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  resultantLine.setAttribute("class", "resultant-arrow");
  resultantLine.setAttribute("x1", String(origin.x));
  resultantLine.setAttribute("y1", String(origin.y));
  resultantLine.setAttribute("x2", String(resultantEnd.x));
  resultantLine.setAttribute("y2", String(resultantEnd.y));
  resultantLine.setAttribute("stroke", RESULTANT_COLOR);
  resultantLine.setAttribute("stroke-width", "3");
  resultantLine.setAttribute("stroke-linecap", "round");
  resultantLine.setAttribute("fill", "none");
  group.appendChild(resultantLine);

  addOpenArrowHead(
    group,
    resultantEnd.x,
    resultantEnd.y,
    angle,
    RESULTANT_COLOR,
    3
  );

  const resultantLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  resultantLabel.setAttribute("class", "resultant-label");
  resultantLabel.setAttribute("stroke", "none");
  positionResultantLabel(
    resultantLabel,
    resultantEnd.x,
    resultantEnd.y,
    angle,
    magnitude
  );
  group.appendChild(resultantLabel);
}

function renderParallelogramLines(origin, forces) {
  let partialX = 0;
  let partialY = 0;

  for (let i = 0; i < forces.length; i++) {
    const force = forces[i];
    const start = {
      x: origin.x + partialX,
      y: origin.y + partialY,
    };
    const end = {
      x: start.x + force.dx,
      y: start.y + force.dy,
    };

    if (i > 0) {
      const parallelStart = {
        x: origin.x + force.dx,
        y: origin.y + force.dy,
      };
      createConstructionLine(start.x, start.y, end.x, end.y, true);
      createConstructionLine(
        parallelStart.x,
        parallelStart.y,
        end.x,
        end.y,
        true
      );
    }

    partialX += force.dx;
    partialY += force.dy;
  }

  return { partialX, partialY };
}

function renderResultantConstruction() {
  const forces = getForceVectors();
  clearConstructionOnly();

  if (forces.length === 0) {
    resultantVisible = false;
    return;
  }

  const origin = getArrowOrigin();
  const skipParallelogram = shouldSkipParallelogramAnimation(forces);
  let partialX = 0;
  let partialY = 0;

  if (!skipParallelogram) {
    ({ partialX, partialY } = renderParallelogramLines(origin, forces));
  } else {
    for (const force of forces) {
      partialX += force.dx;
      partialY += force.dy;
    }
  }

  renderResultantArrow(origin, partialX, partialY);
  resultantVisible = true;
}

function syncResultantIfVisible() {
  if (!resultantVisible || constructionAnimating || animating) return;
  renderResultantConstruction();
}

async function drawResultantArrow(origin, partialX, partialY, animate = true) {
  const { fx, fy, magnitude } = applyResultantThreshold(partialX, partialY);
  const resultantEnd = {
    x: origin.x + fx,
    y: origin.y + fy,
  };
  const angle = Math.atan2(fy, fx);
  const group = ensureConstructionGroup();
  const resultantLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
  resultantLine.setAttribute("class", "resultant-arrow");
  resultantLine.setAttribute("x1", String(origin.x));
  resultantLine.setAttribute("y1", String(origin.y));
  resultantLine.setAttribute("x2", String(resultantEnd.x));
  resultantLine.setAttribute("y2", String(resultantEnd.y));
  resultantLine.setAttribute("stroke", RESULTANT_COLOR);
  resultantLine.setAttribute("stroke-width", "3");
  resultantLine.setAttribute("stroke-linecap", "round");
  resultantLine.setAttribute("fill", "none");
  group.appendChild(resultantLine);

  if (animate) {
    await animateLineGrow(resultantLine, CONSTRUCTION_STEP_MS);
  }

  addOpenArrowHead(
    group,
    resultantEnd.x,
    resultantEnd.y,
    angle,
    RESULTANT_COLOR,
    3
  );

  const resultantLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  resultantLabel.setAttribute("class", "resultant-label");
  resultantLabel.setAttribute("stroke", "none");
  positionResultantLabel(
    resultantLabel,
    resultantEnd.x,
    resultantEnd.y,
    angle,
    magnitude
  );
  group.appendChild(resultantLabel);
}

async function animateResultantConstruction() {
  const forces = getForceVectors();
  if (constructionAnimating || animating || forces.length === 0) return;

  clearConstruction();
  constructionAnimating = true;
  updateButtons();

  const origin = getArrowOrigin();
  const skipParallelogram = shouldSkipParallelogramAnimation(forces);
  let partialX = 0;
  let partialY = 0;

  if (!skipParallelogram) {
    for (let i = 0; i < forces.length; i++) {
      const force = forces[i];
      const start = {
        x: origin.x + partialX,
        y: origin.y + partialY,
      };
      const end = {
        x: start.x + force.dx,
        y: start.y + force.dy,
      };

      if (i > 0) {
        const parallelStart = {
          x: origin.x + force.dx,
          y: origin.y + force.dy,
        };
        const translated = createConstructionLine(
          start.x,
          start.y,
          end.x,
          end.y,
          true
        );
        await animateLineGrow(translated, CONSTRUCTION_STEP_MS);
        await sleep(120);

        const parallel = createConstructionLine(
          parallelStart.x,
          parallelStart.y,
          end.x,
          end.y,
          true
        );
        await animateLineGrow(parallel, CONSTRUCTION_STEP_MS);
        await sleep(180);
      }

      partialX += force.dx;
      partialY += force.dy;
    }
  } else {
    for (const force of forces) {
      partialX += force.dx;
      partialY += force.dy;
    }
  }

  await drawResultantArrow(origin, partialX, partialY, !skipParallelogram);

  resultantVisible = true;
  constructionAnimating = false;
  updateButtons();
}

function toggleResultantConstruction() {
  if (constructionAnimating || animating) return;

  if (resultantVisible) {
    clearConstruction();
    updateButtons();
    return;
  }

  animateResultantConstruction();
}

function applyResultantThreshold(fx, fy) {
  const magnitude = Math.hypot(fx, fy);
  if (magnitude < RESULTANT_ZERO_THRESHOLD) {
    return { fx: 0, fy: 0, magnitude: 0 };
  }
  return { fx, fy, magnitude };
}

function getResultantForce() {
  let fx = 0;
  let fy = 0;

  for (const arrow of arrows) {
    if (!arrow.force) continue;
    fx += arrow.force.dx;
    fy += arrow.force.dy;
  }

  return applyResultantThreshold(fx, fy);
}

function updateButtons() {
  const interactionLocked = animating || constructionAnimating;
  startBtn.disabled = interactionLocked || arrows.length === 0;
  resultantBtn.disabled = interactionLocked || arrows.length === 0;
  snap90Btn.disabled = animating;
  resultantBtn.classList.toggle("is-active", resultantVisible);
  resultantBtn.setAttribute("aria-pressed", String(resultantVisible));
}

function clearArrows() {
  for (const arrow of arrows) {
    arrow.group.remove();
    arrow.label.remove();
    if (arrow.jetMotor) arrow.jetMotor.remove();
  }
  arrows.length = 0;
}

function stopAnimation() {
  animating = false;
  lastFrameTime = null;
  syncJetMotors();
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
}

function applyPosition() {
  objectWrap.style.transform = `translate(${position.x}px, ${position.y}px)`;
}

function snapExistingArrowsToAxis() {
  const origin = getArrowOrigin();

  for (const arrow of arrows) {
    if (!arrow.force) continue;

    const { dx, dy, magnitude } = arrow.force;
    let toX;
    let toY;

    if (Math.abs(dx) >= Math.abs(dy)) {
      toX = origin.x + Math.sign(dx || 1) * magnitude;
      toY = origin.y;
    } else {
      toX = origin.x;
      toY = origin.y + Math.sign(dy || 1) * magnitude;
    }

    updateArrow(arrow, origin.x, origin.y, toX, toY);
  }

  syncResultantIfVisible();
  updateButtons();
}

function toggleSnap90() {
  if (animating) return;

  snap90Active = !snap90Active;
  snap90Btn.classList.toggle("is-active", snap90Active);
  snap90Btn.setAttribute("aria-pressed", String(snap90Active));

  if (snap90Active) {
    snapExistingArrowsToAxis();
  }
}

function resetSimulation() {
  stopAnimation();

  if (drag) {
    const target =
      drag.mode === "create" ? objectHit : drag.handle;
    try {
      target.releasePointerCapture(drag.pointerId);
    } catch {
      // ignore
    }
    objectHit.classList.remove("is-dragging");
    if (drag.handle) drag.handle.classList.remove("is-dragging");
    drag = null;
  }

  clearConstruction();
  clearArrows();
  position = { x: 0, y: 0 };
  velocity = { x: 0, y: 0 };
  simulationForce = { fx: 0, fy: 0 };
  lastFrameTime = null;
  snap90Active = false;
  snap90Btn.classList.remove("is-active");
  snap90Btn.setAttribute("aria-pressed", "false");
  applyPosition();
  updateButtons();
}

function startSimulation() {
  const { fx, fy } = getResultantForce();
  if (animating || constructionAnimating) return;

  animating = true;
  simulationForce = { fx, fy };
  velocity = { x: 0, y: 0 };
  lastFrameTime = null;
  syncJetMotors();
  updateButtons();

  function step(now) {
    if (!animating) return;

    if (lastFrameTime === null) {
      lastFrameTime = now;
      animationFrameId = requestAnimationFrame(step);
      return;
    }

    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    const ax = (simulationForce.fx / OBJECT_MASS) * ACCEL_SCALE;
    const ay = (simulationForce.fy / OBJECT_MASS) * ACCEL_SCALE;

    velocity.x += ax * dt;
    velocity.y += ay * dt;
    position.x += velocity.x * dt;
    position.y += velocity.y * dt;
    applyPosition();

    animationFrameId = requestAnimationFrame(step);
  }

  animationFrameId = requestAnimationFrame(step);
}

function onPointerDown(e) {
  if (e.button !== 0 || animating || constructionAnimating) return;
  if (arrows.length >= MAX_ARROWS) return;

  e.preventDefault();

  objectHit.setPointerCapture(e.pointerId);
  objectHit.classList.add("is-dragging");

  const arrow = createArrow();
  arrows.push(arrow);
  updateButtons();

  const origin = getArrowOrigin();
  drag = {
    mode: "create",
    pointerId: e.pointerId,
    arrow,
    handle: null,
  };

  const p = clientToSvgPoint(e.clientX, e.clientY);
  updateArrow(arrow, origin.x, origin.y, p.x, p.y);
}

function onTipPointerDown(e) {
  if (e.button !== 0 || animating || constructionAnimating) return;

  e.preventDefault();
  e.stopPropagation();

  const handle = e.currentTarget;
  const arrow = arrows.find((item) => item.tipHandle === handle);
  if (!arrow) return;

  handle.setPointerCapture(e.pointerId);
  handle.classList.add("is-dragging");

  drag = {
    mode: "tip",
    pointerId: e.pointerId,
    arrow,
    handle,
  };

  const origin = getArrowOrigin();
  const p = clientToSvgPoint(e.clientX, e.clientY);
  updateArrow(arrow, origin.x, origin.y, p.x, p.y);
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();

  const p = clientToSvgPoint(e.clientX, e.clientY);
  const origin = getArrowOrigin();
  updateArrow(drag.arrow, origin.x, origin.y, p.x, p.y);
  updateButtons();
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();

  const target = drag.mode === "create" ? objectHit : drag.handle;
  try {
    target.releasePointerCapture(e.pointerId);
  } catch {
    // ignore
  }

  objectHit.classList.remove("is-dragging");
  if (drag.handle) drag.handle.classList.remove("is-dragging");

  const p = clientToSvgPoint(e.clientX, e.clientY);
  const origin = getArrowOrigin();
  const visible = updateArrow(drag.arrow, origin.x, origin.y, p.x, p.y);
  if (!visible) removeArrow(drag.arrow);

  drag = null;
  updateButtons();
}

objectHit.addEventListener("pointerdown", onPointerDown);
objectHit.addEventListener("pointermove", onPointerMove);
objectHit.addEventListener("pointerup", endDrag);
objectHit.addEventListener("pointercancel", endDrag);
startBtn.addEventListener("click", startSimulation);
resultantBtn.addEventListener("click", toggleResultantConstruction);
snap90Btn.addEventListener("click", toggleSnap90);
resetBtn.addEventListener("click", resetSimulation);

loadJetMotorTemplate().then(() => {
  syncJetMotors();
});

updateButtons();
