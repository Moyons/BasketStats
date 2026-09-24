/* =========================================================
   BasketStats — app.js
   App de estadísticas de baloncesto (sin minutos, solo stats)
   Vanilla JS, sin dependencias, persistencia en localStorage.
   ========================================================= */
(function () {
  "use strict";

  /* ---------------------------------------------------------
     Storage — Firebase Realtime Database (compartida entre todos
     los que abren el enlace) con localStorage como caché/respaldo
     offline. Escritura abierta a nivel de base de datos: la única
     protección es la contraseña de administrador de la propia app
     (ver más abajo), igual que ya era antes de añadir la nube.
     --------------------------------------------------------- */
  const DB_KEY = "basketstats_v1";
  const CLOUD_BASE = "https://basketstats-9e5e7-default-rtdb.europe-west1.firebasedatabase.app";
  // IMPORTANTE: /data.json es la base de datos real que usa todo el mundo.
  // Para pruebas se abre la app con ?testdb=1 en la URL, que la redirige a
  // un espacio aislado (_test_sandbox) — así ninguna prueba puede tocar
  // nunca los datos reales por accidente.
  const CLOUD_PATH = new URLSearchParams(location.search).get("testdb")
    ? "/_test_sandbox/data.json"
    : "/data.json";

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Firebase Realtime Database no guarda arrays/objetos vacíos (los
  // "recorta" al escribir), así que cualquier array vacío que mandemos
  // (events: [], players: [], games: []) vuelve como `undefined` al
  // leerlo. normalizeDB reconstruye esas listas para que el resto del
  // código pueda asumir siempre que son arrays.
  function asArray(v) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") return Object.values(v);
    return [];
  }
  function normalizeDB(db) {
    if (!db || typeof db !== "object") return defaultDB();
    db.players = asArray(db.players);
    db.games = asArray(db.games).map(g => {
      g.events = asArray(g.events);
      return g;
    });
    if (!db.team) db.team = { name: "Mi Equipo" };
    return db;
  }

  // Aplica los datos remotos MUTANDO los objetos existentes en vez de
  // sustituir el árbol entero. Esto importa: partes de la app guardan
  // una referencia directa a un partido o jugador concreto (p. ej. el
  // selector de convocatoria, o el panel de estadísticas ya abierto) y
  // si reemplazáramos `DB.games`/`DB.players` por arrays nuevos, esas
  // referencias quedarían "huérfanas" — sus cambios ya no llegarían a
  // guardarse. Mutar en el sitio mantiene esas referencias válidas.
  function mergeInPlace(localArr, remoteArr) {
    const remoteById = new Map(remoteArr.map(x => [x.id, x]));
    for (let i = localArr.length - 1; i >= 0; i--) {
      const id = localArr[i].id;
      if (remoteById.has(id)) {
        Object.assign(localArr[i], remoteById.get(id));
        remoteById.delete(id);
      } else {
        localArr.splice(i, 1); // borrado en otro dispositivo
      }
    }
    remoteArr.forEach(r => { if (remoteById.has(r.id)) localArr.push(r); });
  }
  function applyRemoteDB(remote) {
    const clean = normalizeDB(remote);
    mergeInPlace(DB.players, clean.players);
    mergeInPlace(DB.games, clean.games);
    DB.team = clean.team;
    DB.admin = clean.admin;
  }

  function loadLocalDB() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (!raw) return defaultDB();
      return normalizeDB(JSON.parse(raw));
    } catch (e) {
      return defaultDB();
    }
  }

  function defaultDB() {
    return { team: { name: "Mi Equipo" }, players: [], games: [] };
  }

  // Guarda local al instante (respuesta rápida) y sube a la nube en
  // segundo plano para que el resto de dispositivos lo reciban.
  function saveDB() {
    localStorage.setItem(DB_KEY, JSON.stringify(DB));
    cloudPut(DB);
  }

  let DB = loadLocalDB();
  let cloudConnected = false;

  async function cloudPut(data) {
    try {
      const res = await fetch(CLOUD_BASE + CLOUD_PATH, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      setCloudConnected(res.ok);
    } catch (e) {
      setCloudConnected(false);
    }
  }

  async function cloudFetchInitial() {
    try {
      const res = await fetch(CLOUD_BASE + CLOUD_PATH, { cache: "no-store" });
      if (!res.ok) throw new Error("bad status");
      return await res.json(); // null si la nube está vacía
    } catch (e) {
      return undefined; // undefined = no se pudo contactar (offline)
    }
  }

  // Estado de conexión a la nube (sin indicador visible: la app funciona
  // igual con o sin conexión, con localStorage como respaldo automático).
  function setCloudConnected(v) {
    cloudConnected = v;
  }

  let cloudStream = null;
  function startCloudStream() {
    if (cloudStream) return;
    try {
      cloudStream = new EventSource(CLOUD_BASE + CLOUD_PATH);
      cloudStream.addEventListener("put", (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload.path === "/" && payload.data) {
            applyRemoteDB(payload.data);
            localStorage.setItem(DB_KEY, JSON.stringify(DB));
            setCloudConnected(true);
            render();
          }
        } catch (err) { /* ignora eventos que no podamos interpretar */ }
      });
      cloudStream.onopen = () => setCloudConnected(true);
      cloudStream.onerror = () => setCloudConnected(false);
    } catch (e) {
      setCloudConnected(false);
    }
  }

  async function initCloudSync(retryDelay) {
    retryDelay = retryDelay || 3000;
    const remote = await cloudFetchInitial();
    if (remote === undefined) {
      setCloudConnected(false);
      setTimeout(() => initCloudSync(Math.min(retryDelay * 1.5, 30000)), retryDelay);
      return;
    }
    if (remote === null) {
      // La nube está vacía: la sembramos con lo que tengamos en local.
      await cloudPut(DB);
    } else {
      applyRemoteDB(remote);
      localStorage.setItem(DB_KEY, JSON.stringify(DB));
    }
    setCloudConnected(true);
    render();
    startCloudStream();
  }

  /* ---------------------------------------------------------
     Admin mode (contraseña de administrador)
     Cualquiera puede consultar; solo quien desbloquea con la
     contraseña puede crear/editar/borrar datos. Es una barrera
     de cara, no criptografía de verdad (todo vive en el cliente),
     pero evita que alguien toque los datos por error o sin permiso.
     --------------------------------------------------------- */
  const UNLOCK_KEY = "basketstats_unlocked_v1";

  function toHex(buffer) {
    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function randomSaltHex() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return toHex(arr.buffer);
  }
  async function hashPassword(password, saltHex) {
    const data = new TextEncoder().encode(saltHex + ":" + password);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return toHex(digest);
  }
  function isAdminConfigured() { return !!(DB.admin && DB.admin.hash); }
  function isUnlocked() { return !isAdminConfigured() || localStorage.getItem(UNLOCK_KEY) === "1"; }
  function unlockAdmin() { localStorage.setItem(UNLOCK_KEY, "1"); }
  function lockAdmin() { localStorage.removeItem(UNLOCK_KEY); }
  async function checkPassword(pass) {
    if (!isAdminConfigured()) return true;
    return (await hashPassword(pass || "", DB.admin.salt)) === DB.admin.hash;
  }
  async function setAdminPassword(newPass) {
    const salt = randomSaltHex();
    const hash = await hashPassword(newPass, salt);
    DB.admin = { salt, hash };
  }

  // Ejecuta `action` si ya está desbloqueado; si no, pide la contraseña primero.
  function requireAdmin(action) {
    if (isUnlocked()) { action(); return; }
    openUnlockPrompt(action);
  }

  function openUnlockPrompt(onSuccess) {
    openCenter(`
      <h3 class="modal-title">Acceso de administrador</h3>
      <p class="hint" style="margin-bottom:14px">Introduce la contraseña para añadir o modificar datos.</p>
      <div class="field"><input type="password" id="unlock-pass" placeholder="Contraseña" autocomplete="current-password"></div>
      <div id="unlock-err" class="hint" style="color:var(--critical);display:none;margin-bottom:6px">Contraseña incorrecta</div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-block" id="unlock-cancel">Cancelar</button>
        <button class="btn btn-primary btn-block" id="unlock-ok">Desbloquear</button>
      </div>
    `, {
      onMount(root) {
        const input = root.querySelector("#unlock-pass");
        const err = root.querySelector("#unlock-err");
        input.focus();
        root.querySelector("#unlock-cancel").addEventListener("click", closeModal);
        const tryUnlock = async () => {
          const ok = await checkPassword(input.value);
          if (ok) {
            unlockAdmin();
            closeModal();
            renderAdminBadge();
            onSuccess();
          } else {
            err.style.display = "block";
            input.value = "";
            input.focus();
          }
        };
        root.querySelector("#unlock-ok").addEventListener("click", tryUnlock);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") tryUnlock(); });
      }
    });
  }

  function promptText(title, desc, placeholder, onSubmit) {
    openCenter(`
      <h3 class="modal-title">${esc(title)}</h3>
      ${desc ? `<p class="hint" style="margin-bottom:14px">${esc(desc)}</p>` : ""}
      <div class="field"><input type="password" id="pt-input" placeholder="${esc(placeholder || "")}" autocomplete="current-password"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-block" id="pt-cancel">Cancelar</button>
        <button class="btn btn-primary btn-block" id="pt-ok">Continuar</button>
      </div>
    `, {
      onMount(root) {
        const input = root.querySelector("#pt-input");
        input.focus();
        root.querySelector("#pt-cancel").addEventListener("click", closeModal);
        const submit = () => { const v = input.value; closeModal(); onSubmit(v); };
        root.querySelector("#pt-ok").addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
      }
    });
  }

  function renderAdminBadge() {
    const btn = document.getElementById("admin-toggle");
    if (!btn) return;
    if (!isAdminConfigured()) { btn.style.display = "none"; return; }
    btn.style.display = "flex";
    if (isUnlocked()) {
      btn.classList.add("unlocked");
      btn.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.unlock}</svg><span>Admin</span>`;
    } else {
      btn.classList.remove("unlocked");
      btn.innerHTML = `<svg viewBox="0 0 24 24">${ICONS.lock}</svg><span>Solo lectura</span>`;
    }
  }

  /* ---------------------------------------------------------
     Stat definitions
     --------------------------------------------------------- */
  // Shot types carry made/attempt; simple types are just counted.
  const SHOT_TYPES = [
    { key: "ft", label: "T. Libre", pts: 1 },
    { key: "p2", label: "Tiro 2", pts: 2 },
    { key: "p3", label: "Triple", pts: 3 },
  ];
  const SIMPLE_TYPES = [
    { key: "oreb", label: "Reb. Of.", short: "RO" },
    { key: "dreb", label: "Reb. Def.", short: "RD" },
    { key: "ast", label: "Asist.", short: "AST" },
    { key: "stl", label: "Robo", short: "STL" },
    { key: "blk", label: "Tapón", short: "BLK" },
    { key: "tov", label: "Pérdida", short: "PER" },
    { key: "foul", label: "Falta", short: "FAL" },
  ];
  const FOUL_LIMIT = 5; // se elimina al llegar a 5 faltas personales

  function pointsForEvent(ev) {
    if (ev.type === "ft" && ev.made) return 1;
    if (ev.type === "p2" && ev.made) return 2;
    if (ev.type === "p3" && ev.made) return 3;
    return 0;
  }

  // Aggregate a list of events into a stat line.
  function aggregate(events) {
    const s = {
      pts: 0, ftm: 0, fta: 0, p2m: 0, p2a: 0, p3m: 0, p3a: 0,
      oreb: 0, dreb: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0, foul: 0,
      gp: 0,
    };
    for (const ev of events) {
      if (ev.type === "ft") { s.fta++; if (ev.made) { s.ftm++; s.pts += 1; } }
      else if (ev.type === "p2") { s.p2a++; if (ev.made) { s.p2m++; s.pts += 2; } }
      else if (ev.type === "p3") { s.p3a++; if (ev.made) { s.p3m++; s.pts += 3; } }
      else if (ev.type === "oreb") { s.oreb++; s.reb++; }
      else if (ev.type === "dreb") { s.dreb++; s.reb++; }
      else if (ev.type === "ast") s.ast++;
      else if (ev.type === "stl") s.stl++;
      else if (ev.type === "blk") s.blk++;
      else if (ev.type === "tov") s.tov++;
      else if (ev.type === "foul") s.foul++;
    }
    s.fgm = s.p2m + s.p3m;
    s.fga = s.p2a + s.p3a;
    s.pct = (m, a) => (a > 0 ? Math.round((m / a) * 100) : null);
    return s;
  }

  function pct(m, a) { return a > 0 ? Math.round((m / a) * 100) : null; }
  function pctStr(m, a) { const p = pct(m, a); return p === null ? "—" : p + "%"; }
  function avg(total, games) { return games > 0 ? total / games : 0; }
  function fmtAvg(n) {
    if (!isFinite(n)) return "0.0";
    return n.toFixed(1);
  }

  /* ---------------------------------------------------------
     Data helpers
     --------------------------------------------------------- */
  function getPlayer(id) { return DB.players.find(p => p.id === id); }
  function getGame(id) { return DB.games.find(g => g.id === id); }
  function activePlayers() { return DB.players.filter(p => !p.archived); }

  function playerEventsInGame(game, playerId) {
    return game.events.filter(e => e.playerId === playerId);
  }
  function allPlayerEvents(playerId, { finishedOnly = false } = {}) {
    const out = [];
    for (const g of DB.games) {
      if (finishedOnly && g.status !== "final") continue;
      for (const e of g.events) if (e.playerId === playerId) out.push(e);
    }
    return out;
  }
  function gamesPlayedBy(playerId, { finishedOnly = false } = {}) {
    let n = 0;
    for (const g of DB.games) {
      if (finishedOnly && g.status !== "final") continue;
      if (g.events.some(e => e.playerId === playerId)) n++;
    }
    return n;
  }
  function teamScore(game) {
    return game.events.reduce((sum, e) => sum + pointsForEvent(e), 0);
  }

  /* ---------------------------------------------------------
     Router
     --------------------------------------------------------- */
  const routes = {};
  function route(pattern, handler) { routes[pattern] = handler; }

  function parseHash() {
    let h = location.hash.slice(1) || "/";
    if (!h.startsWith("/")) h = "/" + h;
    return h;
  }

  function matchRoute(path) {
    const parts = path.split("/").filter(Boolean);
    for (const pattern in routes) {
      const pp = pattern.split("/").filter(Boolean);
      if (pp.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(":")) params[pp[i].slice(1)] = decodeURIComponent(parts[i]);
        else if (pp[i] !== parts[i]) { ok = false; break; }
      }
      if (ok) return { handler: routes[pattern], params };
    }
    return null;
  }

  // Muchas acciones (anotar un tiro, deshacer, sincronizar con la nube...)
  // vuelven a pintar la vista actual sin cambiar de página — en esos casos
  // NO debe saltar el scroll arriba, solo cuando la ruta cambia de verdad.
  let lastRenderedPath = null;
  function render() {
    const path = parseHash();
    const isNavigation = path !== lastRenderedPath;
    lastRenderedPath = path;
    const m = matchRoute(path);
    const view = document.getElementById("view");
    if (!m) { view.innerHTML = emptyState("¿?", "Página no encontrada", ""); return; }
    view.innerHTML = "";
    if (isNavigation) window.scrollTo(0, 0);
    m.handler(view, m.params);
    updateTabbar(path);
    renderAdminBadge();
  }

  function updateTabbar(path) {
    let tab = "home";
    if (path.startsWith("/season")) tab = "season";
    else if (path.startsWith("/roster")) tab = "roster";
    else if (path.startsWith("/settings")) tab = "settings";
    document.querySelectorAll("#tabbar a").forEach(a => {
      a.classList.toggle("active", a.dataset.tab === tab);
    });
  }

  window.addEventListener("hashchange", render);

  function go(path) { location.hash = path; }
  function goBack(fallback) {
    if (window.history.length > 1) window.history.back();
    else go(fallback);
  }

  /* ---------------------------------------------------------
     Small UI helpers
     --------------------------------------------------------- */
  function el(html) {
    const t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
  }

  function emptyState(iconSvg, title, desc, actionHtml) {
    return `<div class="empty-state">
      ${iconSvg ? `<svg viewBox="0 0 24 24">${iconSvg}</svg>` : ""}
      <h3>${esc(title)}</h3>
      <p>${esc(desc)}</p>
      ${actionHtml || ""}
    </div>`;
  }

  const ICONS = {
    ball: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8"/>',
    team: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><circle cx="17" cy="9" r="2.5"/><path d="M17 14c2.4 0 4.1 1.5 4.5 4"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-2"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    back: '<path d="M19 12H5M11 5l-6 7 6 7"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    check: '<path d="M5 13l4 4L19 7"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
    export: '<path d="M12 15V3M7 8l5-5 5 5"/><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    unlock: '<rect x="5" y="11" width="14" height="9" rx="2.5"/><path d="M8 11V8a4 4 0 0 1 7.6-1.8"/>',
    cloud: '<path d="M6.5 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 16.9 8.5 4.5 4.5 0 0 1 16.5 18h-10Z"/>',
    cloudOff: '<path d="M6.5 18a4 4 0 0 1-.3-7.98M8.5 6.4A5.5 5.5 0 0 1 16.9 8.5 4.5 4.5 0 0 1 16.5 18h-7M3 3l18 18"/>',
  };

  /* ---------------------------------------------------------
     Modal system
     --------------------------------------------------------- */
  const modalRoot = document.getElementById("modal");

  function closeModal() {
    modalRoot.classList.remove("open");
    modalRoot.innerHTML = "";
    modalRoot.setAttribute("aria-hidden", "true");
  }

  function openSheet(innerHtml, { onMount, cls, onClose } = {}) {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-close></div>
      <div class="modal-sheet ${cls || ""}" role="dialog">
        <div class="sheet-handle"></div>
        ${innerHtml}
      </div>`;
    modalRoot.classList.add("open");
    modalRoot.setAttribute("aria-hidden", "false");
    modalRoot.querySelector(".modal-backdrop").addEventListener("click", () => { closeModal(); if (onClose) onClose(); });
    if (onMount) onMount(modalRoot);
  }

  function openCenter(innerHtml, { onMount } = {}) {
    modalRoot.innerHTML = `
      <div class="modal-backdrop" data-close></div>
      <div class="modal-center" role="dialog">${innerHtml}</div>`;
    modalRoot.classList.add("open");
    modalRoot.setAttribute("aria-hidden", "false");
    modalRoot.querySelector(".modal-backdrop").addEventListener("click", closeModal);
    if (onMount) onMount(modalRoot);
  }

  function confirmDialog(title, desc, confirmLabel, onConfirm, danger) {
    openCenter(`
      <h3 class="modal-title">${esc(title)}</h3>
      <p class="hint">${esc(desc)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-block" id="cd-cancel">Cancelar</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"} btn-block" id="cd-ok">${esc(confirmLabel)}</button>
      </div>
    `, {
      onMount(root) {
        root.querySelector("#cd-cancel").addEventListener("click", closeModal);
        root.querySelector("#cd-ok").addEventListener("click", () => { closeModal(); onConfirm(); });
      }
    });
  }

  /* ---------------------------------------------------------
     VIEW: Home (lista de partidos)
     --------------------------------------------------------- */
  route("/", (view) => {
    const games = [...DB.games].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const live = games.filter(g => g.status === "live");
    const finished = games.filter(g => g.status === "final");

    view.appendChild(el(`
      <div class="pagehead">
        <div>
          <h1>${esc(DB.team.name)}</h1>
          <div class="sub">${games.length} partido${games.length === 1 ? "" : "s"} registrado${games.length === 1 ? "" : "s"}</div>
        </div>
        <button class="iconbtn" id="new-game-btn"><svg viewBox="0 0 24 24">${ICONS.plus}</svg></button>
      </div>
    `));

    if (games.length === 0) {
      view.appendChild(el(emptyState(
        ICONS.ball,
        "Sin partidos todavía",
        "Crea tu primer partido y empieza a registrar las estadísticas en vivo.",
        `<button class="btn btn-primary" id="new-game-btn-2">Nuevo partido</button>`
      )));
      view.querySelector("#new-game-btn-2").addEventListener("click", () => requireAdmin(openNewGameSheet));
    } else {
      if (live.length) {
        view.appendChild(el(`<div class="section-title">En juego</div>`));
        const wrap = document.createElement("div");
        live.forEach(g => wrap.appendChild(gameCard(g)));
        view.appendChild(wrap);
      }
      if (finished.length) {
        view.appendChild(el(`<div class="section-title">Finalizados</div>`));
        const wrap = document.createElement("div");
        finished.forEach(g => wrap.appendChild(gameCard(g)));
        view.appendChild(wrap);
      }
    }

    view.querySelector("#new-game-btn").addEventListener("click", () => requireAdmin(openNewGameSheet));
  });

  function gameCard(g) {
    const us = teamScore(g);
    const hasRivalScore = g.oppScore !== null && g.oppScore !== undefined;
    const them = g.oppScore || 0;
    const d = g.date ? new Date(g.date) : new Date(g.createdAt);
    const dateStr = d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
    const result = g.status === "final" && hasRivalScore ? (us > them ? " · Victoria" : us < them ? " · Derrota" : " · Empate") : "";
    const card = el(`
      <a class="game-card" href="#/game/${g.id}">
        <div class="game-card-top">
          <div class="game-vs">vs <b>${esc(g.opponent || "Rival")}</b></div>
          <span class="badge ${g.status === "live" ? "badge-live" : "badge-final"}">${g.status === "live" ? "En vivo" : "Final"}</span>
        </div>
        <div class="game-score">
          <span class="us">${us}</span>
          ${hasRivalScore ? `<span class="dash">–</span><span class="them">${them}</span>` : `<span class="them-label">puntos</span>`}
        </div>
        <div class="game-meta">${dateStr}${result}</div>
      </a>
    `);
    return card;
  }

  function openNewGameSheet() {
    if (activePlayers().length === 0) {
      confirmDialog(
        "Añade jugadores primero",
        "Necesitas al menos un jugador en la plantilla para poder registrar un partido.",
        "Ir a plantilla",
        () => go("/roster")
      );
      return;
    }
    openSheet(`
      <h3 class="modal-title">Nuevo partido</h3>
      <div class="field">
        <label>Rival</label>
        <input type="text" id="ng-opponent" placeholder="Nombre del equipo rival" autocomplete="off">
      </div>
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="ng-date">
      </div>
      <button class="btn btn-primary btn-block" id="ng-create">Empezar partido</button>
    `, {
      onMount(root) {
        const dateInput = root.querySelector("#ng-date");
        dateInput.value = new Date().toISOString().slice(0, 10);
        root.querySelector("#ng-opponent").focus();
        root.querySelector("#ng-create").addEventListener("click", () => {
          const opponent = root.querySelector("#ng-opponent").value.trim();
          const game = {
            id: uid(),
            opponent: opponent || "Rival",
            date: dateInput.value || new Date().toISOString().slice(0, 10),
            status: "live",
            quarter: 1,
            oppScore: null,
            events: [],
            rosterIds: [],
            createdAt: Date.now(),
          };
          DB.games.push(game);
          saveDB();
          closeModal();
          go("/game/" + game.id);
          // Preguntamos de inmediato quién juega hoy, así no hay que
          // buscar el botón después con el partido ya empezado.
          setTimeout(() => openRosterPicker(game), 260);
        });
      }
    });
  }

  /* ---------------------------------------------------------
     VIEW: Live game
     --------------------------------------------------------- */
  let liveSelectedPlayer = {}; // gameId -> playerId

  route("/game/:id", (view, params) => {
    const game = getGame(params.id);
    if (!game) { view.appendChild(el(emptyState(ICONS.ball, "Partido no encontrado", ""))); return; }
    renderLiveGame(view, game);
  });

  function renderLiveGame(view, game) {
    const us = teamScore(game);
    const them = game.oppScore || 0;
    const isFinal = game.status === "final";

    const gameHead = el(`
      <div class="pagehead">
        <div class="pagehead-left">
          <button class="iconbtn" id="back-btn"><svg viewBox="0 0 24 24">${ICONS.back}</svg></button>
          <div>
            <div class="sub">vs ${esc(game.opponent)}</div>
            <h1 style="font-size:24px">${esc(DB.team.name)}</h1>
          </div>
        </div>
        <button class="iconbtn" id="game-menu-btn"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg></button>
      </div>
    `);
    view.appendChild(gameHead);
    gameHead.querySelector("#back-btn").addEventListener("click", () => goBack("/"));

    // Cabecera fija (puntos + selector de jugador): se queda pegada
    // arriba al hacer scroll para que nunca haga falta buscarla. No
    // mostramos el marcador del rival durante el partido — solo importa
    // al finalizar, y ahí se puede añadir si se quiere.
    const sticky = el(`
      <div class="live-sticky">
        <div class="mini-score">
          <span class="mini-us tabular">${us}</span>
          <span class="mini-us-label">PTS</span>
          <span class="mini-vs">vs ${esc(game.opponent)}</span>
          <span class="mini-q">${isFinal ? "FINAL" : "Q" + (game.quarter || 1)}</span>
          ${!isFinal ? `<button type="button" class="mini-expand" id="score-expand-btn">Periodo <svg viewBox="0 0 24 24">${ICONS.down}</svg></button>` : ""}
        </div>
        ${!isFinal ? `
        <div class="rival-quarter-panel" id="rival-quarter-panel" hidden>
          <div class="quarter-row" style="margin-top:0">
            <span class="hint">Periodo</span>
            <div class="seg" style="width:auto" id="quarter-seg">
              ${[1,2,3,4].map(q => `<button type="button" data-q="${q}" class="${(game.quarter||1)===q?'active':''}">Q${q}</button>`).join("")}
              <button type="button" data-q="5" class="${(game.quarter||1)===5?'active':''}">PR</button>
            </div>
          </div>
          <button type="button" class="btn btn-primary btn-block" id="finish-game-btn" style="margin-top:14px">Finalizar partido</button>
        </div>` : ""}
        <div class="roster-row">
          <span class="hint" id="roster-count"></span>
          ${!isFinal ? `<button type="button" class="roster-edit-btn" id="roster-edit-btn"><svg viewBox="0 0 24 24">${ICONS.team}</svg>Convocatoria</button>` : ""}
        </div>
        <div class="player-strip" id="player-strip"></div>
      </div>
    `);
    view.appendChild(sticky);

    if (!isFinal) {
      sticky.querySelector("#score-expand-btn").addEventListener("click", () => {
        const panel = sticky.querySelector("#rival-quarter-panel");
        const btn = sticky.querySelector("#score-expand-btn");
        const willShow = panel.hasAttribute("hidden");
        if (willShow) panel.removeAttribute("hidden"); else panel.setAttribute("hidden", "");
        btn.classList.toggle("open", willShow);
      });
      sticky.querySelectorAll("#quarter-seg button").forEach(b => {
        b.addEventListener("click", () => requireAdmin(() => {
          game.quarter = parseInt(b.dataset.q, 10);
          saveDB();
          renderView();
        }));
      });
      sticky.querySelector("#finish-game-btn").addEventListener("click", () => requireAdmin(() => openFinishGameSheet(game)));
    }

    // Convocatoria: si el partido ya tiene jugadores seleccionados, se
    // muestran solo esos (de un vistazo, sin scroll lateral). Si todavía
    // no se ha elegido a nadie, se muestra la plantilla completa como
    // valor por defecto para no bloquear el registro de estadísticas.
    const allPlayers = activePlayers();
    const roster = (game.rosterIds && game.rosterIds.length)
      ? allPlayers.filter(p => game.rosterIds.includes(p.id))
      : allPlayers;

    sticky.querySelector("#roster-count").textContent =
      game.rosterIds && game.rosterIds.length ? `${roster.length} convocados` : "Sin convocatoria (se ven todos)";

    const strip = sticky.querySelector("#player-strip");
    const selected = liveSelectedPlayer[game.id];
    roster.forEach(p => {
      const s = aggregate(playerEventsInGame(game, p.id));
      const chip = el(`
        <div class="player-chip ${selected === p.id ? "active" : ""}" data-pid="${p.id}">
          <div class="num">${esc(p.number ?? "")}</div>
          <div class="nm">${esc(shortName(p.name))}</div>
          <div class="pts">${s.pts} pts</div>
        </div>
      `);
      chip.addEventListener("click", () => {
        liveSelectedPlayer[game.id] = p.id;
        renderView();
      });
      strip.appendChild(chip);
    });

    if (!isFinal) {
      sticky.querySelector("#roster-edit-btn").addEventListener("click", () => requireAdmin(() => openRosterPicker(game)));
    }

    const selectedPlayer = selected && roster.some(p => p.id === selected) ? getPlayer(selected) : null;

    if (allPlayers.length === 0) {
      view.appendChild(el(`<p class="hint" style="margin-top:14px">Añade jugadores en la Plantilla para poder registrar estadísticas.</p>`));
    } else if (roster.length === 0) {
      view.appendChild(el(`<p class="hint" style="margin-top:14px">No hay jugadores convocados. Toca "Convocatoria" para elegir quién juega.</p>`));
    } else if (isFinal) {
      // El resumen completo siempre va primero (aunque haya un jugador
      // seleccionado de cuando el partido estaba en juego), y si además
      // hay alguien seleccionado se ve su detalle jugada a jugada debajo.
      renderGameSummary(view, game, roster);
      if (selectedPlayer) {
        view.appendChild(el(`<div class="section-title">Detalle: ${esc(selectedPlayer.name)}</div>`));
        renderReadOnlyPlayerStats(view, game, selectedPlayer, isUnlocked() ? "Reabre el partido desde el menú para seguir editando." : "Partido finalizado.");
      }
    } else if (selectedPlayer && isUnlocked()) {
      renderStatPad(view, game, selectedPlayer);
    } else if (selectedPlayer) {
      renderReadOnlyPlayerStats(view, game, selectedPlayer, "Modo solo lectura. Desbloquea el modo administrador para registrar estadísticas.");
    } else {
      view.appendChild(el(`<p class="hint" style="margin-top:14px">Toca un jugador arriba para empezar a anotar.</p>`));
    }

    view.querySelector("#game-menu-btn").addEventListener("click", () => requireAdmin(() => openGameMenu(game)));

    function renderView() { location.hash = location.hash; render(); }
  }

  // Sheet a pantalla completa para elegir qué jugadores están convocados
  // a este partido. Cada fila se marca/desmarca al tocarla — sin botón
  // de confirmar al final, así nunca hay que hacer scroll para guardar.
  function openRosterPicker(game) {
    const allPlayers = [...activePlayers()].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
    if (!game.rosterIds) game.rosterIds = [];

    openSheet(`
      <div class="picker-head">
        <h3 class="modal-title" style="margin-bottom:0">¿Quién juega hoy?</h3>
      </div>
      <div class="picker-list" id="rp-list"></div>
      <div class="picker-footer">
        <button type="button" class="btn btn-primary btn-block" id="rp-confirm">Confirmar convocatoria</button>
      </div>
    `, {
      cls: "tall",
      onClose() { location.hash = location.hash; render(); },
      onMount(root) {
        const list = root.querySelector("#rp-list");
        const confirmBtn = root.querySelector("#rp-confirm");
        function updateConfirmLabel() {
          const n = game.rosterIds.length;
          confirmBtn.textContent = n > 0 ? `Confirmar convocatoria (${n})` : "Confirmar convocatoria";
        }
        function renderRows() {
          list.innerHTML = "";
          allPlayers.forEach(p => {
            const checked = game.rosterIds.includes(p.id);
            const row = el(`
              <div class="picker-row ${checked ? "checked" : ""}" data-pid="${p.id}">
                <div class="num">${esc(p.number ?? "")}</div>
                <div class="info"><div class="nm">${esc(p.name)}</div><div class="pos">${esc(p.position || "")}</div></div>
                <div class="check">${checked ? `<svg viewBox="0 0 24 24">${ICONS.check}</svg>` : ""}</div>
              </div>
            `);
            row.addEventListener("click", () => {
              const idx = game.rosterIds.indexOf(p.id);
              if (idx >= 0) game.rosterIds.splice(idx, 1); else game.rosterIds.push(p.id);
              saveDB();
              renderRows();
              updateConfirmLabel();
            });
            list.appendChild(row);
          });
        }
        renderRows();
        updateConfirmLabel();
        confirmBtn.addEventListener("click", () => {
          closeModal();
          location.hash = location.hash; render();
        });
      }
    });
  }

  // Sheet sencilla para cerrar el partido: un único botón grande, con
  // el resultado del rival como campo opcional (no lo llevamos durante
  // el partido, solo interesa el resultado final si se quiere guardar).
  function openFinishGameSheet(game) {
    openSheet(`
      <h3 class="modal-title">Finalizar partido</h3>
      <p class="hint" style="margin-bottom:14px">Vuestros puntos: <b class="tabular" style="color:var(--text-primary)">${teamScore(game)}</b></p>
      <div class="field">
        <label>Puntos del rival (opcional)</label>
        <input type="number" id="fg-opp" min="0" placeholder="Déjalo en blanco si no lo apuntas">
      </div>
      <button class="btn btn-primary btn-block" id="fg-confirm">Finalizar partido</button>
    `, {
      onMount(root) {
        root.querySelector("#fg-opp").focus();
        root.querySelector("#fg-confirm").addEventListener("click", () => {
          const v = root.querySelector("#fg-opp").value;
          game.oppScore = v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
          game.status = "final";
          saveDB();
          closeModal();
          location.hash = location.hash; render();
          toast("Partido finalizado");
        });
      }
    });
  }

  // Resumen del partido finalizado: estadísticas completas de cada
  // convocado que llegó a jugar, para verlo todo de un vistazo.
  function renderGameSummary(view, game, roster) {
    const rows = roster
      .map(p => ({ player: p, s: aggregate(playerEventsInGame(game, p.id)) }))
      .filter(r => r.s.pts + r.s.reb + r.s.ast + r.s.stl + r.s.blk + r.s.tov + r.s.foul + r.s.fga + r.s.fta > 0);

    view.appendChild(el(`<div class="section-title">Resumen del partido</div>`));

    if (rows.length === 0) {
      view.appendChild(el(`<p class="hint" style="margin-top:2px">No se registraron estadísticas en este partido.</p>`));
      return;
    }

    rows.sort((a, b) => b.s.pts - a.s.pts);
    const wrap = el(`<div class="table-wrap"></div>`);
    const table = el(`
      <table class="stats-table">
        <thead>
          <tr>
            <th>Jugador</th><th>PTS</th><th>REB</th><th>AST</th><th>ROB</th><th>TAP</th><th>PÉR</th><th>FAL</th><th>TC</th><th>3P</th><th>TL</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => `
            <tr data-pid="${r.player.id}">
              <td>${esc(shortName(r.player.name))}</td>
              <td>${r.s.pts}</td>
              <td>${r.s.reb}</td>
              <td>${r.s.ast}</td>
              <td>${r.s.stl}</td>
              <td>${r.s.blk}</td>
              <td>${r.s.tov}</td>
              <td>${r.s.foul}${r.s.foul >= 5 ? " ⚠" : ""}</td>
              <td>${r.s.p2m + r.s.p3m}/${r.s.p2a + r.s.p3a}</td>
              <td>${r.s.p3m}/${r.s.p3a}</td>
              <td>${r.s.ftm}/${r.s.fta}</td>
            </tr>
          `).join("")}
          <tr class="totals-row">
            <td>Total</td>
            <td>${rows.reduce((a, r) => a + r.s.pts, 0)}</td>
            <td>${rows.reduce((a, r) => a + r.s.reb, 0)}</td>
            <td>${rows.reduce((a, r) => a + r.s.ast, 0)}</td>
            <td>${rows.reduce((a, r) => a + r.s.stl, 0)}</td>
            <td>${rows.reduce((a, r) => a + r.s.blk, 0)}</td>
            <td>${rows.reduce((a, r) => a + r.s.tov, 0)}</td>
            <td>${rows.reduce((a, r) => a + r.s.foul, 0)}</td>
            <td colspan="3"></td>
          </tr>
        </tbody>
      </table>
    `);
    wrap.appendChild(table);
    table.querySelectorAll("tbody tr[data-pid]").forEach(tr => {
      tr.addEventListener("click", () => {
        liveSelectedPlayer[game.id] = tr.dataset.pid;
        location.hash = location.hash; render();
      });
    });
    view.appendChild(wrap);
    view.appendChild(el(`<p class="hint" style="margin-top:10px">Toca un jugador (arriba o en la tabla) para ver su detalle jugada a jugada.</p>`));
  }

  function shortName(name) {
    if (!name) return "";
    const parts = name.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return parts[0] + " " + parts[1][0] + ".";
  }

  function renderStatPad(view, game, player) {
    const events = playerEventsInGame(game, player.id);
    const s = aggregate(events);

    const head = el(`
      <div class="statpad-head">
        <div class="num">${esc(player.number ?? "")}</div>
        <div>
          <div class="name">${esc(player.name)}</div>
          <div class="line">${s.pts} PTS · ${s.reb} REB · ${s.ast} AST · ${pctStr(s.fgm, s.fga)} TC</div>
        </div>
      </div>
    `);
    view.appendChild(head);

    const pad = el(`<div></div>`);

    // Tiro: botones grandes, agrupados por tipo (acierto/fallo en la misma fila).
    const shotGroup = el(`<div class="statgroup"><div class="statgroup-label">Tiro</div><div class="statgrid statgrid-2" id="shot-grid"></div></div>`);
    SHOT_TYPES.forEach(st => {
      const made = st.key === "ft" ? s.ftm : st.key === "p2" ? s.p2m : s.p3m;
      const att = st.key === "ft" ? s.fta : st.key === "p2" ? s.p2a : s.p3a;
      const bMade = el(`<button class="statbtn statbtn-lg made" data-type="${st.key}" data-made="1"><span class="lbl">${st.label} ✓</span><span class="cnt">${made}/${att}</span></button>`);
      const bMiss = el(`<button class="statbtn statbtn-lg miss" data-type="${st.key}" data-made="0"><span class="lbl">${st.label} ✗</span><span class="cnt">&nbsp;</span></button>`);
      shotGroup.querySelector("#shot-grid").appendChild(bMade);
      shotGroup.querySelector("#shot-grid").appendChild(bMiss);
    });
    pad.appendChild(shotGroup);

    // Otras estadísticas: 2 columnas, botones grandes (fáciles de acertar sin mirar).
    const simpleGroup = el(`<div class="statgroup"><div class="statgroup-label">Otras estadísticas</div><div class="statgrid statgrid-2" id="simple-grid"></div></div>`);
    SIMPLE_TYPES.forEach(t => {
      const count = s[t.key] !== undefined ? s[t.key] : events.filter(e => e.type === t.key).length;
      const isFoul = t.key === "foul";
      const foulOut = isFoul && count >= FOUL_LIMIT;
      const b = el(`<button class="statbtn statbtn-lg ${foulOut ? "foul-out" : ""}" data-type="${t.key}"><span class="lbl">${t.label}${isFoul && foulOut ? " ⚠" : ""}</span><span class="cnt">${isFoul ? `${count}/${FOUL_LIMIT}` : count}</span></button>`);
      simpleGroup.querySelector("#simple-grid").appendChild(b);
    });
    pad.appendChild(simpleGroup);

    view.appendChild(pad);

    pad.querySelectorAll(".statbtn").forEach(btn => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.type;
        if (type === "foul" && s.foul >= FOUL_LIMIT) {
          toast(`${player.name.split(" ")[0]} ya tiene ${FOUL_LIMIT} faltas`);
          if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
          return;
        }
        const made = btn.dataset.made === undefined ? undefined : btn.dataset.made === "1";
        const ev = { id: uid(), playerId: player.id, type, made: made === undefined ? undefined : made, ts: Date.now(), quarter: game.quarter || 1 };
        game.events.push(ev);
        saveDB();
        if (type === "foul" && s.foul + 1 >= FOUL_LIMIT) {
          toast(`${player.name.split(" ")[0]} eliminado por faltas (${FOUL_LIMIT})`);
          if (navigator.vibrate) navigator.vibrate([10, 40, 10, 40, 10]);
        } else {
          toast(statAddedMsg(type, made));
          if (navigator.vibrate) navigator.vibrate(12);
        }
        location.hash = location.hash; render();
      });
    });

    // Registro del partido, colapsado por defecto para no distraer.
    renderEventLog(view, game, player.id, true);

    // Deshacer: botón flotante siempre a mano, sin tener que buscarlo.
    const lastEv = events[events.length - 1];
    if (lastEv) {
      const fab = el(`
        <button class="undo-fab" id="undo-last" title="Deshacer: ${esc(describeEvent(lastEv))}">
          <svg viewBox="0 0 24 24">${ICONS.undo}</svg>
        </button>
      `);
      fab.addEventListener("click", () => {
        const idx = game.events.findIndex(e => e.id === lastEv.id);
        if (idx >= 0) game.events.splice(idx, 1);
        saveDB();
        toast("Deshecho: " + describeEvent(lastEv));
        if (navigator.vibrate) navigator.vibrate(8);
        location.hash = location.hash; render();
      });
      view.appendChild(fab);
    }
  }

  function renderReadOnlyPlayerStats(view, game, player, reason) {
    const events = playerEventsInGame(game, player.id);
    const s = aggregate(events);

    view.appendChild(el(`
      <div class="statpad-head">
        <div class="num">${esc(player.number ?? "")}</div>
        <div>
          <div class="name">${esc(player.name)}</div>
          <div class="line">${s.pts} PTS · ${s.reb} REB · ${s.ast} AST · ${pctStr(s.fgm, s.fga)} TC</div>
        </div>
      </div>
    `));
    view.appendChild(el(`
      <div class="stat-tiles">
        ${statTile(s.pts, "PTS")}
        ${statTile(s.reb, "REB")}
        ${statTile(s.ast, "AST")}
        ${statTile(s.stl, "ROB")}
        ${statTile(s.blk, "TAP")}
        ${statTile(s.tov, "PÉR")}
      </div>
    `));
    view.appendChild(el(`<p class="hint" style="margin:14px 2px">${esc(reason)}</p>`));
    renderEventLog(view, game, player.id, false);
  }

  function statAddedMsg(type, made) {
    if (type === "ft") return made ? "Tiro libre anotado (+1)" : "Tiro libre fallado";
    if (type === "p2") return made ? "Tiro de 2 anotado (+2)" : "Tiro de 2 fallado";
    if (type === "p3") return made ? "Triple anotado (+3)" : "Triple fallado";
    const t = SIMPLE_TYPES.find(x => x.key === type);
    return t ? t.label + " registrado" : "Registrado";
  }

  function describeEvent(ev) {
    if (ev.type === "ft" || ev.type === "p2" || ev.type === "p3") {
      const label = ev.type === "ft" ? "T. libre" : ev.type === "p2" ? "Tiro 2" : "Triple";
      return `${label} ${ev.made ? "anotado" : "fallado"}`;
    }
    const t = SIMPLE_TYPES.find(x => x.key === ev.type);
    return t ? t.label : ev.type;
  }

  let liveLogOpen = {}; // "gameId:playerId" -> bool, colapsado por defecto

  function renderEventLog(view, game, playerId, editable) {
    const events = playerEventsInGame(game, playerId).slice().reverse();
    if (!events.length) return;
    const logKey = game.id + ":" + playerId;
    const isOpen = !!liveLogOpen[logKey];
    const toggle = el(`
      <button type="button" class="log-toggle" id="log-toggle-${logKey.replace(/[^a-z0-9]/gi, "")}">
        <span>Registro del partido (${events.length})</span>
        <svg viewBox="0 0 24 24" class="${isOpen ? "open" : ""}">${ICONS.down}</svg>
      </button>
    `);
    view.appendChild(toggle);
    toggle.addEventListener("click", () => {
      liveLogOpen[logKey] = !isOpen;
      location.hash = location.hash; render();
    });
    if (!isOpen) return;
    const log = el(`<div class="card event-log"></div>`);
    events.forEach(ev => {
      const isShot = ev.type === "ft" || ev.type === "p2" || ev.type === "p3";
      const iconTxt = isShot ? (ev.made ? "✓" : "✗") : (SIMPLE_TYPES.find(t => t.key === ev.type)?.short || "?");
      const row = el(`
        <div class="event-item">
          <div class="ic" style="color:${isShot ? (ev.made ? "var(--good)" : "var(--critical)") : "var(--text-secondary)"}">${iconTxt}</div>
          <div class="tx"><b>${esc(describeEvent(ev))}</b> · Q${ev.quarter || 1}</div>
          ${editable ? `<div class="del" data-evid="${ev.id}"><svg viewBox="0 0 24 24">${ICONS.trash}</svg></div>` : ""}
        </div>
      `);
      log.appendChild(row);
    });
    view.appendChild(log);
    if (editable) {
      log.querySelectorAll(".del").forEach(d => {
        d.addEventListener("click", () => {
          const id = d.dataset.evid;
          const idx = game.events.findIndex(e => e.id === id);
          if (idx >= 0) game.events.splice(idx, 1);
          saveDB();
          location.hash = location.hash; render();
        });
      });
    }
  }

  function openGameMenu(game) {
    const isFinal = game.status === "final";
    openSheet(`
      <h3 class="modal-title">vs ${esc(game.opponent)}</h3>
      <div class="field">
        <label>Rival</label>
        <input type="text" id="gm-opponent" value="${esc(game.opponent)}">
      </div>
      <div class="field">
        <label>Fecha</label>
        <input type="date" id="gm-date" value="${esc(game.date || "")}">
      </div>
      <div class="field">
        <label>Resultado del rival (opcional)</label>
        <input type="number" id="gm-oppscore" min="0" value="${game.oppScore ?? ""}" placeholder="Sin apuntar">
      </div>
      ${isFinal ? `<button class="btn btn-ghost btn-block" id="gm-reopen" style="margin-bottom:10px">Reabrir partido</button>` : ""}
      <button class="btn btn-danger btn-block" id="gm-delete">Eliminar partido</button>
    `, {
      onMount(root) {
        root.querySelector("#gm-opponent").addEventListener("change", (e) => { game.opponent = e.target.value.trim() || "Rival"; saveDB(); });
        root.querySelector("#gm-date").addEventListener("change", (e) => { game.date = e.target.value; saveDB(); });
        root.querySelector("#gm-oppscore").addEventListener("change", (e) => {
          const v = e.target.value;
          game.oppScore = v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
          saveDB();
        });
        root.querySelector("#gm-reopen")?.addEventListener("click", () => {
          game.status = "live";
          saveDB();
          closeModal();
          location.hash = location.hash; render();
          toast("Partido reabierto");
        });
        root.querySelector("#gm-delete").addEventListener("click", () => {
          closeModal();
          confirmDialog("Eliminar partido", "Se perderán todas las estadísticas registradas en este partido. Esta acción no se puede deshacer.", "Eliminar", () => {
            DB.games = DB.games.filter(g => g.id !== game.id);
            saveDB();
            go("/");
            toast("Partido eliminado");
          }, true);
        });
      }
    });
  }

  /* ---------------------------------------------------------
     VIEW: Roster (plantilla)
     --------------------------------------------------------- */
  route("/roster", (view) => {
    view.appendChild(el(`
      <div class="pagehead">
        <div>
          <h1>Plantilla</h1>
          <div class="sub">${DB.players.length} jugador${DB.players.length === 1 ? "" : "es"}</div>
        </div>
        <button class="iconbtn" id="add-player-btn"><svg viewBox="0 0 24 24">${ICONS.plus}</svg></button>
      </div>
    `));

    if (DB.players.length === 0) {
      view.appendChild(el(emptyState(
        ICONS.team,
        "Sin jugadores",
        "Añade a los jugadores de tu equipo para empezar a registrar partidos.",
        `<button class="btn btn-primary" id="add-player-btn-2">Añadir jugador</button>`
      )));
      view.querySelector("#add-player-btn-2").addEventListener("click", () => requireAdmin(() => openPlayerForm()));
    } else {
      const card = el(`<div class="card"></div>`);
      const sorted = [...DB.players].sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
      sorted.forEach(p => {
        const row = el(`
          <a class="roster-item" href="#/player/${p.id}">
            <div class="num">${esc(p.number ?? "")}</div>
            <div class="info">
              <div class="nm">${esc(p.name)}</div>
              <div class="pos">${esc(p.position || "")}</div>
            </div>
            <div class="go"><svg viewBox="0 0 24 24">${ICONS.chevron}</svg></div>
          </a>
        `);
        card.appendChild(row);
      });
      view.appendChild(card);
    }

    view.querySelector("#add-player-btn").addEventListener("click", () => requireAdmin(() => openPlayerForm()));
  });

  function openPlayerForm(existing) {
    openSheet(`
      <h3 class="modal-title">${existing ? "Editar jugador" : "Nuevo jugador"}</h3>
      <div class="field">
        <label>Nombre</label>
        <input type="text" id="pf-name" placeholder="Nombre y apellido" value="${existing ? esc(existing.name) : ""}" autocomplete="off">
      </div>
      <div class="field">
        <label>Dorsal</label>
        <input type="number" id="pf-number" placeholder="Nº" min="0" max="99" value="${existing && existing.number !== undefined ? existing.number : ""}">
      </div>
      <div class="field">
        <label>Posición</label>
        <select id="pf-position">
          ${["", "Base", "Escolta", "Alero", "Ala-pívot", "Pívot"].map(p => `<option value="${p}" ${existing && existing.position === p ? "selected" : ""}>${p || "Sin especificar"}</option>`).join("")}
        </select>
      </div>
      <button class="btn btn-primary btn-block" id="pf-save">${existing ? "Guardar cambios" : "Añadir jugador"}</button>
    `, {
      onMount(root) {
        root.querySelector("#pf-name").focus();
        root.querySelector("#pf-save").addEventListener("click", () => {
          const name = root.querySelector("#pf-name").value.trim();
          if (!name) { toast("Escribe un nombre"); return; }
          const number = root.querySelector("#pf-number").value;
          const position = root.querySelector("#pf-position").value;
          if (existing) {
            existing.name = name;
            existing.number = number === "" ? undefined : parseInt(number, 10);
            existing.position = position;
          } else {
            DB.players.push({ id: uid(), name, number: number === "" ? undefined : parseInt(number, 10), position, createdAt: Date.now() });
          }
          saveDB();
          closeModal();
          render();
          toast(existing ? "Jugador actualizado" : "Jugador añadido");
        });
      }
    });
  }

  route("/player/:id", (view, params) => {
    const player = getPlayer(params.id);
    if (!player) { view.appendChild(el(emptyState(ICONS.team, "Jugador no encontrado", ""))); return; }
    renderPlayerDetail(view, player);
  });

  function renderPlayerDetail(view, player) {
    const events = allPlayerEvents(player.id);
    const gp = gamesPlayedBy(player.id);
    const s = aggregate(events);

    const playerHead = el(`
      <div class="pagehead">
        <div class="pagehead-left">
          <button class="iconbtn" id="back-btn"><svg viewBox="0 0 24 24">${ICONS.back}</svg></button>
          <div>
            <div class="sub">#${esc(player.number ?? "-")} · ${esc(player.position || "Jugador")}</div>
            <h1 style="font-size:26px">${esc(player.name)}</h1>
          </div>
        </div>
        <button class="iconbtn" id="edit-player-btn"><svg viewBox="0 0 24 24">${ICONS.edit}</svg></button>
      </div>
    `);
    view.appendChild(playerHead);
    playerHead.querySelector("#back-btn").addEventListener("click", () => goBack("/roster"));

    view.appendChild(el(`<div class="section-title">Promedios de temporada (${gp} PJ)</div>`));
    view.appendChild(el(`
      <div class="stat-tiles">
        ${statTile(fmtAvg(avg(s.pts, gp)), "PTS")}
        ${statTile(fmtAvg(avg(s.reb, gp)), "REB")}
        ${statTile(fmtAvg(avg(s.ast, gp)), "AST")}
        ${statTile(fmtAvg(avg(s.stl, gp)), "ROB")}
        ${statTile(fmtAvg(avg(s.blk, gp)), "TAP")}
        ${statTile(fmtAvg(avg(s.tov, gp)), "PÉRD")}
      </div>
    `));

    view.appendChild(el(`<div class="section-title">Totales acumulados</div>`));
    const totalsCard = el(`<div class="card">
      <div class="stat-tiles">
        ${statTile(s.pts, "PTS TOT.")}
        ${statTile(pctStr(s.fgm, s.fga), "TC%")}
        ${statTile(pctStr(s.p3m, s.p3a), "3P%")}
        ${statTile(pctStr(s.ftm, s.fta), "TL%")}
        ${statTile(s.oreb + "/" + s.dreb, "REB O/D")}
        ${statTile(s.foul, "FALTAS")}
      </div>
    </div>`);
    view.appendChild(totalsCard);

    // Points per game trend (last games)
    const perGame = pointsPerGameSeries(player.id);
    if (perGame.length > 1) {
      view.appendChild(el(`<div class="section-title">Puntos por partido</div>`));
      view.appendChild(pointsTrendChart(perGame));
    }

    view.querySelector("#edit-player-btn").addEventListener("click", () => requireAdmin(() => openPlayerForm(player)));
  }

  function statTile(value, label) {
    return `<div class="stat-tile"><div class="v tabular">${value}</div><div class="k">${esc(label)}</div></div>`;
  }

  function pointsPerGameSeries(playerId) {
    const games = DB.games
      .filter(g => g.events.some(e => e.playerId === playerId))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return games.map((g, i) => ({
      label: "P" + (i + 1),
      opponent: g.opponent,
      pts: aggregate(playerEventsInGame(g, playerId)).pts,
    }));
  }

  /* ---------------------------------------------------------
     Chart: simple line/area trend (points per game) — single series
     Follows dataviz spec: thin 2px line, sequential blue, markers,
     recessive grid, hover tooltip via title (lightweight).
     --------------------------------------------------------- */
  function pointsTrendChart(series) {
    const W = 600, H = 180, padL = 28, padR = 12, padT = 16, padB = 24;
    const max = Math.max(4, ...series.map(d => d.pts));
    const niceMax = Math.ceil(max / 5) * 5;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const stepX = series.length > 1 ? innerW / (series.length - 1) : 0;
    const x = (i) => padL + i * stepX;
    const y = (v) => padT + innerH - (v / niceMax) * innerH;

    const points = series.map((d, i) => `${x(i)},${y(d.pts)}`).join(" ");
    const areaPts = `${padL},${padT + innerH} ${points} ${x(series.length - 1)},${padT + innerH}`;

    const gridLines = [0, 0.5, 1].map(f => {
      const gy = padT + innerH * (1 - f);
      const val = Math.round(niceMax * f);
      return `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="var(--grid)" stroke-width="1"/>
              <text x="${padL - 6}" y="${gy + 3}" text-anchor="end" font-size="9" fill="var(--muted)">${val}</text>`;
    }).join("");

    const dots = series.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.pts)}" r="3.5" fill="var(--line)" stroke="var(--surface)" stroke-width="1.5"><title>${esc(d.opponent)}: ${d.pts} pts</title></circle>`).join("");

    const labels = series.map((d, i) => {
      if (series.length > 10 && i % Math.ceil(series.length / 8) !== 0 && i !== series.length - 1) return "";
      return `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" font-size="9" fill="var(--muted)">${i + 1}</text>`;
    }).join("");

    const wrap = el(`
      <div class="card chart-card">
        <div class="chart-title">Evolución de puntos anotados</div>
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block;--grid:var(--gridline,#2c2c2a);--muted:var(--text-muted);--line:var(--sequential-400);--surface:var(--surface-1)">
          ${gridLines}
          <polygon points="${areaPts}" fill="var(--sequential-400)" opacity="0.12"/>
          <polyline points="${points}" fill="none" stroke="var(--sequential-400)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
          ${dots}
          ${labels}
        </svg>
      </div>
    `);
    return wrap;
  }

  /* ---------------------------------------------------------
     VIEW: Season stats
     --------------------------------------------------------- */
  const STAT_METRICS = [
    { key: "pts", label: "Puntos", short: "PTS", perGame: true },
    { key: "reb", label: "Rebotes", short: "REB", perGame: true },
    { key: "ast", label: "Asistencias", short: "AST", perGame: true },
    { key: "stl", label: "Robos", short: "ROB", perGame: true },
    { key: "blk", label: "Tapones", short: "TAP", perGame: true },
    { key: "tov", label: "Pérdidas", short: "PÉR", perGame: true },
  ];
  let seasonMetric = "pts";
  let seasonFinishedOnly = false;

  route("/season", (view) => {
    view.appendChild(el(`
      <div class="pagehead">
        <div>
          <h1>Temporada</h1>
          <div class="sub">${DB.games.length} partido${DB.games.length === 1 ? "" : "s"} · ${DB.games.filter(g=>g.status==='final').length} finalizados</div>
        </div>
      </div>
    `));

    if (DB.players.length === 0 || DB.games.length === 0) {
      view.appendChild(el(emptyState(
        ICONS.chart,
        "Todavía sin datos",
        "En cuanto registres estadísticas en un partido, aquí verás los totales y promedios de la temporada.",
        ""
      )));
      return;
    }

    const filterRow = el(`
      <div class="checkbox-row" style="margin-bottom:6px">
        <input type="checkbox" id="finished-only" ${seasonFinishedOnly ? "checked" : ""}>
        <label for="finished-only" class="hint">Solo partidos finalizados</label>
      </div>
    `);
    view.appendChild(filterRow);
    filterRow.querySelector("#finished-only").addEventListener("change", (e) => {
      seasonFinishedOnly = e.target.checked;
      render();
    });

    const rows = activePlayers().map(p => {
      const events = allPlayerEvents(p.id, { finishedOnly: seasonFinishedOnly });
      const gp = gamesPlayedBy(p.id, { finishedOnly: seasonFinishedOnly });
      const s = aggregate(events);
      return { player: p, s, gp };
    }).filter(r => r.gp > 0);

    if (rows.length === 0) {
      view.appendChild(el(emptyState(ICONS.chart, "Sin partidos con datos", "Ajusta el filtro o registra estadísticas en un partido.", "")));
      return;
    }

    // Leaderboard chart
    view.appendChild(el(`<div class="section-title">Ranking</div>`));
    const pillRow = el(`<div class="pill-toggle"></div>`);
    STAT_METRICS.forEach(m => {
      const b = el(`<button type="button" class="${seasonMetric === m.key ? "active" : ""}">${m.short}</button>`);
      b.addEventListener("click", () => { seasonMetric = m.key; render(); });
      pillRow.appendChild(b);
    });
    view.appendChild(pillRow);
    view.appendChild(leaderboardChart(rows, seasonMetric));

    // Full stats table
    view.appendChild(el(`<div class="section-title">Tabla completa</div>`));
    view.appendChild(statsTable(rows));
  });

  function leaderboardChart(rows, metricKey) {
    const metric = STAT_METRICS.find(m => m.key === metricKey);
    const data = rows.map(r => ({
      name: r.player.name,
      avgVal: avg(r.s[metricKey], r.gp),
    })).sort((a, b) => b.avgVal - a.avgVal).slice(0, 10);
    const max = Math.max(1, ...data.map(d => d.avgVal));

    const card = el(`<div class="card"></div>`);
    data.forEach((d, i) => {
      const pctW = Math.max(4, (d.avgVal / max) * 100);
      const row = el(`
        <div class="leaderboard-row">
          <div class="rk">${i + 1}</div>
          <div class="nm">${esc(d.name)}</div>
          <div class="val tabular">${fmtAvg(d.avgVal)}</div>
          <div class="barwrap"><div class="bar" style="width:${pctW}%"></div></div>
        </div>
      `);
      card.appendChild(row);
    });
    const cap = el(`<div class="hint" style="margin-top:10px">Promedio de ${esc(metric.label).toLowerCase()} por partido</div>`);
    card.appendChild(cap);
    return card;
  }

  function statsTable(rows) {
    const sorted = [...rows].sort((a, b) => b.s.pts - a.s.pts);
    const wrap = el(`<div class="table-wrap"></div>`);
    const table = el(`
      <table class="stats-table">
        <thead>
          <tr>
            <th>Jugador</th><th>PJ</th><th>PTS</th><th>REB</th><th>AST</th><th>ROB</th><th>TAP</th><th>PÉR</th><th>TC%</th><th>3P%</th><th>TL%</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(r => `
            <tr data-pid="${r.player.id}">
              <td>${esc(shortName(r.player.name))}</td>
              <td>${r.gp}</td>
              <td>${fmtAvg(avg(r.s.pts, r.gp))}</td>
              <td>${fmtAvg(avg(r.s.reb, r.gp))}</td>
              <td>${fmtAvg(avg(r.s.ast, r.gp))}</td>
              <td>${fmtAvg(avg(r.s.stl, r.gp))}</td>
              <td>${fmtAvg(avg(r.s.blk, r.gp))}</td>
              <td>${fmtAvg(avg(r.s.tov, r.gp))}</td>
              <td>${pctStr(r.s.fgm, r.s.fga)}</td>
              <td>${pctStr(r.s.p3m, r.s.p3a)}</td>
              <td>${pctStr(r.s.ftm, r.s.fta)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `);
    wrap.appendChild(table);
    table.querySelectorAll("tbody tr").forEach(tr => {
      tr.addEventListener("click", () => go("/player/" + tr.dataset.pid));
    });
    return wrap;
  }

  /* ---------------------------------------------------------
     VIEW: Settings
     --------------------------------------------------------- */
  route("/settings", (view) => {
    view.appendChild(el(`
      <div class="pagehead">
        <div><h1>Ajustes</h1></div>
      </div>
    `));

    const card = el(`
      <div class="card">
        <div class="field">
          <label>Nombre del equipo</label>
          <input type="text" id="team-name" value="${esc(DB.team.name)}">
        </div>
      </div>
    `);
    view.appendChild(card);
    const teamNameInput = card.querySelector("#team-name");
    teamNameInput.addEventListener("change", (e) => {
      const newVal = e.target.value.trim() || "Mi Equipo";
      if (!isUnlocked()) {
        e.target.value = DB.team.name;
        requireAdmin(() => { DB.team.name = newVal; saveDB(); render(); toast("Guardado"); });
        return;
      }
      DB.team.name = newVal;
      saveDB();
      toast("Guardado");
    });

    view.appendChild(el(`<div class="section-title">Seguridad</div>`));
    const secCard = el(`<div class="card"></div>`);
    if (!isAdminConfigured()) {
      secCard.innerHTML = `
        <p class="hint" style="margin-bottom:14px">Activa una contraseña de administrador para que solo tú puedas crear partidos, registrar estadísticas o editar la plantilla. Cualquiera que abra este enlace podrá seguir consultando todo, pero no modificar nada sin la contraseña.</p>
        <div class="field"><label>Nueva contraseña</label><input type="password" id="sec-new1" autocomplete="new-password"></div>
        <div class="field"><label>Confirmar contraseña</label><input type="password" id="sec-new2" autocomplete="new-password"></div>
        <button class="btn btn-primary btn-block" id="sec-activate">Activar protección</button>
      `;
    } else {
      secCard.innerHTML = `
        <p class="hint" style="margin-bottom:14px">Protección activada. Este dispositivo está ${isUnlocked() ? "<b style='color:var(--good)'>desbloqueado (modo administrador)</b>" : "<b>en modo solo lectura</b>"}.</p>
        ${isUnlocked() ? `<button class="btn btn-ghost btn-block" id="sec-lock" style="margin-bottom:10px">Bloquear este dispositivo</button>` : ""}
        <button class="btn btn-ghost btn-block" id="sec-change" style="margin-bottom:10px">Cambiar contraseña</button>
        <button class="btn btn-danger btn-block" id="sec-disable">Desactivar protección</button>
      `;
    }
    view.appendChild(secCard);

    secCard.querySelector("#sec-activate")?.addEventListener("click", async () => {
      const n1 = secCard.querySelector("#sec-new1").value;
      const n2 = secCard.querySelector("#sec-new2").value;
      if (n1.length < 4) { toast("Mínimo 4 caracteres"); return; }
      if (n1 !== n2) { toast("Las contraseñas no coinciden"); return; }
      await setAdminPassword(n1);
      unlockAdmin();
      saveDB();
      render();
      toast("Protección activada");
    });
    secCard.querySelector("#sec-lock")?.addEventListener("click", () => {
      lockAdmin();
      render();
      toast("Dispositivo bloqueado");
    });
    secCard.querySelector("#sec-change")?.addEventListener("click", () => openChangePasswordSheet());
    secCard.querySelector("#sec-disable")?.addEventListener("click", () => openDisableProtectionFlow());

    view.appendChild(el(`<div class="section-title">Datos</div>`));
    const dataCard = el(`<div class="card"></div>`);
    const exportBtn = el(`<button class="btn btn-ghost btn-block" style="margin-bottom:10px"><svg viewBox="0 0 24 24">${ICONS.export}</svg>Exportar copia de seguridad</button>`);
    const importBtn = el(`<button class="btn btn-ghost btn-block" style="margin-bottom:10px">Importar copia de seguridad</button>`);
    const wipeBtn = el(`<button class="btn btn-danger btn-block">Borrar todos los datos</button>`);
    dataCard.appendChild(exportBtn);
    dataCard.appendChild(importBtn);
    dataCard.appendChild(wipeBtn);
    view.appendChild(dataCard);

    exportBtn.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(DB, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `basketstats-backup-${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast("Copia exportada");
    });

    importBtn.addEventListener("click", () => requireAdmin(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/json";
      input.addEventListener("change", () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = JSON.parse(reader.result);
            if (!data.players || !data.games) throw new Error("Formato inválido");
            confirmDialog("Importar copia", "Esto sustituirá todos los datos actuales (los de todos los que usan este enlace) por los del archivo. ¿Continuar?", "Importar", () => {
              DB = data;
              if (!DB.team) DB.team = { name: "Mi Equipo" };
              saveDB();
              render();
              toast("Datos importados");
            }, true);
          } catch (e) {
            toast("Archivo no válido");
          }
        };
        reader.readAsText(file);
      });
      input.click();
    }));

    wipeBtn.addEventListener("click", () => requireAdmin(() => {
      confirmDialog("Borrar todos los datos", "Se eliminarán todos los jugadores, partidos y estadísticas de forma permanente para todo el mundo que use este enlace.", "Borrar todo", () => {
        DB = defaultDB();
        saveDB();
        go("/");
        toast("Datos borrados");
      }, true);
    }));

    view.appendChild(el(`<div class="section-title">Acerca de</div>`));
    view.appendChild(el(`<div class="card hint">Los partidos, jugadores y estadísticas se guardan en una base de datos compartida: todo el que abra este enlace ve los mismos datos en tiempo real. Si no hay conexión, la app sigue funcionando con la última copia guardada en este dispositivo y se sincroniza en cuanto vuelve la conexión. Usa "Exportar copia de seguridad" regularmente por si acaso.</div>`));
  });

  function openChangePasswordSheet() {
    openSheet(`
      <h3 class="modal-title">Cambiar contraseña</h3>
      <div class="field"><label>Contraseña actual</label><input type="password" id="cp-cur" autocomplete="current-password"></div>
      <div class="field"><label>Nueva contraseña</label><input type="password" id="cp-new1" autocomplete="new-password"></div>
      <div class="field"><label>Confirmar nueva contraseña</label><input type="password" id="cp-new2" autocomplete="new-password"></div>
      <div id="cp-err" class="hint" style="color:var(--critical);display:none;margin-bottom:8px"></div>
      <button class="btn btn-primary btn-block" id="cp-save">Guardar</button>
    `, {
      onMount(root) {
        root.querySelector("#cp-cur").focus();
        root.querySelector("#cp-save").addEventListener("click", async () => {
          const cur = root.querySelector("#cp-cur").value;
          const n1 = root.querySelector("#cp-new1").value;
          const n2 = root.querySelector("#cp-new2").value;
          const err = root.querySelector("#cp-err");
          const ok = await checkPassword(cur);
          if (!ok || n1.length < 4 || n1 !== n2) {
            err.textContent = !ok ? "La contraseña actual no es correcta" : (n1.length < 4 ? "La nueva contraseña debe tener al menos 4 caracteres" : "Las contraseñas nuevas no coinciden");
            err.style.display = "block";
            return;
          }
          await setAdminPassword(n1);
          saveDB();
          closeModal();
          toast("Contraseña actualizada");
        });
      }
    });
  }

  function openDisableProtectionFlow() {
    openSheet(`
      <h3 class="modal-title">Desactivar protección</h3>
      <p class="hint" style="margin-bottom:14px">Cualquiera con el enlace podrá añadir y modificar datos. Confirma tu contraseña para continuar.</p>
      <div class="field"><input type="password" id="dp-cur" placeholder="Contraseña actual" autocomplete="current-password"></div>
      <div id="dp-err" class="hint" style="color:var(--critical);display:none;margin-bottom:8px">Contraseña incorrecta</div>
      <button class="btn btn-danger btn-block" id="dp-save">Desactivar protección</button>
    `, {
      onMount(root) {
        root.querySelector("#dp-cur").focus();
        root.querySelector("#dp-save").addEventListener("click", async () => {
          const cur = root.querySelector("#dp-cur").value;
          const ok = await checkPassword(cur);
          const err = root.querySelector("#dp-err");
          if (!ok) { err.style.display = "block"; return; }
          DB.admin = undefined;
          saveDB();
          closeModal();
          render();
          toast("Protección desactivada");
        });
      }
    });
  }

  /* ---------------------------------------------------------
     Init
     --------------------------------------------------------- */
  const adminToggleBtn = document.getElementById("admin-toggle");
  adminToggleBtn.addEventListener("click", () => {
    if (isUnlocked() && isAdminConfigured()) {
      confirmDialog("Bloquear modo administrador", "Este dispositivo volverá a modo solo lectura.", "Bloquear", () => {
        lockAdmin();
        renderAdminBadge();
        render();
      });
    } else if (!isUnlocked()) {
      openUnlockPrompt(() => render());
    }
  });

  render();
  initCloudSync();

  // Register service worker for installable/offline PWA (best-effort).
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
})();
