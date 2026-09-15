// Фэнтези-калькулятор Dota 2 TI 2026.
// Читает window.TI_DATA (правила + статистика из parser/fetch_stats.py),
// вшитый в data.js — без fetch, чтобы работать и через file://, и на GitHub
// Pages из папки docs/. Сборки нет — чистый скрипт, data.js собирает
// parser/build_docs_data.py.

const COLOR_LABEL = { red: "Красная", blue: "Синяя", green: "Зелёная" };
const QUALITIES = ["I", "II", "III", "IV", "V"];
const LS_KEY = "ti2026-fantasy-config-v2";

const state = {
  formulas: null,
  players: [],
  meta: {},
  stage: "group",
  role: "core",
  // config[stage][role] = [{ statKey, quality, trait }]  (color берётся из layout)
  config: {},
  expanded: new Set(),
};

// ---------- загрузка ----------
function boot() {
  const data = window.TI_DATA || {};
  state.formulas = data.formulas;
  const statFile = data.playersStat || null;

  if (Array.isArray(statFile)) {
    state.players = statFile; // старый формат — на всякий случай
  } else if (statFile && Array.isArray(statFile.players)) {
    state.players = statFile.players;
    state.meta = statFile;
  }

  restoreConfig();
  renderMeta();
  renderStageToggle();
  renderTabs();
  renderRole();

  document.getElementById("btn-reset").onclick = () => {
    localStorage.removeItem(LS_KEY);
    state.config = {};
    initConfig();
    renderRole();
  };
  document.getElementById("btn-optimize").onclick = optimizeCurrentBanner;
}

// ---------- конфиг баннеров ----------
function layout(stage, role) {
  return state.formulas.banners[stage][role];
}

function initConfig() {
  for (const stage of ["group", "playoff"]) {
    state.config[stage] = state.config[stage] || {};
    for (const role of state.formulas.roles) {
      const want = layout(stage, role);
      const have = state.config[stage][role];
      if (Array.isArray(have) && have.length === want.length) continue;
      state.config[stage][role] = want.map((color, i) => ({
        statKey: (have && have[i] && have[i].statKey) || firstAvailableStat(color),
        quality: (have && have[i] && have[i].quality) || "III",
        trait: (have && have[i] && have[i].trait) || "none",
      }));
    }
  }
}

function restoreConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    if (saved.config) state.config = saved.config;
    if (saved.stage) state.stage = saved.stage;
    if (saved.role) state.role = saved.role;
  } catch { /* ignore */ }
  initConfig();
}

function persist() {
  localStorage.setItem(
    LS_KEY,
    JSON.stringify({ config: state.config, stage: state.stage, role: state.role })
  );
}

function statsOfColor(color) {
  return Object.entries(state.formulas.stats).filter(([, v]) => v.color === color);
}
function firstAvailableStat(color) {
  const list = statsOfColor(color);
  const ok = list.find(([, v]) => v.available !== false);
  return (ok || list[0])[0];
}

// ---------- кандидаты ----------
function candidates(role) {
  const players = state.players.filter((p) => p.stats && Object.keys(p.stats).length);

  if (role === "mid") {
    return players
      .filter((p) => p.role === "mid" || p.position === 2)
      .map((p) => ({
        label: p.nickname,
        team: p.team,
        sample: p.stats.sample_size || 0,
        members: [p],
        stat: (k) => num(p.stats[k]),
      }));
  }

  const [posA, posB] = state.formulas.duo_positions[role];
  const byTeam = {};
  for (const p of players) {
    if (p.position === posA || p.position === posB) {
      (byTeam[p.team] = byTeam[p.team] || []).push(p);
    }
  }
  const out = [];
  for (const [team, list] of Object.entries(byTeam)) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.position - b.position);
    const [p1, p2] = list;
    out.push({
      label: `${p1.nickname} + ${p2.nickname}`,
      team,
      sample: Math.min(p1.stats.sample_size || 0, p2.stats.sample_size || 0),
      members: [p1, p2],
      stat: (k) => (num(p1.stats[k]) + num(p2.stats[k])) / 2,
    });
  }
  return out;
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

// ---------- расчёт очков ----------
function basePoints(rawAvg, def) {
  switch (def.type) {
    case "linear":
      return rawAvg * def.value;
    case "linear_penalty":
      return def.base + rawAvg * def.per_unit;
    case "participation": // rawAvg — доля участия 0..1
      return Math.min(rawAvg * def.max, def.max);
    case "rate": // rawAvg — доля матчей с событием 0..1
      return rawAvg * def.value;
    default:
      return rawAvg;
  }
}

