const SVG_NS = "http://www.w3.org/2000/svg";
const objectsStage = document.getElementById("objects-stage");
const startBtn = document.getElementById("start-btn");
const resetBtn = document.getElementById("reset-btn");
const resultantBtn = document.getElementById("resultant-btn");
const snap90Btn = document.getElementById("snap90-btn");
const circlesToggleBtn = document.getElementById("circles-toggle-btn");
const forceKeypadOverlay = document.getElementById("force-keypad-overlay");
const forceKeypadDisplay = document.getElementById("force-keypad-display");
const forceKeypadClose = document.getElementById("force-keypad-close");
const forceKeypadConfirm = document.getElementById("force-keypad-confirm");
const forceKeypadKeys = document.querySelectorAll("#force-math-keypad .math-keypad__key");

if (
  !objectsStage ||
  !startBtn ||
  !resetBtn ||
  !resultantBtn ||
  !snap90Btn ||
  !circlesToggleBtn ||
  !forceKeypadOverlay ||
  !forceKeypadDisplay ||
  !forceKeypadClose ||
  !forceKeypadConfirm
) {
  throw new Error("Missing required elements.");
}

const MAX_ARROWS = 5;
const MAX_FORCE_DIGITS = 3;
const SECOND_OBJECT_OFFSET = { x: 0, y: 100 };
const OBJECT_MASS = 1;
const ACCEL_SCALE = 3;
const FORCE_STEP = 1;
const MIN_FORCE = 1;
const TIP_HANDLE_RADIUS = 20;
const TIP_DRAG_THRESHOLD = 2;
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

const objects = [];

let drag = null;
let animating = false;
let constructionAnimating = false;
let animationFrameId = null;
let lastFrameTime = null;
let snap90Active = false;
let twoCirclesActive = false;
let resultantVisible = false;
let forceEdit = null;
let jetMotorTemplate = null;
let jetMotorCounter = 0;

function clientToSvgPoint(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  const viewBox = svg.viewBox.baseVal;
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };

  return {
    x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
    y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
  };
}

function isPrimaryPointerDown(e) {
  return e.pointerType !== "mouse" || e.button === 0;
}

function findArrowByTipPoint(clientX, clientY) {
  let bestMatch = null;
  let bestDistance = TIP_HANDLE_RADIUS;

  for (const obj of objects) {
    const p = clientToSvgPoint(obj.svg, clientX, clientY);

    for (const arrow of obj.arrows) {
      if (!arrow.force || arrow.tipHandle.getAttribute("display") === "none") continue;

      const tipX = Number(arrow.tipHandle.getAttribute("cx"));
      const tipY = Number(arrow.tipHandle.getAttribute("cy"));
      const distance = Math.hypot(p.x - tipX, p.y - tipY);

      if (distance <= bestDistance) {
        bestMatch = { obj, arrow };
        bestDistance = distance;
      }
    }
  }

  return bestMatch;
}

function beginPointerCapture(svg, e) {
  if (typeof svg.setPointerCapture === "function") {
    svg.setPointerCapture(e.pointerId);
  }
}

function shouldUpdateTipDrag(dragState, x, y) {
  if (dragState.hasMoved) return true;

  const moved =
    Math.hypot(x - dragState.startX, y - dragState.startY) >= TIP_DRAG_THRESHOLD;
  if (moved) dragState.hasMoved = true;
  return moved;
}

function releasePointerCaptureSafe(svg, pointerId) {
  if (typeof svg.releasePointerCapture !== "function") return;

  try {
    svg.releasePointerCapture(pointerId);
  } catch {
    // ignore
  }
}