// Возвращает { total, slots:[{...breakdown}] } для баннера роли и кандидата.
function scoreCandidate(role, cand) {
  const slots = state.config[state.stage][role];
  const colors = layout(state.stage, role);
  const F = state.formulas;

  const qualitiesDistinct =
    new Set(slots.map((s) => s.quality)).size === slots.length;
  const uniqueCount = slots.filter((s) => s.trait === "unique").length;
  const friendlyCount = slots.filter((s) => s.trait === "friendly").length;

  function conditionMet(cond) {
    if (!cond) return true;
    if (cond === "all_qualities_distinct") return qualitiesDistinct;
    if (cond === "only_unique_on_banner") return uniqueCount === 1;
    if (cond === "three_plus_friendly_on_banner") return friendlyCount >= 3;
    return true;
  }

  // 1) база + разряд + собственное свойство
  const rows = slots.map((slot, i) => {
    const def = F.stats[slot.statKey];
    const raw = cand.stat(slot.statKey);
    const base = basePoints(raw, def);
    const qMul = 1 + (F.quality_bonus[slot.quality] || 0);
    let value = base * qMul;

    const trait = F.traits[slot.trait] || {};
    let selfMul = 1;
    if (trait.self && conditionMet(trait.condition)) selfMul = 1 + trait.self;
    value *= selfMul;

    return {
      color: colors[i],
      statKey: slot.statKey,
      statLabel: def.label,
      raw,
      base,
      quality: slot.quality,
      qMul,
      trait: slot.trait,
      selfMul,
      neighborMul: 1,
      value,
    };
  });

  // 2) эффекты на соседей (Благотворная / Вампирическая)
  slots.forEach((slot, i) => {
    const trait = F.traits[slot.trait] || {};
    if (!trait.neighbors) return;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= rows.length) continue;
      rows[j].neighborMul *= 1 + trait.neighbors;
      rows[j].value *= 1 + trait.neighbors;
    }
  });

  const total = rows.reduce((s, r) => s + r.value, 0);
  return { total, slots: rows };
}

// ---------- UI: шапка ----------
function renderMeta() {
  const el = document.getElementById("data-meta");
  if (!state.meta.updated_at) {
    el.textContent = "Статистика не загружена — запусти parser/fetch_stats.py";
    el.classList.add("warn");
    return;
  }
  const d = new Date(state.meta.updated_at);
  const covered = state.players.filter((p) => p.stats && Object.keys(p.stats).length).length;
  el.textContent = `Данные обновлены ${d.toLocaleString("ru-RU")} · игроков со статой: ${covered}/${state.players.length}`;
}

function renderStageToggle() {
  document.querySelectorAll("#stage-toggle button").forEach((b) => {
    b.classList.toggle("active", b.dataset.stage === state.stage);
    b.onclick = () => {
      state.stage = b.dataset.stage;
      persist();
      renderStageToggle();
      renderRole();
    };
  });
}

function renderTabs() {
  const nav = document.getElementById("role-tabs");
  nav.innerHTML = "";
  for (const role of state.formulas.roles) {
    const btn = document.createElement("button");
    btn.textContent = state.formulas.role_labels[role] || role;
    btn.className = role === state.role ? "active" : "";
    btn.onclick = () => {
      state.role = role;
      persist();
      renderTabs();
      renderRole();
    };
    nav.appendChild(btn);
  }
}

// ---------- UI: баннер + результаты ----------
function renderRole() {
  const role = state.role;
  const panel = document.getElementById("role-panel");
  panel.innerHTML = "";

  const slotsWrap = document.createElement("div");
  slotsWrap.className = "slots";
  state.config[state.stage][role].forEach((slot, i) => {
    slotsWrap.appendChild(slotCard(role, slot, i));
  });
  panel.appendChild(slotsWrap);

  const results = document.createElement("div");
  results.className = "results";
  results.innerHTML = `<h2>Рейтинг ${roleWord(role)}</h2><div id="results-list"></div>`;
  panel.appendChild(results);

  renderResults(role);
}

function roleWord(role) {
  return { core: "дуэтов основы", mid: "мидеров", support: "дуэтов поддержки" }[role] || role;
}

function slotCard(role, slot, idx) {
  const color = layout(state.stage, role)[idx];
  const F = state.formulas;
  const card = document.createElement("div");
  card.className = `slot-card color-${color}`;

  const statOpts = statsOfColor(color)
    .map(([k, v]) => {
      const dis = v.available === false ? " disabled" : "";
      const tag = v.available === false ? " — нет данных" : "";
      return `<option value="${k}"${dis} ${k === slot.statKey ? "selected" : ""}>${v.label}${tag}</option>`;
    })
    .join("");

  const qualOpts = QUALITIES.map(
    (q) =>
      `<option value="${q}" ${q === slot.quality ? "selected" : ""}>${q} — +${Math.round(
        F.quality_bonus[q] * 100
      )}%</option>`
  ).join("");

  const traitOpts = Object.entries(F.traits)
    .map(([k, v]) => `<option value="${k}" ${k === slot.trait ? "selected" : ""}>${v.label}</option>`)
    .join("");

  card.innerHTML = `
    <h3>${COLOR_LABEL[color]} эмблема <span class="slot-i">#${idx + 1}</span></h3>
    <label>Показатель</label>
    <select data-field="statKey">${statOpts}</select>
    <label>Разряд качества</label>
    <select data-field="quality">${qualOpts}</select>
    <label>Свойство</label>
    <select data-field="trait">${traitOpts}</select>
    <p class="trait-hint">${traitHint(slot.trait)}</p>
  `;

  card.querySelectorAll("select").forEach((sel) => {
    sel.onchange = (e) => {
      slot[e.target.dataset.field] = e.target.value;
      persist();
      renderRole();
    };
  });
  return card;
}

function traitHint(key) {
  const t = state.formulas.traits[key];
  if (!t || key === "none") return "&nbsp;";
  const parts = [];
  if (t.self) parts.push(`+${Math.round(t.self * 100)}% себе`);
  if (t.neighbors)
    parts.push(`${t.neighbors > 0 ? "+" : ""}${Math.round(t.neighbors * 100)}% соседям`);
  const cond = {
    all_qualities_distinct: "если все разряды на баннере разные",
    only_unique_on_banner: "если на баннере одна Уникальная",
    three_plus_friendly_on_banner: "если на баннере ≥3 Дружелюбных",
  }[t.condition];
  if (cond) parts.push(cond);
  return parts.join(" · ");
}

function renderResults(role) {
  const list = document.getElementById("results-list");
  const cands = candidates(role);
  if (!cands.length) {
    list.innerHTML = `<p class="muted">Нет игроков с данными для этой роли. Запусти <code>python parser/fetch_stats.py</code>.</p>`;
    return;
  }

  const scored = cands
    .map((c) => ({ cand: c, ...scoreCandidate(role, c) }))
    .sort((a, b) => b.total - a.total);

  const max = scored[0].total || 1;

  list.innerHTML = scored
    .map((row, i) => {
      const c = row.cand;
      const id = `${role}:${c.label}`;
      const open = state.expanded.has(id);
      const lowSample = c.sample < 5;
      const pct = Math.max(2, (row.total / max) * 100);
      return `
      <div class="result ${i === 0 ? "rank-1" : ""}">
        <button class="result-head" data-id="${id}">
          <span class="rank">${i + 1}</span>
          <span class="name">${c.label}<small>${c.team}</small></span>
          <span class="bar"><span style="width:${pct}%"></span></span>
          <span class="score">${fmt(row.total)}</span>
          <span class="sample ${lowSample ? "low" : ""}" title="карт в выборке">${c.sample}${
        lowSample ? " ⚠" : ""
      }</span>
          <span class="chev">${open ? "▾" : "▸"}</span>
        </button>
        ${open ? breakdownTable(row) : ""}
      </div>`;
    })
    .join("");

  list.querySelectorAll(".result-head").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      renderResults(role);
    };
  });
}

function breakdownTable(row) {
  const rows = row.slots
    .map(
      (s) => `
    <tr>
      <td><span class="dot dot-${s.color}"></span>${s.statLabel}</td>
      <td>${fmt(s.raw, 2)}</td>
      <td>${fmt(s.base)}</td>
      <td>×${s.qMul.toFixed(2)}</td>
      <td>${s.selfMul !== 1 ? "×" + s.selfMul.toFixed(2) : "—"}</td>
      <td>${s.neighborMul !== 1 ? "×" + s.neighborMul.toFixed(2) : "—"}</td>
      <td class="num">${fmt(s.value)}</td>
    </tr>`
    )
    .join("");
  return `
  <div class="breakdown">
    <table>
      <thead><tr>
        <th>Слот</th><th>Ср.</th><th>База</th><th>Разряд</th><th>Свой</th><th>Сосед</th><th>Итог</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="6">Сумма</td><td class="num">${fmt(row.total)}</td></tr></tfoot>
    </table>
  </div>`;
}

// ---------- «Оптимальные статы» ----------
function optimizeCurrentBanner() {
  const role = state.role;
  const cands = candidates(role);
  if (!cands.length) return;
  const colors = layout(state.stage, role);
  const slots = state.config[state.stage][role];

  colors.forEach((color, i) => {
    let best = null;
    let bestAvg = -Infinity;
    for (const [k, def] of statsOfColor(color)) {
      if (def.available === false) continue;
      const avg =
        cands.reduce((s, c) => s + basePoints(c.stat(k), def), 0) / cands.length;
      if (avg > bestAvg) {
        bestAvg = avg;
        best = k;
      }
    }
    if (best) slots[i].statKey = best;
  });
  persist();
  renderRole();
}

// ---------- утилиты ----------
function fmt(v, digits = 0) {
  if (!isFinite(v)) return "0";
  return v.toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

boot();