function getPlusCenter(plus) {
  const b = plus.getBBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function getArrowOrigin(obj) {
  return getPlusCenter(obj.plus);
}

function applyPosition(obj) {
  const x = obj.baseOffset.x + obj.position.x;
  const y = obj.baseOffset.y + obj.position.y;
  obj.wrap.style.transform = `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`;
}

function createObjectSvg() {
  const svgEl = document.createElementNS(SVG_NS, "svg");
  svgEl.setAttribute("class", "tile");
  svgEl.setAttribute("width", "75");
  svgEl.setAttribute("height", "51");
  svgEl.setAttribute("viewBox", "0 0 75 51");
  svgEl.setAttribute("fill", "none");
  svgEl.setAttribute("aria-label", "Objekt");
  svgEl.setAttribute("role", "img");

  const hit = document.createElementNS(SVG_NS, "g");
  hit.setAttribute("class", "object-hit");

  const circle = document.createElementNS(SVG_NS, "circle");
  circle.setAttribute("cx", "37.0547");
  circle.setAttribute("cy", "25.4297");
  circle.setAttribute("r", "25.4297");
  circle.setAttribute("fill", "#803B50");

  const plus = document.createElementNS(SVG_NS, "g");
  plus.setAttribute("class", "plus");
  plus.setAttribute("fill", "#000000");
  plus.setAttribute("aria-hidden", "true");

  const rectH = document.createElementNS(SVG_NS, "rect");
  rectH.setAttribute("x", "24.5");
  rectH.setAttribute("y", "23.5");
  rectH.setAttribute("width", "26");
  rectH.setAttribute("height", "4");
  rectH.setAttribute("rx", "2");

  const rectV = document.createElementNS(SVG_NS, "rect");
  rectV.setAttribute("x", "35.5");
  rectV.setAttribute("y", "12.5");
  rectV.setAttribute("width", "4");
  rectV.setAttribute("height", "26");
  rectV.setAttribute("rx", "2");

  plus.appendChild(rectH);
  plus.appendChild(rectV);
  hit.appendChild(circle);
  hit.appendChild(plus);
  svgEl.appendChild(hit);

  return { svg: svgEl, hit, plus };
}

function createObject(baseOffsetX, baseOffsetY) {
  const wrap = document.createElement("div");
  wrap.className = "object-wrap";

  const { svg, hit, plus } = createObjectSvg();
  wrap.appendChild(svg);

  const obj = {
    wrap,
    svg,
    hit,
    plus,
    arrows: [],
    constructionGroup: null,
    baseOffset: { x: baseOffsetX, y: baseOffsetY },
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    simulationForce: { fx: 0, fy: 0 },
  };

  objectsStage.appendChild(wrap);
  objects.push(obj);
  applyPosition(obj);
  bindObjectEvents(obj);
  return obj;
}

function initObjectFromWrap(wrap, baseOffsetX, baseOffsetY) {
  const svg = wrap.querySelector("svg.tile");
  const hit = wrap.querySelector(".object-hit");
  const plus = wrap.querySelector(".plus");

  if (!svg || !hit || !plus) {
    throw new Error("Invalid object wrap.");
  }

  const obj = {
    wrap,
    svg,
    hit,
    plus,
    arrows: [],
    constructionGroup: null,
    baseOffset: { x: baseOffsetX, y: baseOffsetY },
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    simulationForce: { fx: 0, fy: 0 },
  };

  objects.push(obj);
  applyPosition(obj);
  return obj;
}

function bindObjectEvents(obj) {
  obj.hit.addEventListener("pointerdown", (e) => onObjectPointerDown(e, obj));
  obj.svg.addEventListener("pointerdown", (e) => onSvgPointerDown(e, obj));
  obj.svg.addEventListener("pointermove", onPointerMove);
  obj.svg.addEventListener("pointerup", endDrag);
  obj.svg.addEventListener("pointercancel", endDrag);
}

function syncCircleCount() {
  if (twoCirclesActive && objects.length < 2) {
    createObject(SECOND_OBJECT_OFFSET.x, SECOND_OBJECT_OFFSET.y);
    return;
  }

  while (!twoCirclesActive && objects.length > 1) {
    removeObject(objects[objects.length - 1]);
  }
}

function updateCirclesToggleUi() {
  circlesToggleBtn.textContent = twoCirclesActive ? "2 kruhy" : "1 kruh";
  circlesToggleBtn.classList.toggle("is-active", twoCirclesActive);
  circlesToggleBtn.setAttribute("aria-pressed", String(twoCirclesActive));
}

function toggleTwoCircles() {
  if (animating || constructionAnimating) return;

  twoCirclesActive = !twoCirclesActive;
  updateCirclesToggleUi();
  syncCircleCount();
  syncResultantIfVisible();
  updateButtons();
}

async function loadJetMotorTemplate() {
  const response = await fetch("assets/tryskovy-motor.svg");
  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  jetMotorTemplate = doc.documentElement;
}

function createJetMotorGraphic(uniqueId) {
  const nested = document.createElementNS(SVG_NS, "svg");
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

function ensureJetMotor(obj, arrow) {
  if (arrow.jetMotor || !jetMotorTemplate) return;

  const uniqueId = ++jetMotorCounter;
  const group = document.createElementNS(SVG_NS, "g");
  group.setAttribute("class", "jet-motor");
  group.setAttribute("visibility", "hidden");
  group.setAttribute("aria-hidden", "true");
  group.appendChild(createJetMotorGraphic(uniqueId));
  obj.hit.insertBefore(group, obj.plus);
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

function updateJetMotor(obj, arrow) {
  if (!arrow.force || !animating) {
    if (arrow.jetMotor) arrow.jetMotor.setAttribute("visibility", "hidden");
    return;
  }

  ensureJetMotor(obj, arrow);
  if (!arrow.jetMotor) return;

  const angle = Math.atan2(arrow.force.dy, arrow.force.dx);
  const origin = getArrowOrigin(obj);
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
  for (const obj of objects) {
    for (const arrow of obj.arrows) {
      updateJetMotor(obj, arrow);
    }
  }
}

function formatForce(newtons) {
  return `${Math.round(newtons)} N`;
}

function setArrowMagnitude(obj, arrow, magnitude) {
  if (!arrow.force) return;

  const origin = getArrowOrigin(obj);
  const snappedLen = snapForceLength(magnitude);

  if (snappedLen === 0) {
    updateArrow(obj, arrow, origin.x, origin.y, origin.x, origin.y);
    return;
  }

  const angle = Math.atan2(arrow.force.dy, arrow.force.dx);
  const toX = origin.x + Math.cos(angle) * snappedLen;
  const toY = origin.y + Math.sin(angle) * snappedLen;
  updateArrow(obj, arrow, origin.x, origin.y, toX, toY);
}

function isValidForceInput(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= MIN_FORCE;
}

function updateForceKeypadDisplay() {
  if (!forceEdit) return;

  const showInvalid = forceEdit.value !== "" && !isValidForceInput(forceEdit.value);
  forceKeypadDisplay.textContent = forceEdit.value ? `${forceEdit.value} N` : "";
  forceKeypadDisplay.classList.toggle("is-invalid", showInvalid);
}

function openForceKeypad(obj, arrow) {
  if (!arrow.force || animating || constructionAnimating || drag) return;

  forceEdit = {
    obj,
    arrow,
    value: "",
  };

  forceKeypadOverlay.hidden = false;
  updateForceKeypadDisplay();
  updateButtons();
  forceKeypadConfirm.focus();
}

function closeForceKeypad() {
  forceEdit = null;
  forceKeypadOverlay.hidden = true;
  forceKeypadDisplay.classList.remove("is-invalid");
  updateButtons();
}

function insertIntoForceValue(digit) {
  if (!forceEdit) return;
  if (forceEdit.value.length >= MAX_FORCE_DIGITS) return;

  forceEdit.value = forceEdit.value === "0" ? digit : `${forceEdit.value}${digit}`;
  updateForceKeypadDisplay();
}

function backspaceForceValue() {
  if (!forceEdit) return;
  forceEdit.value = forceEdit.value.slice(0, -1);
  updateForceKeypadDisplay();
}

function confirmForceKeypad() {
  if (!forceEdit) return;

  if (!isValidForceInput(forceEdit.value)) {
    forceKeypadDisplay.classList.add("is-invalid");
    return;
  }

  const magnitude = Number.parseInt(forceEdit.value, 10);
  const { obj, arrow } = forceEdit;
  setArrowMagnitude(obj, arrow, magnitude);
  closeForceKeypad();
  updateButtons();
}

function handleForceKeypadClick(event) {
  const key = event.currentTarget;
  const action = key.dataset.action;
  const value = key.dataset.value;

  if (action === "backspace") {
    backspaceForceValue();
    return;
  }

  if (value) {
    insertIntoForceValue(value);
  }
}

function onForceLabelPointerDown(e, obj, arrow) {
  if (!isPrimaryPointerDown(e) || animating || constructionAnimating || drag || forceEdit) return;
  if (!arrow.force) return;

  e.preventDefault();
  e.stopPropagation();
  openForceKeypad(obj, arrow);
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

function applyForceLabel(label, labelHit, tipX, tipY, angle, magnitude) {
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

  if (!labelHit) return;

  const padding = 6;
  const bounds = label.getBBox();
  labelHit.setAttribute("x", String(bounds.x - padding));
  labelHit.setAttribute("y", String(bounds.y - padding));
  labelHit.setAttribute("width", String(bounds.width + padding * 2));
  labelHit.setAttribute("height", String(bounds.height + padding * 2));
}

function updateArrow(obj, arrow, fromX, fromY, toX, toY) {
  const snappedTip = snapTipToAxis(fromX, fromY, toX, toY);
  toX = snappedTip.toX;
  toY = snappedTip.toY;

  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy);
  const snappedLen = snapForceLength(len);

  if (snappedLen === 0) {
    arrow.group.setAttribute("display", "none");
    arrow.labelGroup.setAttribute("display", "none");
    arrow.force = null;
    updateJetMotor(obj, arrow);
    syncResultantIfVisible();
    return false;
  }

  const tipX = toX;
  const tipY = toY;
  const angle = Math.atan2(dy, dx);
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

  arrow.labelGroup.removeAttribute("display");
  obj.svg.appendChild(arrow.labelGroup);
  applyForceLabel(arrow.label, arrow.labelHit, tipX, tipY, angle, snappedLen);

  arrow.force = { dx: forceDx, dy: forceDy, magnitude: snappedLen };
  updateJetMotor(obj, arrow);
  syncResultantIfVisible();
  return true;
}

function createArrow(obj) {
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("class", "force-arrow");
  g.setAttribute("fill", "none");
  g.setAttribute("stroke", "#00805B");
  g.setAttribute("stroke-width", "2.5");
  g.setAttribute("stroke-linecap", "round");
  g.setAttribute("stroke-linejoin", "round");
  g.setAttribute("aria-hidden", "true");

  const line = document.createElementNS(SVG_NS, "line");
  const headA = document.createElementNS(SVG_NS, "line");
  const headB = document.createElementNS(SVG_NS, "line");
  const tipHandle = document.createElementNS(SVG_NS, "circle");
  tipHandle.setAttribute("class", "arrow-tip-handle");
  tipHandle.setAttribute("r", String(TIP_HANDLE_RADIUS));
  tipHandle.setAttribute("fill", "transparent");
  tipHandle.setAttribute("stroke", "none");
  const labelGroup = document.createElementNS(SVG_NS, "g");
  labelGroup.setAttribute("class", "force-label-group");
  labelGroup.setAttribute("display", "none");

  const labelHit = document.createElementNS(SVG_NS, "rect");
  labelHit.setAttribute("class", "force-label-hit");
  labelHit.setAttribute("fill", "transparent");
  labelHit.setAttribute("stroke", "none");

  const label = document.createElementNS(SVG_NS, "text");
  label.setAttribute("class", "force-label");
  label.setAttribute("stroke", "none");

  labelGroup.appendChild(labelHit);
  labelGroup.appendChild(label);

  g.appendChild(line);
  g.appendChild(headA);
  g.appendChild(headB);
  g.appendChild(tipHandle);
  obj.svg.appendChild(g);
  obj.svg.appendChild(labelGroup);

  const arrow = {
    group: g,
    line,
    headA,
    headB,
    tipHandle,
    labelGroup,
    label,
    labelHit,
    jetMotor: null,
    force: null,
    obj,
  };

  labelGroup.addEventListener("pointerdown", (e) => onForceLabelPointerDown(e, obj, arrow));
  tipHandle.addEventListener("pointerdown", (e) => onTipPointerDown(e, obj, arrow));

  return arrow;
}

function removeArrow(obj, arrow) {
  if (forceEdit && forceEdit.arrow === arrow) closeForceKeypad();
  arrow.group.remove();
  arrow.labelGroup.remove();
  if (arrow.jetMotor) arrow.jetMotor.remove();
  const index = obj.arrows.indexOf(arrow);
  if (index >= 0) obj.arrows.splice(index, 1);
  syncResultantIfVisible();
  updateButtons();
}

function getForceVectors(obj) {
  return obj.arrows
    .filter((arrow) => arrow.force)
    .map((arrow) => ({ dx: arrow.force.dx, dy: arrow.force.dy }));
}

function hasAnyArrows() {
  return objects.some((obj) => obj.arrows.length > 0);
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

function clearConstructionOnly(obj) {
  if (obj.constructionGroup) {
    obj.constructionGroup.remove();
    obj.constructionGroup = null;
  }
}

function clearConstruction() {
  for (const obj of objects) {
    clearConstructionOnly(obj);
  }
  constructionAnimating = false;
  resultantVisible = false;
}

function ensureConstructionGroup(obj) {
  if (obj.constructionGroup) return obj.constructionGroup;

  obj.constructionGroup = document.createElementNS(SVG_NS, "g");
  obj.constructionGroup.setAttribute("class", "force-construction");
  obj.svg.appendChild(obj.constructionGroup);
  return obj.constructionGroup;
}

function createConstructionLine(obj, x1, y1, x2, y2, dashed = true) {
  const line = document.createElementNS(SVG_NS, "line");
  line.setAttribute("x1", String(x1));
  line.setAttribute("y1", String(y1));
  line.setAttribute("x2", String(x2));
  line.setAttribute("y2", String(y2));
  line.setAttribute("stroke", "#FF8158");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("fill", "none");
  if (dashed) line.setAttribute("stroke-dasharray", "6 4");
  ensureConstructionGroup(obj).appendChild(line);
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

  const headA = document.createElementNS(SVG_NS, "line");
  const headB = document.createElementNS(SVG_NS, "line");

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
  applyForceLabel(label, null, tipX, tipY, angle, magnitude);
}

function renderResultantArrow(obj, origin, partialX, partialY) {
  const { fx, fy, magnitude } = applyResultantThreshold(partialX, partialY);
  const resultantEnd = {
    x: origin.x + fx,
    y: origin.y + fy,
  };
  const angle = Math.atan2(fy, fx);
  const group = ensureConstructionGroup(obj);
  const resultantLine = document.createElementNS(SVG_NS, "line");
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

  const resultantLabel = document.createElementNS(SVG_NS, "text");
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

function renderParallelogramLines(obj, origin, forces) {
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
      createConstructionLine(obj, start.x, start.y, end.x, end.y, true);
      createConstructionLine(
        obj,
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

function renderResultantConstruction(obj) {
  const forces = getForceVectors(obj);
  clearConstructionOnly(obj);

  if (forces.length === 0) return;

  const origin = getArrowOrigin(obj);
  const skipParallelogram = shouldSkipParallelogramAnimation(forces);
  let partialX = 0;
  let partialY = 0;

  if (!skipParallelogram) {
    ({ partialX, partialY } = renderParallelogramLines(obj, origin, forces));
  } else {
    for (const force of forces) {
      partialX += force.dx;
      partialY += force.dy;
    }
  }

  renderResultantArrow(obj, origin, partialX, partialY);
}

function syncResultantIfVisible() {
  if (!resultantVisible || constructionAnimating || animating) return;

  let anyForces = false;
  for (const obj of objects) {
    const forces = getForceVectors(obj);
    if (forces.length > 0) {
      anyForces = true;
      renderResultantConstruction(obj);
    } else {
      clearConstructionOnly(obj);
    }
  }

  if (!anyForces) resultantVisible = false;
}

async function drawResultantArrow(obj, origin, partialX, partialY, animate = true) {
  const { fx, fy, magnitude } = applyResultantThreshold(partialX, partialY);
  const resultantEnd = {
    x: origin.x + fx,
    y: origin.y + fy,
  };
  const angle = Math.atan2(fy, fx);
  const group = ensureConstructionGroup(obj);
  const resultantLine = document.createElementNS(SVG_NS, "line");
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

  const resultantLabel = document.createElementNS(SVG_NS, "text");
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

async function animateObjectResultantConstruction(obj) {
  const forces = getForceVectors(obj);
  if (forces.length === 0) return;

  clearConstructionOnly(obj);

  const origin = getArrowOrigin(obj);
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
          obj,
          start.x,
          start.y,
          end.x,
          end.y,
          true
        );
        await animateLineGrow(translated, CONSTRUCTION_STEP_MS);
        await sleep(120);

        const parallel = createConstructionLine(
          obj,
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

  await drawResultantArrow(obj, origin, partialX, partialY, !skipParallelogram);
}

async function animateResultantConstruction() {
  const objectsWithForces = objects.filter((obj) => getForceVectors(obj).length > 0);
  if (constructionAnimating || animating || objectsWithForces.length === 0) return;

  clearConstruction();
  constructionAnimating = true;
  updateButtons();

  await Promise.all(
    objectsWithForces.map((obj) => animateObjectResultantConstruction(obj))
  );

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

function getResultantForce(obj) {
  let fx = 0;
  let fy = 0;

  for (const arrow of obj.arrows) {
    if (!arrow.force) continue;
    fx += arrow.force.dx;
    fy += arrow.force.dy;
  }

  return applyResultantThreshold(fx, fy);
}

function updateButtons() {
  const interactionLocked = animating || constructionAnimating || forceEdit !== null;
  startBtn.disabled = interactionLocked || !hasAnyArrows();
  resultantBtn.disabled = interactionLocked || !hasAnyArrows();
  snap90Btn.disabled = animating || forceEdit !== null;
  circlesToggleBtn.disabled = interactionLocked;
  resultantBtn.classList.toggle("is-active", resultantVisible);
  resultantBtn.setAttribute("aria-pressed", String(resultantVisible));
  forceKeypadConfirm.disabled = forceEdit === null;
  forceKeypadKeys.forEach((key) => {
    key.disabled = forceEdit === null;
  });
}

function clearObjectArrows(obj) {
  for (const arrow of obj.arrows) {
    arrow.group.remove();
    arrow.labelGroup.remove();
    if (arrow.jetMotor) arrow.jetMotor.remove();
  }
  obj.arrows.length = 0;
}

function clearArrows() {
  for (const obj of objects) {
    clearObjectArrows(obj);
  }
}

function removeObject(obj) {
  if (objects.length <= 1) return;
  if (forceEdit && forceEdit.obj === obj) closeForceKeypad();

  clearObjectArrows(obj);
  clearConstructionOnly(obj);
  obj.wrap.remove();
  const index = objects.indexOf(obj);
  if (index >= 0) objects.splice(index, 1);
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

function snapExistingArrowsToAxis() {
  for (const obj of objects) {
    const origin = getArrowOrigin(obj);

    for (const arrow of obj.arrows) {
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

      updateArrow(obj, arrow, origin.x, origin.y, toX, toY);
    }
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
  closeForceKeypad();

  if (drag) {
    const target = drag.mode === "create" ? drag.obj.hit : drag.handle;
    try {
      target.releasePointerCapture(drag.pointerId);
    } catch {
      // ignore
    }
    drag.obj.hit.classList.remove("is-dragging");
    if (drag.handle) drag.handle.classList.remove("is-dragging");
    drag = null;
  }

  clearConstruction();
  clearArrows();
  syncCircleCount();

  for (let i = 0; i < objects.length; i++) {
    const obj = objects[i];
    obj.baseOffset =
      i === 1
        ? { x: SECOND_OBJECT_OFFSET.x, y: SECOND_OBJECT_OFFSET.y }
        : { x: 0, y: 0 };
    obj.position = { x: 0, y: 0 };
    obj.velocity = { x: 0, y: 0 };
    obj.simulationForce = { fx: 0, fy: 0 };
    applyPosition(obj);
  }

  lastFrameTime = null;
  snap90Active = false;
  snap90Btn.classList.remove("is-active");
  snap90Btn.setAttribute("aria-pressed", "false");
  updateButtons();
}

function startSimulation() {
  if (animating || constructionAnimating) return;

  animating = true;
  lastFrameTime = null;

  for (const obj of objects) {
    const { fx, fy } = getResultantForce(obj);
    obj.simulationForce = { fx, fy };
    obj.velocity = { x: 0, y: 0 };
  }

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

    for (const obj of objects) {
      const ax = (obj.simulationForce.fx / OBJECT_MASS) * ACCEL_SCALE;
      const ay = (obj.simulationForce.fy / OBJECT_MASS) * ACCEL_SCALE;

      obj.velocity.x += ax * dt;
      obj.velocity.y += ay * dt;
      obj.position.x += obj.velocity.x * dt;
      obj.position.y += obj.velocity.y * dt;
      applyPosition(obj);
    }

    animationFrameId = requestAnimationFrame(step);
  }

  animationFrameId = requestAnimationFrame(step);
}

function onObjectPointerDown(e, obj) {
  if (!isPrimaryPointerDown(e) || animating || constructionAnimating || forceEdit) return;
  if (obj.arrows.length >= MAX_ARROWS) return;

  const found = findArrowByTipPoint(e.clientX, e.clientY);
  if (found) {
    startTipDrag(e, found.obj, found.arrow);
    return;
  }

  e.preventDefault();

  beginPointerCapture(obj.svg, e);
  obj.hit.classList.add("is-dragging");

  const arrow = createArrow(obj);
  obj.arrows.push(arrow);
  updateButtons();

  const origin = getArrowOrigin(obj);
  const p = clientToSvgPoint(obj.svg, e.clientX, e.clientY);
  drag = {
    mode: "create",
    pointerId: e.pointerId,
    obj,
    arrow,
    handle: null,
  };

  updateArrow(obj, arrow, origin.x, origin.y, p.x, p.y);
}

function startTipDrag(e, obj, arrow) {
  e.preventDefault();
  e.stopPropagation();

  beginPointerCapture(obj.svg, e);
  arrow.tipHandle.classList.add("is-dragging");

  const p = clientToSvgPoint(obj.svg, e.clientX, e.clientY);
  drag = {
    mode: "tip",
    pointerId: e.pointerId,
    obj,
    arrow,
    handle: arrow.tipHandle,
    startX: p.x,
    startY: p.y,
    hasMoved: false,
  };
}

function onTipPointerDown(e, obj, arrow) {
  if (!isPrimaryPointerDown(e) || animating || constructionAnimating || forceEdit) return;
  startTipDrag(e, obj, arrow);
}

function onSvgPointerDown(e, obj) {
  if (!isPrimaryPointerDown(e) || animating || constructionAnimating || drag || forceEdit) return;
  if (obj.hit.contains(e.target)) return;
  if (e.target instanceof Element && e.target.closest(".arrow-tip-handle")) return;

  const found = findArrowByTipPoint(e.clientX, e.clientY);
  if (found && found.obj === obj) startTipDrag(e, found.obj, found.arrow);
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;

  const p = clientToSvgPoint(drag.obj.svg, e.clientX, e.clientY);
  if (drag.mode === "tip" && !shouldUpdateTipDrag(drag, p.x, p.y)) return;

  e.preventDefault();

  const origin = getArrowOrigin(drag.obj);
  updateArrow(drag.obj, drag.arrow, origin.x, origin.y, p.x, p.y);
  updateButtons();
}

function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  e.preventDefault();

  releasePointerCaptureSafe(drag.obj.svg, e.pointerId);

  drag.obj.hit.classList.remove("is-dragging");
  if (drag.handle) drag.handle.classList.remove("is-dragging");

  if (drag.mode !== "tip" || drag.hasMoved) {
    const p = clientToSvgPoint(drag.obj.svg, e.clientX, e.clientY);
    const origin = getArrowOrigin(drag.obj);
    const visible = updateArrow(drag.obj, drag.arrow, origin.x, origin.y, p.x, p.y);
    if (!visible) removeArrow(drag.obj, drag.arrow);
  }

  drag = null;
  updateButtons();
}

const firstWrap = objectsStage.querySelector(".object-wrap");
if (!firstWrap) {
  throw new Error("Missing initial object.");
}
const firstObject = initObjectFromWrap(firstWrap, 0, 0);
bindObjectEvents(firstObject);

startBtn.addEventListener("click", startSimulation);
resultantBtn.addEventListener("click", toggleResultantConstruction);
snap90Btn.addEventListener("click", toggleSnap90);
resetBtn.addEventListener("click", resetSimulation);
circlesToggleBtn.addEventListener("click", toggleTwoCircles);
forceKeypadClose.addEventListener("click", closeForceKeypad);
forceKeypadConfirm.addEventListener("click", confirmForceKeypad);
forceKeypadOverlay.addEventListener("pointerdown", (e) => {
  if (e.target === forceKeypadOverlay) closeForceKeypad();
});
forceKeypadKeys.forEach((key) => {
  key.addEventListener("click", handleForceKeypadClick);
});

document.addEventListener("keydown", (e) => {
  if (!forceEdit) return;

  if (e.key === "Enter") {
    e.preventDefault();
    confirmForceKeypad();
  } else if (e.key === "Escape") {
    closeForceKeypad();
  }
});

loadJetMotorTemplate().then(() => {
  syncJetMotors();
});

const stage = document.querySelector(".stage");
if (stage) {
  stage.addEventListener(
    "touchmove",
    (e) => {
      if (e.cancelable) e.preventDefault();
    },
    { passive: false }
  );
}

updateCirclesToggleUi();
updateButtons();
