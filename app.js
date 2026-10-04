'use strict';

/* Burbujas Autolavado - app instalable (PWA).
 * Los datos viven en la hoja de Google; esta app guarda una copia local para
 * abrir al instante y se sincroniza con la API de Apps Script en segundo plano. */

const APP_VERSION = '1.3.0';

const K = {
  url: 'bur_api',
  token: 'bur_token',
  cache: 'bur_cache',
  draft: 'bur_borrador',
  recents: 'bur_recientes',
  oldUrl: 'bur_app_anterior',
  fin: 'bur_fin',
};

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* sin almacenamiento */ } },
  json(k, fallback) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
  },
};

const S = {
  view: 'hoy',
  data: null,
  loadError: '',
  syncing: false,
  lastSync: 0,
  lastFull: 0,
  draft: null,
  qClientes: '',
  pin: '',
  loginError: '',
  cobro: null,
  finalizado: null,
  fin: null,
  finMes: '',
  form: null,
  cobFiltro: '',
  cobroMulti: null,
};

// -----------------------------------------------------------------------------
// Utilidades
// -----------------------------------------------------------------------------

const nf2 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const usd = (n) => '$' + nf2.format(Number(n) || 0);
const bs = (n) => 'Bs ' + nf2.format(Number(n) || 0);
const fmtIn = (n) => r2(n).toFixed(2).replace('.', ',');

function parseNum(value) {
  let s = String(value || '').trim().replace(/\s/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function norm(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function hoyISO() {
  return (S.data && S.data.hoy) || new Date().toLocaleDateString('en-CA');
}

function fechaCorta(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function hace(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const min = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
  if (min < 1) return 'recién';
  if (min < 60) return 'hace ' + min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return 'hace ' + h + ' h';
  const dias = Math.round(h / 24);
  return 'hace ' + dias + (dias === 1 ? ' día' : ' días');
}

function diasDesde(iso) {
  const d = new Date(iso);
  return isNaN(d) ? 0 : Math.floor((Date.now() - d.getTime()) / 86400000);
}

function telWa(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('58')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  return d.length >= 10 ? '58' + d : '';
}

/** Teléfono para mostrar: 0414-1234567 (acepta 4141234567, +58 414…, 0414-…). */
function telLocal(raw) {
  const wa = telWa(raw);
  if (!wa) return String(raw || '');
  const d = '0' + wa.slice(2);
  return d.slice(0, 4) + '-' + d.slice(4);
}

function waLink(tel, text) {
  return 'https://wa.me/' + (tel || '') + '?text=' + encodeURIComponent(text);
}

function tasaHoy() {
  return S.data && S.data.tasa && S.data.tasa.tasa ? Number(S.data.tasa.tasa) : null;
}

function esGerencia() {
  const rol = S.data && S.data.usuario && S.data.usuario.rol;
  return rol === 'Dueño' || rol === 'Socio';
}

function esDueno() {
  return S.data && S.data.usuario && S.data.usuario.rol === 'Dueño';
}

function clientePorId(id) {
  return ((S.data && S.data.clientes) || []).find((c) => String(c.ID) === String(id));
}

function nombreDispositivo() {
  const ua = navigator.userAgent;
  const android = ua.match(/Android [\d.]+;\s*([^;)]+)/);
  if (android) return 'Android · ' + android[1].replace(/Build.*/, '').trim();
  if (/iPhone|iPad/.test(ua)) return 'iPhone';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac/.test(ua)) return 'Mac';
  return 'Navegador';
}

// -----------------------------------------------------------------------------
// API
// -----------------------------------------------------------------------------

/** Código único de un envío: si se reintenta, el servidor no lo guarda dos veces. */
function nuevoCodigo() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

async function api(accion, datos, idem) {
  const url = ls.get(K.url);
  let res;

  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ accion, token: ls.get(K.token), datos: datos || {}, idem: idem || '' }),
    });
  } catch (e) {
    throw new Error('Sin conexión. Revise su internet e intente de nuevo.');
  }

  const texto = await res.text().catch(() => '');
  let json;
  try {
    json = JSON.parse(texto);
  } catch (e) {
    // Apps Script devolvió una página de error: mostrar el motivo si se puede leer.
    const motivo = texto.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error('El servidor no respondió correctamente (' + res.status + '). ' +
      (motivo ? 'Detalle: ' + motivo + '. ' : '') + 'Revise si se guardó antes de repetir.');
  }

  if (!json.ok) {
    if (json.codigo === 'AUTH') {
      cerrarSesionLocal();
      render();
    }
    throw new Error(json.error || 'Ocurrió un error.');
  }

  return json.data;
}

function guardarCache() {
  if (S.data) ls.set(K.cache, JSON.stringify(S.data));
}

function aplicarEstado(estado) {
  if (!estado || !S.data) return;
  S.data.enProceso = estado.enProceso;
  S.data.pendientes = estado.pendientes;
  S.data.hoy = estado.hoy;
  if (estado.caja) S.data.caja = estado.caja;
  guardarCache();
}

async function sync(full) {
  if (S.syncing || !ls.get(K.token)) return;
  S.syncing = true;
  pintarSync();
  const habiaDatos = Boolean(S.data);

  try {
    if (full || !S.data) {
      S.data = await api('bootstrap');
      S.lastFull = Date.now();
      guardarCache();
    } else {
      aplicarEstado(await api('estado'));
    }
    S.lastSync = Date.now();
    S.loadError = '';
  } catch (e) {
    if (!habiaDatos) S.loadError = e.message;
    else if (full) toast(e.message, true);
  } finally {
    S.syncing = false;
    // No redibujar mientras escribe en otra pantalla (perdería el foco).
    if (!habiaDatos || S.view === 'hoy') render();
    else pintarSync();
  }
}

function cerrarSesionLocal() {
  ls.del(K.token);
  ls.del(K.cache);
  ls.del(K.fin);
  S.fin = null;
  S.data = null;
  S.pin = '';
  cerrarHoja();
}

// -----------------------------------------------------------------------------
// Interfaz común
// -----------------------------------------------------------------------------

const ICONOS = {
  hoy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>',
  nueva: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  clientes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.5 5.2"/></svg>',
  dinero: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="19" height="13" rx="2.5"/><path d="M2.5 10h19"/><circle cx="16.5" cy="14.5" r="1.3" fill="currentColor"/></svg>',
  mas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
};

function viewNav() {
  const items = esGerencia()
    ? [['hoy', 'Hoy'], ['clientes', 'Clientes'], ['nueva', 'Nueva'], ['dinero', 'Dinero'], ['mas', 'Más']]
    : [['hoy', 'Hoy'], ['nueva', 'Nueva'], ['clientes', 'Clientes'], ['mas', 'Más']];
  return `<nav class="nav" style="grid-template-columns:repeat(${items.length},1fr)">` + items.map(([v, label]) => {
    const ico = v === 'nueva' ? '<span class="ico">' + ICONOS[v] + '</span>' : ICONOS[v];
    return `<button type="button" class="${S.view === v ? 'on' : ''} ${v === 'nueva' ? 'new' : ''}" data-act="nav" data-v="${v}">${ico}<span>${label}</span></button>`;
  }).join('') + '</nav>';
}

function syncChipHTML() {
  if (S.syncing) return '<span class="spinner" style="width:12px;height:12px;border-width:2px"></span> Actualizando';
  const t = tasaHoy();
  return t ? 'BCV ' + nf2.format(t) : 'Sin tasa';
}

function pintarSync() {
  const el = document.getElementById('sync-chip');
  if (el) el.innerHTML = syncChipHTML();
}

function topbar(title, sub) {
  return `<header class="topbar"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
    <button type="button" class="chip sync" id="sync-chip" data-act="refrescar" aria-label="Actualizar datos">${syncChipHTML()}</button></header>`;
}

let toastTimer = null;
function toast(msg, error) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (error ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, error ? 4500 : 2500);
}

function abrirHoja(html) {
  const sheet = document.getElementById('sheet');
  sheet.innerHTML = '<div class="grab"></div>' + html;
  sheet.hidden = false;
  document.getElementById('sheet-backdrop').hidden = false;
  sheet.scrollTop = 0;
}

function cerrarHoja() {
  document.getElementById('sheet').hidden = true;
  document.getElementById('sheet-backdrop').hidden = true;
  S.cobro = null;
  S.form = null;
  S.cobroMulti = null;
}

async function conEspera(el, fn) {
  if (el && el.disabled) return;
  const original = el ? el.innerHTML : '';
  if (el) { el.disabled = true; el.innerHTML = '<span class="spinner"></span>'; }
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (el && el.isConnected) { el.disabled = false; el.innerHTML = original; }
  }
}

// -----------------------------------------------------------------------------
// Render principal
// -----------------------------------------------------------------------------

function render() {
  const app = document.getElementById('app');

  if (!ls.get(K.url)) { app.innerHTML = viewSetup(); return; }
  if (!ls.get(K.token)) { app.innerHTML = viewLogin(); return; }

  if (!S.data) {
    app.innerHTML = S.loadError
      ? `<div class="login"><div class="logo">⚠️</div><p>${esc(S.loadError)}</p>
         <button type="button" class="btn primary" data-act="reintentar">Reintentar</button>
         <button type="button" class="btn ghost mt" data-act="logout">Cerrar sesión</button></div>`
      : '<div class="login"><span class="spinner"></span><p class="mt">Cargando sus datos…</p></div>';
    return;
  }

  const views = { hoy: viewHoy, nueva: viewNueva, clientes: viewClientes, dinero: viewDinero, cobranza: viewCobranza, mas: viewMas };
  app.innerHTML = (views[S.view] || viewHoy)() + viewNav();
}

// -----------------------------------------------------------------------------
// Configuración inicial y PIN
// -----------------------------------------------------------------------------

function viewSetup() {
  return `<div class="login"><div class="logo">🫧</div><h1>Burbujas</h1>
    <p>Pegue la dirección del servidor (la URL que termina en <b>/exec</b> de su Apps Script).</p>
    <input class="input" id="setup-url" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
    <button type="button" class="btn primary block mt" data-act="guardarUrl">Continuar</button></div>`;
}

function viewLogin() {
  const dots = Array.from({ length: 6 }, (_, i) => `<span class="${i < S.pin.length ? 'on' : ''}"></span>`).join('');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => `<button type="button" data-act="tecla" data-k="${k}">${k}</button>`).join('');
  return `<div class="login"><div class="logo">🫧</div><h1>Burbujas</h1><p>Ingrese su PIN</p>
    <div class="pin-dots">${dots}</div>
    <div class="keypad">${keys}
      <button type="button" class="fn" data-act="borrarTecla">Borrar</button>
      <button type="button" data-act="tecla" data-k="0">0</button>
      <button type="button" class="fn" data-act="entrar" ${S.pin.length < 4 ? 'disabled' : ''}>Entrar</button>
    </div>
    <p class="note warn" style="min-height:20px;margin-top:16px">${esc(S.loginError)}</p></div>`;
}

// -----------------------------------------------------------------------------
// HOY
// -----------------------------------------------------------------------------

function totalBsTexto(totalUsd) {
  const t = tasaHoy();
  return t ? bs(totalUsd * t) : '';
}

function serviciosTexto(o) {
  return (o.Servicios || []).map((s) => esc(s.Nombre) + (s.Cortesia ? ' <span class="badge ok">cortesía</span>' : '')).join(' · ');
}

function vehiculoTexto(o) {
  return [o.Vehiculo, o.Placa].filter(Boolean).map(esc).join(' · ');
}

function viewHoy() {
  const d = S.data;
  const fecha = new Date().toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long' });
  const enProceso = (d.enProceso || []).slice().sort((a, b) => new Date(a.FechaCreacion) - new Date(b.FechaCreacion));
  const pendientes = (d.pendientes || []).slice().sort((a, b) => new Date(b.FechaCierre) - new Date(a.FechaCierre));
  const porCobrar = pendientes.reduce((s, o) => s + (o.TotalUSD || 0), 0);

  let html = topbar('Hoy', fecha.charAt(0).toUpperCase() + fecha.slice(1)) + '<main class="screen">';

  if (d.caja) {
    const c = d.caja;
    html += `<div class="kpis">
      <div class="kpi wide"><div class="label">Cobrado hoy</div><div class="value">${usd(c.cobradoUsd)}</div>
        <div class="hint">${bs(c.pagoMovilBs)} pago móvil · ${usd(c.efectivoUsd)} efectivo · ${c.cobros} cobro(s)${c.egresosUsd ? ' · gastos ' + usd(c.egresosUsd) : ''}</div></div>
      <div class="kpi"><div class="label">Órdenes hoy</div><div class="value">${c.ordenesHoy}</div></div>
      <div class="kpi" data-act="nav" data-v="cobranza" role="button" style="cursor:pointer"><div class="label">Por cobrar ›</div><div class="value">${usd(porCobrar)}</div><div class="hint">${pendientes.length} cotización(es)</div></div>
    </div>`;
  }

  html += `<h2 class="section">En proceso <span class="count">${enProceso.length}</span></h2>`;
  html += enProceso.length ? enProceso.map((o) => `
    <article class="card">
      <div class="card-row">
        <div><div class="name">${esc(o.ClienteNombre)}</div><div class="meta">${vehiculoTexto(o)}${o.Placa || o.Vehiculo ? ' · ' : ''}${hace(o.FechaCreacion)}</div></div>
        <div class="amount">${usd(o.TotalUSD)}<small>${totalBsTexto(o.TotalUSD)}</small></div>
      </div>
      <div class="services">${serviciosTexto(o)}</div>
      ${o.Notas ? `<div class="meta">📝 ${esc(o.Notas)}</div>` : ''}
      <div class="actions">
        <button type="button" class="btn primary" data-act="finalizar" data-id="${o.ID}">Finalizar y avisar</button>
        <button type="button" class="btn" style="flex:0 0 52px" data-act="menuOrden" data-id="${o.ID}" aria-label="Más opciones">⋯</button>
      </div>
    </article>`).join('') : '<div class="empty">No hay vehículos en proceso.<br>Toque <b>Nueva</b> para registrar uno.</div>';

  const paraRecordar = gruposCobranza().filter((g) => g.porRecordar).length;
  html += `<h2 class="section">Por cobrar <span class="count">${pendientes.length}</span>
    <button type="button" class="btn small ghost" style="margin-left:auto" data-act="nav" data-v="cobranza">Cobranza${paraRecordar ? ' · ' + paraRecordar + ' para recordar' : ''} ›</button></h2>`;
  html += pendientes.length ? pendientes.map((o) => {
    const dias = diasDesde(o.FechaCierre);
    const vieja = dias >= 3;
    return `
    <article class="card ${vieja ? 'alert' : ''}">
      <div class="card-row">
        <div><div class="name">${esc(o.ClienteNombre)}</div>
          <div class="meta"><span class="badge">${esc(o.Numero)}</span> <span class="badge ${vieja ? 'warn' : ''}">${dias === 0 ? 'hoy' : hace(o.FechaCierre)}</span></div></div>
        <div class="amount">${usd(o.TotalUSD)}<small>${totalBsTexto(o.TotalUSD)}</small></div>
      </div>
      <div class="services">${serviciosTexto(o)}</div>
      <div class="actions">
        <button type="button" class="btn ok" data-act="cobrar" data-id="${o.ID}">Cobrar</button>
        <button type="button" class="btn" style="flex:0 0 52px" data-act="menuPendiente" data-id="${o.ID}" aria-label="Más opciones">⋯</button>
      </div>
    </article>`;
  }).join('') : '<div class="empty">No hay cotizaciones pendientes de pago. 🎉</div>';

  return html + '</main>';
}

function buscarOrden(id) {
  const d = S.data;
  return (d.enProceso || []).concat(d.pendientes || []).find((o) => String(o.ID) === String(id));
}

function textoRecordatorio(o) {
  const c = clientePorId(o.ClienteID);
  const cfg = S.data.config || {};
  const t = tasaHoy();
  return '¡Hola, Sr(a). ' + (c ? c.Nombre : o.ClienteNombre).trim() + '! Le saludamos de Autolavado Burbujas.\n' +
    'Le recordamos que tiene pendiente la cotización ' + o.Numero + ' del ' + fechaCorta(o.FechaCierre) +
    ' por $' + r2(o.TotalUSD).toFixed(2) +
    (t ? ' (' + r2(o.TotalUSD * t).toFixed(2) + ' Bs a la tasa BCV de hoy: ' + t.toFixed(2) + ')' : '') + '.\n\n' +
    '💳 Datos para Pago Móvil:\n* Banco: ' + cfg.Banco + '\n* Teléfono: ' + cfg.Telefono_Pago_Movil +
    '\n* RIF/Cédula: ' + cfg.Cedula_RIF + '\n\n¡Muchas gracias por su preferencia!';
}

// -----------------------------------------------------------------------------
// COBRO
// -----------------------------------------------------------------------------

function abrirCobro(id) {
  const o = buscarOrden(id);
  if (!o) return;
  const tasa = tasaHoy();
  S.cobro = {
    id: o.ID, numero: o.Numero, cliente: o.ClienteNombre, total: o.TotalUSD,
    fecha: hoyISO(), tasa: tasa ? String(tasa).replace('.', ',') : '', modo: 'pm', bs: '', usd: '', ref: '',
    codigo: nuevoCodigo(),
  };
  prellenarCobro();
  pintarCobro();
}

function tasaCobro() {
  const t = parseNum(S.cobro.tasa);
  return t > 0 ? t : null;
}

function prellenarCobro() {
  const c = S.cobro;
  const t = tasaCobro();
  if (c.modo === 'pm') { c.bs = t ? fmtIn(c.total * t) : ''; c.usd = ''; }
  else if (c.modo === 'ef') { c.usd = fmtIn(c.total); c.bs = ''; }
  else { c.usd = ''; c.bs = ''; }
}

function equivalenteCobro() {
  const c = S.cobro;
  const t = tasaCobro();
  const u = c.modo === 'pm' ? 0 : parseNum(c.usd) || 0;
  const b = c.modo === 'ef' ? 0 : parseNum(c.bs) || 0;
  return { u, b, eq: u + (b && t ? b / t : 0), t };
}

function chequeoCobroHTML() {
  const c = S.cobro;
  const { b, eq, t } = equivalenteCobro();
  if (c.modo !== 'ef' && !t) return '<p class="note warn">Escriba la tasa BCV del día del pago para calcular los bolívares.</p>';
  const diff = r2(eq - c.total);
  if (Math.abs(diff) <= 0.10 && eq > 0) return `<p class="note check">✓ Equivale a ${usd(eq)}</p>`;
  return `<p class="note warn">Equivale a ${usd(eq)} · ${diff < 0 ? 'faltan' : 'sobran'} ${usd(Math.abs(diff))}</p>`;
}

function pintarCobro() {
  const c = S.cobro;
  const t = tasaCobro();
  const campoBs = `<label class="field">Pago móvil (Bs)<input class="input" inputmode="decimal" data-in="cobroBs" value="${esc(c.bs)}" placeholder="0,00"></label>`;
  const campoUsd = `<label class="field">Efectivo ($)<input class="input" inputmode="decimal" data-in="cobroUsd" value="${esc(c.usd)}" placeholder="0,00"></label>`;
  const campos = c.modo === 'pm' ? campoBs : c.modo === 'ef' ? campoUsd : `<div class="row2">${campoUsd}${campoBs}</div>`;

  abrirHoja(`
    <h3>Cobrar ${esc(c.numero)}</h3><div class="sub">${esc(c.cliente)}</div>
    <div class="big-amount">${usd(c.total)}<small>${t ? bs(c.total * t) : ''}</small></div>
    <div class="segmented">
      <button type="button" class="${c.modo === 'pm' ? 'on' : ''}" data-act="cobroModo" data-m="pm">Pago móvil</button>
      <button type="button" class="${c.modo === 'ef' ? 'on' : ''}" data-act="cobroModo" data-m="ef">Efectivo $</button>
      <button type="button" class="${c.modo === 'mx' ? 'on' : ''}" data-act="cobroModo" data-m="mx">Mixto</button>
    </div>
    ${campos}
    <div id="cobro-check">${chequeoCobroHTML()}</div>
    <div class="row2">
      <label class="field">Fecha del pago<input class="input" type="date" data-ch="cobroFecha" value="${esc(c.fecha)}" max="${esc(hoyISO())}"></label>
      <label class="field">Tasa BCV<input class="input" inputmode="decimal" data-in="cobroTasa" value="${esc(c.tasa)}" placeholder="0,00"></label>
    </div>
    <label class="field">Referencia (opcional)<input class="input" inputmode="numeric" data-in="cobroRef" value="${esc(c.ref)}" placeholder="Últimos dígitos"></label>
    <div class="actions">
      <button type="button" class="btn ok block" data-act="confirmarCobro">Confirmar cobro</button>
      <button type="button" class="btn ghost block" data-act="cerrarHoja">Cancelar</button>
    </div>`);
}

function refrescarChequeoCobro() {
  const el = document.getElementById('cobro-check');
  if (el) el.innerHTML = chequeoCobroHTML();
}

function setInput(name, value) {
  const el = document.querySelector(`[data-in="${name}"]`);
  if (el) el.value = value;
}

// -----------------------------------------------------------------------------
// NUEVA ORDEN
// -----------------------------------------------------------------------------

function borradorVacio() {
  return { clienteId: null, vehiculoId: null, sel: {}, notas: '', q: '', verNota: false, codigo: nuevoCodigo() };
}

function guardarBorrador() {
  ls.set(K.draft, JSON.stringify(S.draft));
}

function totalBorrador() {
  return Object.values(S.draft.sel).reduce((s, x) => s + (x.cortesia ? 0 : Number(x.precio) || 0), 0);
}

function buscarClientes(q) {
  const tokens = norm(q).split(/\s+/).filter(Boolean);
  const lista = (S.data && S.data.clientes) || [];
  if (!tokens.length) return null;
  return lista.filter((c) => {
    const hay = norm([c.Nombre, c.Telefono, telLocal(c.Telefono), telLocal(c.Telefono).replace('-', '')]
      .concat((c.Vehiculos || []).map((v) => v.Placa + ' ' + v.Vehiculo)).join(' '));
    return tokens.every((t) => hay.includes(t));
  }).slice(0, 40);
}

function vehiculosResumen(c) {
  const v = c.Vehiculos || [];
  if (!v.length) return 'Sin vehículo';
  const primero = [v[0].Vehiculo, v[0].Placa].filter(Boolean).join(' · ');
  return primero + (v.length > 1 ? ' (+' + (v.length - 1) + ')' : '');
}

function itemsClientes(lista, act) {
  if (!lista.length) return '<div class="empty">Sin resultados.</div>';
  return lista.map((c) => `<button type="button" class="list-item" data-act="${act}" data-id="${c.ID}">
      <div><div style="font-weight:600">${esc(c.Nombre)}</div><div class="meta">${esc(vehiculosResumen(c))}</div></div>
      <span class="meta">›</span></button>`).join('');
}

function resultadosNuevaHTML() {
  const res = buscarClientes(S.draft.q);
  if (res) return itemsClientes(res, 'elegirCliente');
  const recientes = ls.json(K.recents, []).map(clientePorId).filter(Boolean);
  const lista = recientes.length ? recientes : (S.data.clientes || []).slice().sort((a, b) => b.ID - a.ID).slice(0, 8);
  return `<h2 class="section">${recientes.length ? 'Recientes' : 'Últimos registrados'}</h2>` + itemsClientes(lista, 'elegirCliente');
}

function viewNueva() {
  const d = S.draft;
  const c = d.clienteId ? clientePorId(d.clienteId) : null;
  let html = topbar('Nueva orden') + '<main class="screen">';

  if (!c) {
    html += `<div class="search"><input class="input" type="search" data-in="qNueva" value="${esc(d.q)}"
        placeholder="Nombre, placa o teléfono…" autocomplete="off" enterkeyhint="search"></div>
      <button type="button" class="btn block" data-act="nuevoCliente" data-ctx="nueva">+ Cliente nuevo</button>
      <div id="res-nueva" class="mt">${resultadosNuevaHTML()}</div></main>`;
    return html;
  }

  const vehiculos = c.Vehiculos || [];
  if (!d.vehiculoId && vehiculos.length === 1) d.vehiculoId = vehiculos[0].ID;

  html += `<div class="selected-client"><div><div style="font-weight:700">${esc(c.Nombre)}</div>
      <div class="meta">${esc(c.Telefono ? telLocal(c.Telefono) : 'Sin teléfono')}</div></div>
      <button type="button" class="btn small" data-act="cambiarCliente">Cambiar</button></div>`;

  html += '<h2 class="section">Vehículo</h2><div class="pills">' +
    vehiculos.map((v) => `<button type="button" class="pill ${String(d.vehiculoId) === String(v.ID) ? 'on' : ''}" data-act="elegirVehiculo" data-id="${v.ID}">
      ${esc([v.Vehiculo, v.Placa].filter(Boolean).join(' · ') || 'Vehículo ' + v.ID)}</button>`).join('') +
    `<button type="button" class="pill" data-act="nuevoVehiculo" data-id="${c.ID}">+ Vehículo</button></div>` +
    (d.vehiculoId ? '' : `<p class="note warn">${vehiculos.length ? 'Toque el vehículo que trajo.' : 'Este cliente no tiene vehículos: agregue uno.'}</p>`);

  html += '<h2 class="section">Servicios</h2><div class="svc-grid">' + (S.data.catalogo || []).map((s) => {
    const sel = d.sel[s.ID];
    const precio = sel ? (sel.cortesia ? 'Cortesía' : usd(sel.precio)) : usd(s.Precio_USD);
    return `<div class="svc ${sel ? 'on' : ''}" data-act="toggleSvc" data-id="${s.ID}" role="button" tabindex="0">
      <div class="n">${esc(s.Nombre)}</div><div class="p">${precio}</div>
      ${sel ? `<button type="button" class="edit" data-act="editarSvc" data-id="${s.ID}">editar</button>` : ''}</div>`;
  }).join('') + '</div>';

  html += d.verNota || d.notas
    ? `<label class="field">Nota de la orden<textarea class="input" data-in="notaOrden" placeholder="Opcional">${esc(d.notas)}</textarea></label>`
    : '<button type="button" class="btn ghost mt" data-act="verNota">+ Agregar nota</button>';

  const total = totalBorrador();
  const listo = d.vehiculoId && Object.keys(d.sel).length > 0;
  html += `</main><div class="footer-bar"><div class="inner">
      <div class="total"><b id="total-usd">${usd(total)}</b><span id="total-bs">${totalBsTexto(total)}</span></div>
      <button type="button" class="btn primary" data-act="registrarOrden" ${listo ? '' : 'disabled'}>Registrar orden</button>
    </div></div>`;
  return html;
}

function hojaCliente(ctx, query) {
  S.codigoHoja = nuevoCodigo();
  const pareceP = /^[a-z0-9]{5,8}$/i.test(query || '') && /\d/.test(query || '');
  abrirHoja(`<h3>Cliente nuevo</h3>
    <label class="field">Nombre *<input class="input" id="nc-nombre" autocomplete="off" value="${pareceP ? '' : esc(query || '')}"></label>
    <label class="field">Teléfono<input class="input" id="nc-tel" type="tel" inputmode="tel" placeholder="0414 1234567"></label>
    <div class="row2">
      <label class="field">Placa<input class="input" id="nc-placa" autocapitalize="characters" autocomplete="off" value="${pareceP ? esc(query.toUpperCase()) : ''}"></label>
      <label class="field">Vehículo<input class="input" id="nc-veh" placeholder="Marca modelo color" autocomplete="off"></label>
    </div>
    <div class="actions"><button type="button" class="btn primary block" data-act="guardarCliente" data-ctx="${ctx}">Guardar cliente</button>
    <button type="button" class="btn ghost block" data-act="cerrarHoja">Cancelar</button></div>`);
  setTimeout(() => { const el = document.getElementById(pareceP ? 'nc-nombre' : (query ? 'nc-tel' : 'nc-nombre')); if (el) el.focus(); }, 50);
}

function actualizarCliente(cliente) {
  const lista = S.data.clientes || (S.data.clientes = []);
  const i = lista.findIndex((c) => String(c.ID) === String(cliente.ID));
  if (i >= 0) lista[i] = cliente; else lista.push(cliente);
  guardarCache();
}

// -----------------------------------------------------------------------------
// CLIENTES
// -----------------------------------------------------------------------------

function listaClientesHTML() {
  const res = buscarClientes(S.qClientes);
  const lista = res || (S.data.clientes || []).slice().sort((a, b) => String(a.Nombre).localeCompare(String(b.Nombre), 'es'));
  return itemsClientes(lista, 'verCliente');
}

function viewClientes() {
  return topbar('Clientes', (S.data.clientes || []).length + ' registrados') + `<main class="screen">
    <div class="search"><input class="input" type="search" data-in="qClientes" value="${esc(S.qClientes)}" placeholder="Buscar nombre, placa o teléfono…" autocomplete="off"></div>
    <button type="button" class="btn block" data-act="nuevoCliente" data-ctx="clientes">+ Cliente nuevo</button>
    <div id="res-clientes" class="mt">${listaClientesHTML()}</div></main>`;
}

function hojaDetalleCliente(id) {
  const c = clientePorId(id);
  if (!c) return;
  const tel = telWa(c.Telefono);
  abrirHoja(`<h3>${esc(c.Nombre)}</h3><div class="sub">${esc(c.Telefono ? telLocal(c.Telefono) : 'Sin teléfono')}</div>
    <div class="row2 mt">
      ${c.Telefono ? `<a class="btn" href="tel:${esc(telLocal(c.Telefono).replace('-', ''))}">📞 Llamar</a>` : '<span></span>'}
      ${tel ? `<a class="btn wa" href="${waLink(tel, '¡Hola, Sr(a). ' + c.Nombre.trim() + '! Le saludamos de Autolavado Burbujas.')}" target="_blank" rel="noopener">WhatsApp</a>` : '<span></span>'}
    </div>
    <button type="button" class="btn primary block mt" data-act="ordenParaCliente" data-id="${c.ID}">Nueva orden para este cliente</button>
    <h2 class="section">Vehículos</h2>
    ${(c.Vehiculos || []).map((v) => `<div class="list-item" style="cursor:default"><div>${esc(v.Vehiculo || 'Vehículo')}</div><span class="meta">${esc(v.Placa)}</span></div>`).join('') || '<div class="empty">Sin vehículos.</div>'}
    <button type="button" class="btn small" data-act="nuevoVehiculo" data-id="${c.ID}">+ Agregar vehículo</button>
    ${c.Notas ? `<p class="note">📝 ${esc(c.Notas)}</p>` : ''}
    <h2 class="section">Historial</h2><div id="historial" class="history"><div class="empty"><span class="spinner"></span></div></div>`);

  api('clienteDetalle', { id: c.ID }).then((h) => {
    const el = document.getElementById('historial');
    if (!el) return;
    el.innerHTML = `<div class="kpis"><div class="kpi"><div class="label">Visitas</div><div class="value">${h.visitas}</div></div>
      <div class="kpi"><div class="label">Total pagado</div><div class="value">${usd(h.totalPagadoUsd)}</div>
      <div class="hint">${h.ultimaVisita ? 'Última: ' + hace(h.ultimaVisita) : ''}</div></div></div><div class="mt">` +
      (h.ordenes.map((o) => `<div class="list-item"><div><div>${esc(o.Servicios.map((s) => s.Nombre).join(', '))}</div>
        <div class="meta">${fechaCorta(o.FechaCreacion)} · ${esc(o.Numero || 'sin número')} · ${esc(o.Estado)}</div></div><b>${usd(o.TotalUSD)}</b></div>`).join('') ||
        '<div class="empty">Sin órdenes todavía.</div>') + '</div>';
  }).catch((e) => {
    const el = document.getElementById('historial');
    if (el) el.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  });
}

function hojaVehiculo(clienteId) {
  S.codigoHoja = nuevoCodigo();
  abrirHoja(`<h3>Agregar vehículo</h3>
    <label class="field">Placa<input class="input" id="nv-placa" autocapitalize="characters" autocomplete="off"></label>
    <label class="field">Vehículo<input class="input" id="nv-veh" placeholder="Marca modelo color" autocomplete="off"></label>
    <div class="actions"><button type="button" class="btn primary block" data-act="guardarVehiculo" data-id="${clienteId}">Guardar vehículo</button>
    <button type="button" class="btn ghost block" data-act="cerrarHoja">Cancelar</button></div>`);
  setTimeout(() => document.getElementById('nv-placa').focus(), 50);
}

// -----------------------------------------------------------------------------
// MÁS
// -----------------------------------------------------------------------------

function viewMas() {
  const u = S.data.usuario || {};
  const t = S.data.tasa || {};
  const cfg = S.data.config || {};
  const old = ls.get(K.oldUrl);
  return topbar('Más') + `<main class="screen">
    <div class="card"><div class="name">${esc(u.nombre)}</div><div class="meta">${esc(u.rol)} · ${esc(nombreDispositivo())}</div></div>

    <h2 class="section">Tasa BCV</h2>
    <div class="card"><div class="card-row"><div><div class="amount" style="text-align:left">${t.tasa ? bs(t.tasa) : '—'}</div>
      <div class="meta">${esc(t.fuente || t.error || '')}${t.consultado ? ' · ' + hace(t.consultado) : ''}</div></div>
      <button type="button" class="btn small" data-act="actualizarTasa">Actualizar</button></div></div>

    <h2 class="section">Datos de pago móvil</h2>
    <div class="card"><div class="meta">${esc(cfg.Banco)} · ${esc(cfg.Telefono_Pago_Movil)} · ${esc(cfg.Cedula_RIF)}</div>
      <div class="meta">Se cambian en la pestaña Config de la hoja.</div></div>

    <h2 class="section">Opciones</h2>
    ${old ? `<a class="list-item" href="${esc(old)}" target="_blank" rel="noopener"><span>Finanzas y resúmenes (app anterior)</span><span class="meta">↗</span></a>` : ''}
    <button type="button" class="list-item" data-act="appAnterior"><span>${old ? 'Cambiar enlace de la app anterior' : 'Enlazar la app anterior (finanzas)'}</span><span class="meta">›</span></button>
    <button type="button" class="list-item" data-act="nav" data-v="cobranza"><span>Cobranza</span><span class="meta">›</span></button>
    ${esDueno() ? '<button type="button" class="list-item" data-act="usuarios"><span>Usuarios y teléfonos</span><span class="meta">›</span></button>' : ''}
    <button type="button" class="list-item" data-act="cambiarPin"><span>Cambiar mi PIN</span><span class="meta">›</span></button>
    ${esDueno() ? '<button type="button" class="list-item" data-act="completarTasas"><span>Calcular tasas del historial</span><span class="meta">›</span></button>' : ''}
    <button type="button" class="list-item" data-act="refrescarTodo"><span>Recargar todos los datos</span><span class="meta">↻</span></button>
    <button type="button" class="list-item" data-act="logout"><span style="color:var(--danger)">Cerrar sesión en este teléfono</span><span></span></button>
    <p class="note" style="text-align:center">Burbujas app ${APP_VERSION}</p></main>`;
}

async function hojaUsuarios(data) {
  if (!data) {
    abrirHoja('<h3>Usuarios y teléfonos</h3><div class="empty"><span class="spinner"></span></div>');
    try { data = await api('usuarios'); } catch (e) { toast(e.message, true); cerrarHoja(); return; }
  }
  abrirHoja(`<h3>Usuarios y teléfonos</h3>
    <h2 class="section">Usuarios</h2>
    ${data.usuarios.map((u) => `<div class="list-item" style="cursor:default"><div><div style="font-weight:600">${esc(u.nombre)}</div>
      <div class="meta">${esc(u.rol)} · ${u.activo ? 'activo' : 'inactivo'}</div></div>
      ${String(u.id) === String(S.data.usuario.id) ? '<span class="meta">usted</span>' :
        `<button type="button" class="btn small ${u.activo ? 'danger' : ''}" data-act="usuarioActivo" data-id="${u.id}" data-activo="${u.activo ? '0' : '1'}">${u.activo ? 'Desactivar' : 'Reactivar'}</button>`}</div>`).join('')}
    <h2 class="section">Teléfonos con sesión abierta</h2>
    ${data.dispositivos.map((d) => `<div class="list-item" style="cursor:default"><div><div>${esc(d.usuario)}</div>
      <div class="meta">${esc(d.dispositivo)} · usado ${hace(d.ultimoUso)}</div></div>
      <button type="button" class="btn small danger" data-act="revocar" data-id="${d.id}">Cerrar</button></div>`).join('') || '<div class="empty">Ninguno.</div>'}
    <h2 class="section">Agregar usuario</h2>
    <label class="field">Nombre<input class="input" id="nu-nombre" autocomplete="off"></label>
    <div class="row2">
      <label class="field">PIN (4 a 6 dígitos)<input class="input" id="nu-pin" inputmode="numeric" maxlength="6" autocomplete="off"></label>
      <label class="field">Rol<select class="input" id="nu-rol">
        <option value="Empleado">Empleado</option><option value="Socio">Socio</option><option value="Dueño">Dueño</option></select></label>
    </div>
    <p class="note">Empleado: registra órdenes y cobros, no ve la caja. Socio: ve todo menos usuarios.</p>
    <div class="actions"><button type="button" class="btn primary block" data-act="crearUsuario">Agregar usuario</button>
    <button type="button" class="btn ghost block" data-act="cerrarHoja">Cerrar</button></div>`);
}

// -----------------------------------------------------------------------------
// Acciones (clics)
// -----------------------------------------------------------------------------

const ACT = {
  nav(el) {
    S.view = el.dataset.v;
    render();
    window.scrollTo(0, 0);
    if (S.view === 'dinero') cargarFinanzas();
    if (S.view === 'hoy' && Date.now() - S.lastSync > 30000) sync(false);
  },
  cerrarHoja() { cerrarHoja(); },
  refrescar() { sync(Date.now() - S.lastFull > 10 * 60000); },
  refrescarTodo() { sync(true).then(() => toast('Datos actualizados')); },
  reintentar() { S.loadError = ''; render(); sync(true); },

  async guardarUrl(el) {
    const url = document.getElementById('setup-url').value.trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) {
      toast('La dirección debe empezar con https://script.google.com y terminar en /exec', true);
      return;
    }
    await conEspera(el, async () => {
      const res = await fetch(url).then((r) => r.json()).catch(() => null);
      if (!res || res.app !== 'Burbujas API') throw new Error('No se pudo conectar con esa dirección.');
      ls.set(K.url, url);
      render();
    });
  },

  tecla(el) { if (S.pin.length < 6) { S.pin += el.dataset.k; S.loginError = ''; render(); } },
  borrarTecla() { S.pin = S.pin.slice(0, -1); render(); },
  async entrar(el) {
    await conEspera(el, async () => {
      try {
        const r = await api('login', { pin: S.pin, dispositivo: nombreDispositivo() });
        ls.set(K.token, r.token);
        S.pin = ''; S.loginError = ''; S.data = null; S.view = 'hoy';
        render();
        sync(true);
      } catch (e) {
        S.pin = ''; S.loginError = e.message; render();
      }
    });
  },
  async logout() {
    if (!confirm('¿Cerrar sesión en este teléfono?')) return;
    try { await api('cerrarSesion'); } catch (e) { /* se cierra igual */ }
    cerrarSesionLocal();
    render();
  },

  // Hoy
  async finalizar(el) {
    await conEspera(el, async () => {
      const r = await api('finalizarOrden', { id: el.dataset.id }, 'fin' + el.dataset.id);
      aplicarEstado(r.estado);
      render();
      S.finalizado = r;
      hojaFinalizado(r);
    });
  },
  menuOrden(el) {
    const o = buscarOrden(el.dataset.id);
    abrirHoja(`<h3>${esc(o.ClienteNombre)}</h3><div class="sub">${vehiculoTexto(o)}</div>
      <div class="actions"><button type="button" class="btn danger block" data-act="cancelarOrden" data-id="${o.ID}">Cancelar esta orden</button>
      <button type="button" class="btn ghost block" data-act="cerrarHoja">Volver</button></div>`);
  },
  async cancelarOrden(el) {
    if (!confirm('¿Cancelar la orden? Se elimina de la lista.')) return;
    await conEspera(el, async () => {
      const r = await api('cancelarOrden', { id: el.dataset.id });
      aplicarEstado(r.estado); cerrarHoja(); render(); toast('Orden cancelada');
    });
  },
  cobrar(el) { abrirCobro(el.dataset.id); },
  menuPendiente(el) {
    const o = buscarOrden(el.dataset.id);
    const c = clientePorId(o.ClienteID);
    const tel = c ? telWa(c.Telefono) : '';
    abrirHoja(`<h3>${esc(o.Numero)} · ${esc(o.ClienteNombre)}</h3><div class="sub">${usd(o.TotalUSD)} · ${hace(o.FechaCierre)}</div>
      <div class="actions">
        <a class="btn wa block" href="${waLink(tel, textoRecordatorio(o))}" target="_blank" rel="noopener" data-act="recordado" data-ids="${o.ID}">Recordar pago por WhatsApp</a>
        ${esGerencia() ? `<button type="button" class="btn danger block" data-act="eliminarCotizacion" data-id="${o.ID}">Eliminar cotización</button>` : ''}
        <button type="button" class="btn ghost block" data-act="cerrarHoja">Volver</button></div>`);
  },
  async eliminarCotizacion(el) {
    if (!confirm('¿Eliminar esta cotización pendiente? No se puede deshacer.')) return;
    await conEspera(el, async () => {
      const r = await api('eliminarCotizacion', { id: el.dataset.id });
      aplicarEstado(r.estado); cerrarHoja(); render(); toast('Cotización eliminada');
    });
  },
  copiarTexto() {
    const r = S.finalizado;
    navigator.clipboard.writeText(r.texto).then(() => toast('Mensaje copiado'), () => toast('No se pudo copiar', true));
  },
  cobrarFinalizado() {
    const o = (S.data.pendientes || []).find((p) => p.Numero === S.finalizado.numero);
    if (o) abrirCobro(o.ID); else cerrarHoja();
  },

  // Cobro
  cobroModo(el) { S.cobro.modo = el.dataset.m; prellenarCobro(); pintarCobro(); },
  async confirmarCobro(el) {
    const c = S.cobro;
    const { u, b, eq, t } = equivalenteCobro();
    if (isNaN(u) || isNaN(b)) { toast('Revise los montos.', true); return; }
    if (b > 0 && !t) { toast('Indique la tasa BCV.', true); return; }
    if (Math.abs(r2(eq - c.total)) > 0.10) { toast('El monto no coincide con el total de la cotización.', true); return; }
    await conEspera(el, async () => {
      const r = await api('registrarPago', {
        id: c.id, PagoMovilBs: b, EfectivoUsd: u, Fecha: c.fecha, Tasa: b > 0 ? t : '', Referencia: c.ref,
      }, c.codigo);
      aplicarEstado(r.estado); cerrarHoja(); render(); toast('Cobro registrado ✓');
    });
  },

  // Nueva orden
  nuevoCliente(el) { hojaCliente(el.dataset.ctx, el.dataset.ctx === 'nueva' ? S.draft.q.trim() : S.qClientes.trim()); },
  async guardarCliente(el) {
    const datos = {
      Nombre: document.getElementById('nc-nombre').value,
      Telefono: document.getElementById('nc-tel').value,
      Placa: document.getElementById('nc-placa').value,
      Vehiculo: document.getElementById('nc-veh').value,
    };
    if (!datos.Nombre.trim()) { toast('Escriba el nombre del cliente.', true); return; }
    await conEspera(el, async () => {
      const r = await api('crearCliente', datos, S.codigoHoja);
      actualizarCliente(r.cliente);
      cerrarHoja();
      if (el.dataset.ctx === 'nueva') {
        Object.assign(S.draft, { clienteId: r.cliente.ID, vehiculoId: r.vehiculoId || null, q: '' });
        guardarBorrador();
      }
      render(); toast('Cliente guardado');
    });
  },
  elegirCliente(el) {
    Object.assign(S.draft, { clienteId: Number(el.dataset.id), vehiculoId: null, q: '' });
    guardarBorrador(); render(); window.scrollTo(0, 0);
  },
  cambiarCliente() { Object.assign(S.draft, { clienteId: null, vehiculoId: null }); guardarBorrador(); render(); },
  elegirVehiculo(el) { S.draft.vehiculoId = Number(el.dataset.id); guardarBorrador(); render(); },
  nuevoVehiculo(el) { hojaVehiculo(el.dataset.id); },
  async guardarVehiculo(el) {
    const datos = {
      clienteId: el.dataset.id,
      Placa: document.getElementById('nv-placa').value,
      Vehiculo: document.getElementById('nv-veh').value,
    };
    if (!datos.Placa.trim() && !datos.Vehiculo.trim()) { toast('Indique la placa o el vehículo.', true); return; }
    await conEspera(el, async () => {
      const r = await api('agregarVehiculo', datos, S.codigoHoja);
      actualizarCliente(r.cliente);
      if (String(S.draft.clienteId) === String(datos.clienteId)) { S.draft.vehiculoId = r.vehiculoId; guardarBorrador(); }
      cerrarHoja(); render(); toast('Vehículo agregado');
    });
  },
  toggleSvc(el, ev) {
    if (ev.target.closest('.edit')) return;
    const id = el.dataset.id;
    if (S.draft.sel[id]) delete S.draft.sel[id];
    else {
      const s = S.data.catalogo.find((x) => String(x.ID) === String(id));
      S.draft.sel[id] = { precio: s.Precio_USD, cortesia: false };
    }
    guardarBorrador(); render();
  },
  editarSvc(el) {
    const id = el.dataset.id;
    const s = S.data.catalogo.find((x) => String(x.ID) === String(id));
    const sel = S.draft.sel[id];
    abrirHoja(`<h3>${esc(s.Nombre)}</h3><div class="sub">Precio de catálogo: ${usd(s.Precio_USD)}</div>
      <label class="field">Precio para esta orden ($)<input class="input" id="es-precio" inputmode="decimal" value="${fmtIn(sel.precio)}"></label>
      <label class="field" style="display:flex;align-items:center;gap:10px;font-size:16px;color:var(--text)">
        <input type="checkbox" id="es-cortesia" ${sel.cortesia ? 'checked' : ''} style="width:22px;height:22px"> Es cortesía (no se cobra)</label>
      <div class="actions"><button type="button" class="btn primary block" data-act="guardarSvc" data-id="${id}">Listo</button>
      <button type="button" class="btn ghost block" data-act="cerrarHoja">Cancelar</button></div>`);
  },
  guardarSvc(el) {
    const precio = parseNum(document.getElementById('es-precio').value);
    if (isNaN(precio) || precio < 0) { toast('Precio no válido.', true); return; }
    S.draft.sel[el.dataset.id] = { precio: r2(precio), cortesia: document.getElementById('es-cortesia').checked };
    guardarBorrador(); cerrarHoja(); render();
  },
  verNota() { S.draft.verNota = true; render(); const t = document.querySelector('[data-in="notaOrden"]'); if (t) t.focus(); },
  async registrarOrden(el) {
    const d = S.draft;
    const servicios = Object.entries(d.sel).map(([id, x]) => ({ ID: Number(id), Precio_USD: x.precio, Cortesia: x.cortesia }));
    await conEspera(el, async () => {
      if (!d.codigo) d.codigo = nuevoCodigo();
      const r = await api('crearOrden', { clienteId: d.clienteId, vehiculoId: d.vehiculoId, servicios, notas: d.notas }, d.codigo);
      aplicarEstado(r.estado);
      const rec = [d.clienteId].concat(ls.json(K.recents, []).filter((x) => String(x) !== String(d.clienteId))).slice(0, 8);
      ls.set(K.recents, JSON.stringify(rec));
      S.draft = borradorVacio(); guardarBorrador();
      S.view = 'hoy'; render(); window.scrollTo(0, 0); toast('Orden registrada ✓');
    });
  },

  // Clientes
  verCliente(el) { hojaDetalleCliente(el.dataset.id); },
  ordenParaCliente(el) {
    S.draft = Object.assign(borradorVacio(), { clienteId: Number(el.dataset.id) });
    guardarBorrador(); cerrarHoja(); S.view = 'nueva'; render(); window.scrollTo(0, 0);
  },

  // Más
  async actualizarTasa(el) {
    await conEspera(el, async () => {
      S.data.tasa = await api('tasa', { forzar: true });
      guardarCache(); render();
      if (S.data.tasa.error) toast(S.data.tasa.error, true); else toast('Tasa actualizada');
    });
  },
  appAnterior() {
    const url = prompt('Pegue el enlace de la app anterior (la de Apps Script):', ls.get(K.oldUrl) || '');
    if (url === null) return;
    if (url.trim() && !/^https:\/\//.test(url.trim())) { toast('El enlace debe empezar con https://', true); return; }
    if (url.trim()) ls.set(K.oldUrl, url.trim()); else ls.del(K.oldUrl);
    render();
  },
  usuarios() { hojaUsuarios(); },
  async crearUsuario(el) {
    const datos = {
      nombre: document.getElementById('nu-nombre').value,
      pin: document.getElementById('nu-pin').value,
      rol: document.getElementById('nu-rol').value,
    };
    await conEspera(el, async () => { hojaUsuarios(await api('usuarioCrear', datos)); toast('Usuario agregado'); });
  },
  async usuarioActivo(el) {
    const activo = el.dataset.activo === '1';
    let pin = '';
    if (activo) {
      pin = prompt('PIN nuevo para este usuario (4 a 6 dígitos):') || '';
      if (!pin) return;
    } else if (!confirm('¿Desactivar este usuario? Se cerrarán sus sesiones.')) return;
    await conEspera(el, async () => { hojaUsuarios(await api('usuarioActivo', { id: el.dataset.id, activo, pin })); });
  },
  async revocar(el) {
    if (!confirm('¿Cerrar la sesión de ese teléfono?')) return;
    await conEspera(el, async () => { hojaUsuarios(await api('dispositivoRevocar', { id: el.dataset.id })); });
  },
  cambiarPin() {
    abrirHoja(`<h3>Cambiar mi PIN</h3>
      <label class="field">PIN actual<input class="input" id="cp-actual" inputmode="numeric" type="password" maxlength="6"></label>
      <label class="field">PIN nuevo (4 a 6 dígitos)<input class="input" id="cp-nuevo" inputmode="numeric" type="password" maxlength="6"></label>
      <div class="actions"><button type="button" class="btn primary block" data-act="guardarPin">Guardar</button>
      <button type="button" class="btn ghost block" data-act="cerrarHoja">Cancelar</button></div>`);
  },
  async guardarPin(el) {
    await conEspera(el, async () => {
      await api('cambiarPin', { pinActual: document.getElementById('cp-actual').value, pinNuevo: document.getElementById('cp-nuevo').value });
      cerrarHoja(); toast('PIN actualizado');
    });
  },
};

function hojaFinalizado(r) {
  abrirHoja(`<h3>Cotización ${esc(r.numero)} lista</h3>
    <div class="big-amount">${usd(r.totalUsd)}<small>${r.esCortesia ? 'Cortesía' : bs(r.totalBs)}</small></div>
    <div class="actions">
      <a class="btn wa block" href="${waLink(r.telefonoWa, r.texto)}" target="_blank" rel="noopener">Enviar por WhatsApp</a>
      <button type="button" class="btn block" data-act="copiarTexto">Copiar mensaje</button>
      ${r.esCortesia ? '' : '<button type="button" class="btn ok block" data-act="cobrarFinalizado">Cobrar ahora</button>'}
      <button type="button" class="btn ghost block" data-act="cerrarHoja">Cerrar</button>
    </div>
    ${r.telefonoWa ? '' : '<p class="note warn">El cliente no tiene teléfono: WhatsApp le pedirá elegir el contacto.</p>'}`);
}

// -----------------------------------------------------------------------------
// Entradas de texto
// -----------------------------------------------------------------------------

const INP = {
  qNueva(el) {
    S.draft.q = el.value;
    const res = document.getElementById('res-nueva');
    if (res) res.innerHTML = resultadosNuevaHTML();
  },
  qClientes(el) {
    S.qClientes = el.value;
    const res = document.getElementById('res-clientes');
    if (res) res.innerHTML = listaClientesHTML();
  },
  notaOrden(el) { S.draft.notas = el.value; guardarBorrador(); },
  cobroBs(el) {
    const c = S.cobro; c.bs = el.value;
    if (c.modo === 'mx') {
      const t = tasaCobro(); const b = parseNum(c.bs) || 0;
      c.usd = t ? fmtIn(Math.max(0, c.total - b / t)) : c.usd; setInput('cobroUsd', c.usd);
    }
    refrescarChequeoCobro();
  },
  cobroUsd(el) {
    const c = S.cobro; c.usd = el.value;
    if (c.modo === 'mx') {
      const t = tasaCobro(); const u = parseNum(c.usd) || 0;
      c.bs = t ? fmtIn(Math.max(0, c.total - u) * t) : c.bs; setInput('cobroBs', c.bs);
    }
    refrescarChequeoCobro();
  },
  cobroTasa(el) {
    const c = S.cobro; c.tasa = el.value;
    const t = tasaCobro();
    if (t && c.modo !== 'ef') {
      const u = c.modo === 'mx' ? parseNum(c.usd) || 0 : 0;
      c.bs = fmtIn(Math.max(0, c.total - u) * t); setInput('cobroBs', c.bs);
    }
    refrescarChequeoCobro();
  },
  cobroRef(el) { S.cobro.ref = el.value; },
};

const CH = {
  async cobroFecha(el) {
    const c = S.cobro;
    c.fecha = el.value || hoyISO();
    try {
      const r = await api('tasaFecha', { fecha: c.fecha });
      c.tasa = r && r.tasa ? String(r.tasa).replace('.', ',') : '';
      if (!c.tasa) toast('No hay tasa guardada para ese día. Escríbala.', true);
    } catch (e) {
      toast(e.message, true);
    }
    if (S.cobro !== c) return;
    if (c.modo !== 'ef') {
      const t = tasaCobro();
      const u = c.modo === 'mx' ? parseNum(c.usd) || 0 : 0;
      c.bs = t ? fmtIn(Math.max(0, c.total - u) * t) : '';
    }
    pintarCobro();
  },
};

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = ACT[el.dataset.act];
  if (fn) fn(el, ev);
});

document.addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-in]');
  if (el && INP[el.dataset.in]) INP[el.dataset.in](el, ev);
});

document.addEventListener('change', (ev) => {
  const el = ev.target.closest('[data-ch]');
  if (el && CH[el.dataset.ch]) CH[el.dataset.ch](el, ev);
});

document.getElementById('sheet-backdrop').addEventListener('click', cerrarHoja);

// Al volver a la app, actualizar en segundo plano.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.data && Date.now() - S.lastSync > 60000) {
    sync(Date.now() - S.lastFull > 30 * 60000);
  }
});

// -----------------------------------------------------------------------------
// DINERO (etapa 2): corte, saldos, gastos, empleados y resumen del mes
// -----------------------------------------------------------------------------

async function cargarFinanzas(mes) {
  try {
    const r = await api('finanzas', { mes: mes || S.finMes });
    S.fin = r;
    S.finMes = r.mes.clave;
    ls.set(K.fin, JSON.stringify(r));
    S.finError = '';
    if (S.view === 'dinero') render();
  } catch (e) {
    S.finError = e.message;
    if (S.view === 'dinero') render();
    toast(e.message, true);
  }
}

function aplicarFinanzas(r) {
  S.fin = r;
  S.finMes = r.mes.clave;
  ls.set(K.fin, JSON.stringify(r));
  if (S.view === 'dinero') render();
  S.lastSync = 0; // la caja de Hoy se actualiza al volver a esa pantalla
}

function empleadoFin(id) {
  return ((S.fin && S.fin.empleados) || []).find((e) => String(e.ID) === String(id));
}

function fechaDia(clave) {
  return fechaCorta(clave + 'T12:00:00');
}

function viewDinero() {
  const f = S.fin;
  let html = topbar('Dinero') + '<main class="screen">';

  if (!f) {
    return html + (S.finError
      ? `<div class="empty"><p>No se pudieron cargar las finanzas:<br><b>${esc(S.finError)}</b></p>
         ${S.finError.indexOf('no reconocida') !== -1 ? '<p>El servidor (Apps Script) aún tiene la versión anterior. Publique una <b>Nueva versión</b> en Gestionar implementaciones.</p>' : ''}
         <button type="button" class="btn primary" data-act="reintentarFin">Reintentar</button></div>`
      : '<div class="empty"><span class="spinner"></span><p>Cargando finanzas…</p></div>') + '</main>';
  }

  if (!f.corte) {
    html += `<div class="card alert"><div class="name">Empiece con un corte</div>
      <div class="meta">Anote lo que tiene hoy en el banco y en efectivo. Desde esa fecha la app calcula sus saldos.</div>
      <div class="actions">${esDueno() ? '<button type="button" class="btn primary" data-act="hojaCorte">Hacer el corte</button>' : '<span class="meta">Solo el dueño puede hacer el corte.</span>'}</div></div>`;
  } else {
    const s = f.saldos;
    html += `<div class="kpis">
      <div class="kpi"><div class="label">Banco</div><div class="value" style="font-size:19px">${bs(s.bancoBs)}</div>
        <div class="hint">${f.tasaHoy ? '≈ ' + usd(s.bancoBs / f.tasaHoy) : ''}</div></div>
      <div class="kpi"><div class="label">Efectivo</div><div class="value">${usd(s.efectivoUsd)}</div></div>
      <div class="kpi wide"><div class="card-row"><div><div class="label">Total disponible</div><div class="value">≈ ${usd(s.totalUsd)}</div>
        <div class="hint">Desde el corte del ${fechaDia(f.corte.fecha)}</div></div>
        ${esDueno() ? '<button type="button" class="btn small ghost" data-act="hojaCorte">Rehacer corte</button>' : ''}</div></div>
    </div>`;
  }

  html += `<div class="row2 mt">
    <button type="button" class="btn primary" data-act="hojaGasto">+ Gasto</button>
    <button type="button" class="btn" data-act="hojaEmpleados">Empleados</button></div>`;

  const m = f.mes;
  const esMesActual = m.clave >= f.hoy.slice(0, 7);
  html += `<div class="month-nav"><button type="button" class="btn small" data-act="mesCambio" data-d="-1" aria-label="Mes anterior">‹</button>
    <b>${esc(m.texto.charAt(0).toUpperCase() + m.texto.slice(1))}</b>
    <button type="button" class="btn small" data-act="mesCambio" data-d="1" ${esMesActual ? 'disabled' : ''} aria-label="Mes siguiente">›</button></div>`;

  html += `<div class="kpis">
    <div class="kpi"><div class="label">Ventas</div><div class="value">${usd(m.ventasUsd)}</div><div class="hint">${m.cobros} cobro(s)</div></div>
    <div class="kpi"><div class="label">Gastos</div><div class="value">${usd(m.gastosUsd)}</div></div>
    <div class="kpi wide"><div class="label">Ganancia (ventas − gastos)</div>
      <div class="value" style="color:var(${m.gananciaUsd >= 0 ? '--ok' : '--danger'})">${usd(m.gananciaUsd)}</div>
      ${m.retirosUsd ? `<div class="hint">Retiros de socio: ${usd(m.retirosUsd)} (no se restan de la ganancia)</div>` : ''}</div>
  </div>`;

  if (m.gastos === 'parcial') html += `<p class="note warn">Gastos registrados desde el corte (${fechaDia(f.corte.fecha)}). Los de días anteriores de este mes pueden faltar.</p>`;
  if (m.gastos === 'incompleto') html += '<p class="note warn">' + (f.corte ? 'Mes anterior al corte' : 'Todavía no hay corte') + ': los gastos pueden estar incompletos, así que la ganancia no es exacta. Las ventas sí son completas.</p>';

  if (m.porCategoria.length) {
    const max = Math.max(...m.porCategoria.map((c) => c.usd)) || 1;
    html += '<h2 class="section">Gastos por categoría</h2>' + m.porCategoria.map((c) => `
      <div class="cat-row"><div class="card-row"><span>${esc(c.categoria)}</span><b>${usd(c.usd)}</b></div>
      <div class="bar"><span style="width:${Math.round((c.usd / max) * 100)}%"></span></div></div>`).join('');
  }

  if (f.historial.length > 1) {
    html += '<h2 class="section">Últimos meses</h2><div class="card" style="padding:6px 12px">' + f.historial.map((h) => `
      <div class="hist-row"><span>${esc(h.texto)}</span><span>${usd(h.ventasUsd)}</span><span>${usd(h.gastosUsd)}${h.gastos === 'completo' ? '' : '*'}</span>
      <b style="color:var(${h.gananciaUsd >= 0 ? '--ok' : '--danger'})">${usd(h.gananciaUsd)}</b></div>`).join('') +
      '<div class="hist-row meta"><span></span><span>ventas</span><span>gastos</span><span>ganancia</span></div></div>' +
      (f.historial.some((h) => h.gastos !== 'completo') ? '<p class="note">* gastos incompletos (antes del corte)</p>' : '');
  }

  html += `<h2 class="section">Movimientos${f.corte ? ' desde el corte' : ''}</h2>`;
  html += f.movimientos.length ? f.movimientos.map((x) => {
    const entra = x.EquivalenteUSD > 0 || (x.Tipo === 'AJUSTE_SALDO' && x.EquivalenteUSD >= 0);
    const signo = x.Tipo === 'AJUSTE_PRESTAMO' ? '±' : (entra ? '+' : '−');
    const principal = x.Moneda === 'VES' ? bs(x.Monto) : usd(x.Monto);
    return `<button type="button" class="list-item" data-act="hojaMovimiento" data-id="${x.ID}">
      <div><div style="font-weight:600">${esc(x.Categoria)}${x.Persona ? ' · ' + esc(x.Persona) : ''}</div>
      <div class="meta">${fechaDia(x.Fecha)} · ${esc(x.Medio)}</div></div>
      <div class="amount" style="font-size:15px;color:var(${signo === '+' ? '--ok' : '--text'})">${signo} ${principal}
      ${x.Moneda === 'VES' && x.EquivalenteUSD ? `<small>≈ ${usd(Math.abs(x.EquivalenteUSD))}</small>` : ''}</div></button>`;
  }).join('') : '<div class="empty">Sin movimientos todavía.</div>';

  return html + '</main>';
}

// Formularios de dinero: el estado vive en S.form y se redibuja con pintarForm().

function nuevoForm(hoja, extra) {
  const t = (S.fin && S.fin.tasaHoy) || tasaHoy();
  S.form = Object.assign({
    hoja,
    codigo: nuevoCodigo(),
    fecha: hoyISO(),
    tasa: t ? String(Math.round(t * 10000) / 10000).replace('.', ',') : '',
    moneda: 'VES',
  }, extra);
  pintarForm();
}

function campo(label, k, extra) {
  const v = S.form[k] == null ? '' : S.form[k];
  return `<label class="field">${label}<input class="input" data-in="f" data-k="${k}" value="${esc(v)}" ${extra || 'inputmode="decimal"'}></label>`;
}

function monedaHTML() {
  return `<div class="segmented two">
    <button type="button" class="${S.form.moneda === 'VES' ? 'on' : ''}" data-act="fMoneda" data-m="VES">Bs (banco)</button>
    <button type="button" class="${S.form.moneda === 'USD' ? 'on' : ''}" data-act="fMoneda" data-m="USD">$ efectivo</button></div>`;
}

function fechaTasaHTML() {
  return `<div class="row2">
    <label class="field">Fecha<input class="input" type="date" data-ch="fFecha" value="${esc(S.form.fecha)}" max="${esc(hoyISO())}"></label>
    ${S.form.moneda === 'VES' ? campo('Tasa BCV', 'tasa') : '<span></span>'}</div>`;
}

function botonesForm(label) {
  return `<div id="form-eq">${eqFormHTML()}</div>
    <div class="actions"><button type="button" class="btn primary block" data-act="fGuardar">${label}</button>
    <button type="button" class="btn ghost block" data-act="${S.form.volver ? 'hojaEmpleados' : 'cerrarHoja'}">${S.form.volver ? 'Volver' : 'Cancelar'}</button></div>`;
}

function fNum(k) {
  return parseNum(S.form[k]);
}

function netoSemana() {
  const e = empleadoFin(S.form.empleadoId);
  return r2((fNum('sueldo') || 0) - (e ? e.adelantosUsd : 0) - (fNum('descuento') || 0));
}

function eqFormHTML() {
  const f = S.form;
  const t = fNum('tasa');
  const enBs = (monto) => (f.moneda === 'VES' && t > 0 ? bs(monto * t) : '');

  if (f.hoja === 'gasto') {
    return f.moneda === 'VES' && t > 0 && fNum('monto') > 0 ? `<p class="note">≈ ${usd(fNum('monto') / t)}</p>` : '';
  }
  if (f.hoja === 'adelanto' || (f.hoja === 'deuda' && f.modo === 'prestar')) {
    const u = fNum('montoUsd');
    return u > 0 ? `<p class="note check">${usd(u)}${enBs(u) ? ' = ' + enBs(u) : ''}</p>` : '';
  }
  if (f.hoja === 'pagar') {
    const n = netoSemana();
    return n < 0
      ? '<p class="note warn">Los adelantos y el descuento superan el sueldo.</p>'
      : `<div class="big-amount" style="font-size:24px">A pagar: ${usd(n)}<small>${enBs(n)}</small></div>`;
  }
  return '';
}

function pintarForm() {
  const fn = HOJAS_FORM[S.form.hoja];
  if (fn) abrirHoja(fn(S.form));
}

const HOJAS_FORM = {
  corte(f) {
    const empleados = (S.fin && S.fin.empleados) || [];
    const rehacer = S.fin && S.fin.corte;
    return `<h3>${rehacer ? 'Rehacer corte' : 'Hacer el corte'}</h3>
      <div class="sub">Lo que tiene hoy. Desde esta fecha la app calcula los saldos; lo anterior queda como historial.</div>
      <label class="field">Fecha del corte<input class="input" type="date" data-ch="fFecha" value="${esc(f.fecha)}"></label>
      ${campo('Saldo en banco (Bs)', 'bancoBs')}
      ${campo('Efectivo en caja ($)', 'efectivoUsd')}
      <h2 class="section">Deudas de empleados ($)</h2>
      ${empleados.map((e) => campo(esc(e.Nombre), 'deuda_' + e.ID)).join('')}
      <p class="note">Si alguien no debe nada, déjelo vacío.${rehacer ? ' Al rehacer, se reemplazan los saldos del corte anterior.' : ''}</p>
      ${botonesForm('Guardar corte')}`;
  },
  gasto(f) {
    const empleados = (S.fin && S.fin.empleados) || [];
    const pill = (k, v) => `<button type="button" class="pill ${f[k] === v ? 'on' : ''}" data-act="fSet" data-k="${k}" data-v="${esc(v)}">${esc(v)}</button>`;
    return `<h3>Registrar gasto</h3>
      <div class="pills">${S.fin.categorias.map((c) => pill('categoria', c)).join('')}</div>
      ${f.categoria === 'Pago empleado' ? `<p class="note">Para sueldos y adelantos es mejor usar <b>Empleados</b>: así se descuentan solos.</p>
        <div class="pills">${empleados.map((e) => pill('persona', e.Nombre)).join('')}</div>` : ''}
      ${monedaHTML()}
      ${campo(f.moneda === 'VES' ? 'Monto (Bs)' : 'Monto ($)', 'monto')}
      ${fechaTasaHTML()}
      ${campo('Nota (opcional)', 'notas', 'autocomplete="off"')}
      ${botonesForm('Guardar gasto')}`;
  },
  adelanto(f) {
    const e = empleadoFin(f.empleadoId);
    const dia = e.SueldoSemanalUSD / e.DiasSemana;
    return `<h3>Adelanto a ${esc(e.Nombre)}</h3><div class="sub">1 día = ${usd(dia)} (${usd(e.SueldoSemanalUSD)} ÷ ${e.DiasSemana} días)</div>
      <div class="pills">${[1, 2].map((n) => `<button type="button" class="pill ${fNum('montoUsd') === r2(dia * n) ? 'on' : ''}" data-act="fSet" data-k="montoUsd" data-v="${fmtIn(dia * n)}">${n} día${n > 1 ? 's' : ''}</button>`).join('')}</div>
      ${campo('Monto ($)', 'montoUsd')}
      ${monedaHTML()}
      ${fechaTasaHTML()}
      ${botonesForm('Registrar adelanto')}`;
  },
  pagar(f) {
    const e = empleadoFin(f.empleadoId);
    return `<h3>Pagar semana · ${esc(e.Nombre)}</h3>
      ${campo('Sueldo de la semana ($)', 'sueldo')}
      <div class="list-item" style="cursor:default"><span>− Adelantos ya entregados</span><b>${usd(e.adelantosUsd)}</b></div>
      ${e.deudaUsd > 0 ? campo(`− Descuento de deuda ($) · debe ${usd(e.deudaUsd)}`, 'descuento') : ''}
      ${monedaHTML()}
      ${fechaTasaHTML()}
      ${botonesForm('Confirmar pago')}`;
  },
  deuda(f) {
    const e = empleadoFin(f.empleadoId);
    return `<h3>Deuda de ${esc(e.Nombre)}</h3><div class="sub">Debe ahora: <b>${usd(e.deudaUsd)}</b></div>
      <div class="segmented two">
        <button type="button" class="${f.modo === 'ajustar' ? 'on' : ''}" data-act="fSet" data-k="modo" data-v="ajustar">Corregir monto</button>
        <button type="button" class="${f.modo === 'prestar' ? 'on' : ''}" data-act="fSet" data-k="modo" data-v="prestar">Prestar dinero</button></div>
      ${f.modo === 'ajustar'
        ? campo('Deuda correcta ($)', 'nueva') + '<p class="note">No mueve dinero: solo corrige lo que debe.</p>'
        : campo('Monto prestado ($)', 'montoUsd') + monedaHTML() + fechaTasaHTML() + '<p class="note">Sale de la caja y se suma a la deuda.</p>'}
      ${campo('Motivo (opcional)', 'motivo', 'autocomplete="off"')}
      ${botonesForm('Guardar')}`;
  },
  empleado(f) {
    return `<h3>${f.ID ? 'Editar empleado' : 'Agregar empleado'}</h3>
      ${campo('Nombre', 'Nombre', 'autocomplete="off"')}
      <div class="row2">${campo('Sueldo semanal ($)', 'SueldoSemanalUSD')}${campo('Días por semana', 'DiasSemana', 'inputmode="numeric"')}</div>
      ${campo('Descuento semanal de deuda ($)', 'DescuentoSemanalUSD')}
      <p class="note">El descuento se propone al pagar la semana; puede cambiarlo cada vez.</p>
      ${f.ID ? `<label class="field" style="display:flex;align-items:center;gap:10px;font-size:16px;color:var(--text)">
        <input type="checkbox" data-act="fToggleActivo" ${f.Activo !== false ? 'checked' : ''} style="width:22px;height:22px"> Activo</label>` : ''}
      ${botonesForm('Guardar')}`;
  },
};

function hojaEmpleados() {
  S.form = null;
  const lista = (S.fin && S.fin.empleados) || [];
  abrirHoja(`<h3>Empleados</h3>
    ${lista.map((e) => `<div class="card">
      <div class="card-row"><div><div class="name">${esc(e.Nombre)}</div>
        <div class="meta">${usd(e.SueldoSemanalUSD)}/semana${e.ultimoPago ? ' · último pago ' + fechaDia(e.ultimoPago) : ''}</div></div>
        ${esDueno() ? `<button type="button" class="btn small ghost" data-act="hojaEmpleado" data-id="${e.ID}">Editar</button>` : ''}</div>
      <div class="pills">${e.deudaUsd > 0 ? `<span class="badge warn">Debe ${usd(e.deudaUsd)}</span>` : '<span class="badge ok">Sin deuda</span>'}
        ${e.adelantosUsd > 0 ? `<span class="badge">Adelantos ${usd(e.adelantosUsd)}</span>` : ''}</div>
      <div class="actions">
        <button type="button" class="btn" data-act="hojaAdelanto" data-id="${e.ID}">Adelanto</button>
        <button type="button" class="btn ok" data-act="hojaPagar" data-id="${e.ID}">Pagar semana</button></div>
      <button type="button" class="btn small block mt" data-act="hojaDeuda" data-id="${e.ID}">Deuda</button>
    </div>`).join('') || '<div class="empty">Sin empleados.</div>'}
    ${esDueno() ? '<button type="button" class="btn block" data-act="hojaEmpleado">+ Agregar empleado</button>' : ''}
    <div class="actions"><button type="button" class="btn ghost block" data-act="cerrarHoja">Cerrar</button></div>`);
}

function hojaMovimiento(id) {
  const x = S.fin.movimientos.find((m) => String(m.ID) === String(id));
  if (!x) return;
  const filas = [
    ['Fecha', fechaDia(x.Fecha)],
    ['Monto', x.Moneda === 'VES' ? bs(x.Monto) : usd(x.Monto)],
    ['En dólares', usd(x.EquivalenteUSD)],
    ['Medio', x.Medio],
    ['Persona', x.Persona],
    ['Referencia', x.Referencia],
    ['Registrado por', x.Usuario],
  ].filter((r) => r[1]);
  abrirHoja(`<h3>${esc(x.Categoria)}</h3><div class="sub">${esc(x.Tipo)}</div>
    <div class="card mt">${filas.map((r) => `<div class="card-row" style="padding:4px 0"><span class="muted">${r[0]}</span><span>${esc(r[1])}</span></div>`).join('')}</div>
    ${x.Notas ? `<p class="note">📝 ${esc(x.Notas)}</p>` : ''}
    <div class="actions">
      ${esDueno() && x.Referencia !== 'CORTE' ? `<button type="button" class="btn danger block" data-act="eliminarMov" data-id="${x.ID}" data-orden="${esc(x.OrdenID)}">Eliminar movimiento</button>` : ''}
      <button type="button" class="btn ghost block" data-act="cerrarHoja">Cerrar</button></div>`);
}

const MENSAJES_FIN = {
  corte: 'Corte guardado ✓',
  gasto: 'Gasto registrado ✓',
  adelanto: 'Adelanto registrado ✓',
  pagarSemana: 'Pago registrado ✓',
  deuda: 'Deuda actualizada ✓',
  empleadoGuardar: 'Empleado guardado ✓',
};

function datosForm() {
  const f = S.form;
  const tasa = f.moneda === 'VES' ? fNum('tasa') : '';
  const base = { fecha: f.fecha, moneda: f.moneda, tasa, mes: S.finMes };
  const usaTasa = f.moneda === 'VES' && (['gasto', 'adelanto', 'pagar'].includes(f.hoja) || (f.hoja === 'deuda' && f.modo === 'prestar'));
  if (usaTasa && !(tasa > 0)) throw new Error('Indique la tasa BCV.');

  if (f.hoja === 'corte') {
    const deudas = {};
    (S.fin.empleados || []).forEach((e) => { deudas[e.ID] = fNum('deuda_' + e.ID) || 0; });
    return ['corte', { fecha: f.fecha, bancoBs: fNum('bancoBs') || 0, efectivoUsd: fNum('efectivoUsd') || 0, deudas }];
  }
  if (f.hoja === 'gasto') {
    if (!(fNum('monto') > 0)) throw new Error('Indique el monto.');
    if (f.categoria === 'Pago empleado' && !f.persona) throw new Error('Elija a qué empleado.');
    return ['gasto', Object.assign(base, { categoria: f.categoria, monto: fNum('monto'), persona: f.persona, notas: f.notas })];
  }
  if (f.hoja === 'adelanto') {
    if (!(fNum('montoUsd') > 0)) throw new Error('Indique el monto.');
    return ['adelanto', Object.assign(base, { empleadoId: f.empleadoId, montoUsd: fNum('montoUsd') })];
  }
  if (f.hoja === 'pagar') {
    if (netoSemana() < 0) throw new Error('Los adelantos y el descuento superan el sueldo.');
    return ['pagarSemana', Object.assign(base, { empleadoId: f.empleadoId, sueldoUsd: fNum('sueldo'), descuentoUsd: fNum('descuento') || 0 })];
  }
  if (f.hoja === 'deuda') {
    return ['deuda', Object.assign(base, { empleadoId: f.empleadoId, modo: f.modo, nuevaDeudaUsd: fNum('nueva'), montoUsd: fNum('montoUsd'), motivo: f.motivo })];
  }
  return ['empleadoGuardar', {
    ID: f.ID, Nombre: f.Nombre, SueldoSemanalUSD: fNum('SueldoSemanalUSD'), DiasSemana: fNum('DiasSemana'),
    DescuentoSemanalUSD: fNum('DescuentoSemanalUSD') || 0, Activo: f.Activo !== false, mes: S.finMes,
  }];
}

Object.assign(ACT, {
  reintentarFin() { S.finError = ''; render(); cargarFinanzas(); },
  mesCambio(el) {
    const [y, m] = S.finMes.split('-').map(Number);
    const d = new Date(y, m - 1 + Number(el.dataset.d), 1);
    S.finMes = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    cargarFinanzas(S.finMes);
  },
  hojaCorte() {
    const c = S.fin.corte;
    const extra = {};
    if (c) Object.assign(extra, { fecha: c.fecha, bancoBs: c.bancoBs ? fmtIn(c.bancoBs) : '', efectivoUsd: c.efectivoUsd ? fmtIn(c.efectivoUsd) : '' });
    (S.fin.empleados || []).forEach((e) => { if (c && e.deudaUsd) extra['deuda_' + e.ID] = fmtIn(e.deudaUsd); });
    nuevoForm('corte', extra);
  },
  hojaGasto() { nuevoForm('gasto', { categoria: 'Compra de insumos', monto: '', notas: '', persona: '' }); },
  hojaEmpleados() { hojaEmpleados(); },
  hojaAdelanto(el) {
    const e = empleadoFin(el.dataset.id);
    nuevoForm('adelanto', { empleadoId: e.ID, montoUsd: fmtIn(e.SueldoSemanalUSD / e.DiasSemana), volver: true });
  },
  hojaPagar(el) {
    const e = empleadoFin(el.dataset.id);
    nuevoForm('pagar', {
      empleadoId: e.ID, sueldo: fmtIn(e.SueldoSemanalUSD),
      descuento: fmtIn(Math.min(e.DescuentoSemanalUSD, e.deudaUsd)), volver: true,
    });
  },
  hojaDeuda(el) {
    const e = empleadoFin(el.dataset.id);
    nuevoForm('deuda', { empleadoId: e.ID, modo: 'ajustar', nueva: fmtIn(e.deudaUsd), montoUsd: '', motivo: '', volver: true });
  },
  hojaEmpleado(el) {
    const e = el.dataset.id ? empleadoFin(el.dataset.id) : null;
    nuevoForm('empleado', e
      ? { ID: e.ID, Nombre: e.Nombre, SueldoSemanalUSD: fmtIn(e.SueldoSemanalUSD), DiasSemana: String(e.DiasSemana), DescuentoSemanalUSD: fmtIn(e.DescuentoSemanalUSD), Activo: true, volver: true }
      : { Nombre: '', SueldoSemanalUSD: '60,00', DiasSemana: '6', DescuentoSemanalUSD: '0,00', volver: true });
  },
  hojaMovimiento(el) { hojaMovimiento(el.dataset.id); },
  fSet(el) { S.form[el.dataset.k] = el.dataset.v; pintarForm(); },
  fMoneda(el) { S.form.moneda = el.dataset.m; pintarForm(); },
  fToggleActivo(el) { S.form.Activo = el.checked; },
  async fGuardar(el) {
    let accion;
    let datos;
    try {
      [accion, datos] = datosForm();
    } catch (e) {
      toast(e.message, true);
      return;
    }
    if (accion === 'corte' && !confirm('¿Guardar el corte al ' + fechaDia(datos.fecha) + '?')) return;
    const volver = S.form.volver;
    await conEspera(el, async () => {
      aplicarFinanzas(await api(accion, datos, S.form && S.form.codigo));
      if (volver) hojaEmpleados(); else cerrarHoja();
      toast(MENSAJES_FIN[accion]);
    });
  },
  async eliminarMov(el) {
    const msg = el.dataset.orden
      ? '¿Eliminar este cobro? La cotización volverá a "Por cobrar".'
      : '¿Eliminar este movimiento? No se puede deshacer.';
    if (!confirm(msg)) return;
    await conEspera(el, async () => {
      aplicarFinanzas(await api('eliminarMovimiento', { id: el.dataset.id, mes: S.finMes }, 'del' + el.dataset.id + 'x' + S.finMes.replace('-', '')));
      cerrarHoja();
      toast('Movimiento eliminado');
    });
  },
  async completarTasas(el) {
    if (!confirm('¿Calcular la tasa BCV de los cobros y gastos anteriores? Solo completa lo que falta.')) return;
    await conEspera(el, async () => {
      const r = await api('completarTasas', { mes: S.finMes });
      aplicarFinanzas(r.finanzas);
      toast('Listo: ' + r.resultado.movimientosCompletados + ' movimientos completados');
    });
  },
});

INP.f = function (el) {
  S.form[el.dataset.k] = el.value;
  const eq = document.getElementById('form-eq');
  if (eq) eq.innerHTML = eqFormHTML();
};

CH.fFecha = async function (el) {
  const f = S.form;
  f.fecha = el.value || hoyISO();
  if (f.hoja !== 'corte' && f.moneda === 'VES') {
    try {
      const r = await api('tasaFecha', { fecha: f.fecha });
      f.tasa = r && r.tasa ? String(r.tasa).replace('.', ',') : '';
      if (!f.tasa) toast('No hay tasa guardada para ese día. Escríbala.', true);
    } catch (e) {
      toast(e.message, true);
    }
  }
  if (S.form === f) pintarForm();
};

// -----------------------------------------------------------------------------
// COBRANZA (etapa 3): cotizaciones por cobrar agrupadas por cliente
// -----------------------------------------------------------------------------

const COB_DIAS_MIN = 2; // se sugiere recordar deudas de 2 días o más
const COB_DIAS_ENTRE = 3; // y no más de una vez cada 3 días

function gruposCobranza() {
  const map = {};
  ((S.data && S.data.pendientes) || []).forEach((o) => {
    const k = String(o.ClienteID);
    const g = map[k] || (map[k] = { clienteId: o.ClienteID, nombre: o.ClienteNombre, ordenes: [], total: 0, dias: 0, ultimo: '', veces: 0 });
    g.ordenes.push(o);
    g.total += o.TotalUSD || 0;
    g.dias = Math.max(g.dias, diasDesde(o.FechaCierre));
    if (o.UltimoRecordatorio && (!g.ultimo || new Date(o.UltimoRecordatorio) > new Date(g.ultimo))) g.ultimo = o.UltimoRecordatorio;
    g.veces = Math.max(g.veces, o.Recordatorios || 0);
  });
  return Object.values(map).map((g) => {
    g.ordenes.sort((a, b) => new Date(a.FechaCierre) - new Date(b.FechaCierre));
    g.total = r2(g.total);
    g.porRecordar = g.dias >= COB_DIAS_MIN && (!g.ultimo || diasDesde(g.ultimo) >= COB_DIAS_ENTRE);
    return g;
  }).sort((a, b) => (b.porRecordar - a.porRecordar) || (b.dias - a.dias));
}

function datosPagoTexto() {
  const cfg = S.data.config || {};
  return '💳 Datos para Pago Móvil:\n* Banco: ' + cfg.Banco + '\n* Teléfono: ' + cfg.Telefono_Pago_Movil +
    '\n* RIF/Cédula: ' + cfg.Cedula_RIF;
}

/** Mensaje de recordatorio (en usted) con una o varias cotizaciones. */
function textoRecordatorioGrupo(g) {
  if (g.ordenes.length === 1) return textoRecordatorio(g.ordenes[0]);
  const c = clientePorId(g.clienteId);
  const t = tasaHoy();
  return '¡Hola, Sr(a). ' + (c ? c.Nombre : g.nombre).trim() + '! Le saludamos de Autolavado Burbujas.\n' +
    'Le recordamos que tiene pendientes las siguientes cotizaciones:\n' +
    g.ordenes.map((o) => '• ' + o.Numero + ' del ' + fechaCorta(o.FechaCierre) + ': $' + r2(o.TotalUSD).toFixed(2)).join('\n') +
    '\n\nTotal: $' + g.total.toFixed(2) +
    (t ? ' (' + r2(g.total * t).toFixed(2) + ' Bs a la tasa BCV de hoy: ' + t.toFixed(2) + ')' : '') + '.\n\n' +
    datosPagoTexto() + '\n\n¡Muchas gracias por su preferencia!';
}

function textoRecordado(g) {
  if (!g.ultimo) return '<span class="badge">Sin recordar</span>';
  const d = diasDesde(g.ultimo);
  return `<span class="badge ${d >= COB_DIAS_ENTRE ? '' : 'ok'}">Recordado ${d === 0 ? 'hoy' : hace(g.ultimo)}${g.veces > 1 ? ' · ' + g.veces + ' veces' : ''}</span>`;
}

function botonRecordar(g, clase) {
  const c = clientePorId(g.clienteId);
  const tel = c ? telWa(c.Telefono) : '';
  const ids = g.ordenes.map((o) => o.ID).join(',');
  return `<a class="btn wa-outline ${clase || ''}" href="${waLink(tel, textoRecordatorioGrupo(g))}" target="_blank" rel="noopener" data-act="recordado" data-ids="${ids}">Recordar</a>`;
}

function viewCobranza() {
  const grupos = gruposCobranza();
  const porRecordar = grupos.filter((g) => g.porRecordar);
  const total = grupos.reduce((s, g) => s + g.total, 0);
  if (!S.cobFiltro) S.cobFiltro = porRecordar.length ? 'recordar' : 'todos';
  const lista = S.cobFiltro === 'recordar' ? porRecordar : grupos;

  let html = topbar('Cobranza', 'Cotizaciones por cobrar') + `<main class="screen">
    <button type="button" class="btn small ghost" data-act="nav" data-v="hoy">‹ Volver a Hoy</button>
    <div class="kpis mt">
      <div class="kpi wide"><div class="label">Total por cobrar</div><div class="value">${usd(total)}</div>
        <div class="hint">${totalBsTexto(total)} a la tasa de hoy · ${grupos.length} cliente(s)</div></div>
    </div>
    <div class="pills mt">
      <button type="button" class="pill ${S.cobFiltro === 'recordar' ? 'on' : ''}" data-act="cobFiltro" data-v="recordar">Para recordar hoy (${porRecordar.length})</button>
      <button type="button" class="pill ${S.cobFiltro === 'todos' ? 'on' : ''}" data-act="cobFiltro" data-v="todos">Todos (${grupos.length})</button>
    </div>
    <p class="note">Se sugiere recordar a quien debe hace ${COB_DIAS_MIN} días o más y no recibió recordatorio en los últimos ${COB_DIAS_ENTRE} días.</p>`;

  if (!lista.length) {
    html += S.cobFiltro === 'recordar' && grupos.length
      ? '<div class="empty">Nadie para recordar hoy. ✓<br>Toque <b>Todos</b> para ver todas las deudas.</div>'
      : '<div class="empty">No hay cotizaciones por cobrar. 🎉</div>';
    return html + '</main>';
  }

  html += lista.map((g) => {
    const c = clientePorId(g.clienteId);
    return `<article class="card ${g.dias >= 7 ? 'alert' : ''}">
      <div class="card-row">
        <div><div class="name">${esc(g.nombre)}</div>
          <div class="meta">${g.ordenes.length} cotización(es) · la más vieja ${g.dias === 0 ? 'de hoy' : hace(g.ordenes[0].FechaCierre)}</div>
          <div class="pills" style="margin-top:6px">${textoRecordado(g)}${c && c.Telefono ? '' : '<span class="badge warn">Sin teléfono</span>'}</div></div>
        <div class="amount">${usd(g.total)}<small>${totalBsTexto(g.total)}</small></div>
      </div>
      <div class="services">${g.ordenes.map((o) => `<div class="meta">${esc(o.Numero)} · ${fechaCorta(o.FechaCierre)} · ${usd(o.TotalUSD)}</div>`).join('')}</div>
      <div class="actions">
        ${botonRecordar(g)}
        <button type="button" class="btn ok" data-act="cobrarGrupo" data-cliente="${g.clienteId}">Cobrar</button>
      </div>
    </article>`;
  }).join('');

  return html + '</main>';
}

// Cobrar varias cotizaciones de un mismo cliente en un solo paso.

function abrirCobroMultiple(g) {
  const t = tasaHoy();
  S.cobroMulti = {
    clienteId: g.clienteId, nombre: g.nombre, ordenes: g.ordenes.map((o) => ({ ID: o.ID, Numero: o.Numero, TotalUSD: o.TotalUSD, FechaCierre: o.FechaCierre })),
    total: g.total, fecha: hoyISO(), tasa: t ? String(t).replace('.', ',') : '', modo: 'pm', codigo: nuevoCodigo(),
  };
  pintarCobroMultiple();
}

function pintarCobroMultiple() {
  const m = S.cobroMulti;
  const t = parseNum(m.tasa) > 0 ? parseNum(m.tasa) : null;
  const totalBs = t ? m.ordenes.reduce((s, o) => s + r2(o.TotalUSD * t), 0) : 0;
  abrirHoja(`<h3>Cobrar todo · ${esc(m.nombre)}</h3><div class="sub">${m.ordenes.length} cotizaciones</div>
    ${m.ordenes.map((o) => `<div class="list-item" style="cursor:default"><div><div>${esc(o.Numero)}</div><div class="meta">${fechaCorta(o.FechaCierre)}</div></div>
      <div style="display:flex;align-items:center;gap:8px"><b>${usd(o.TotalUSD)}</b>
      <button type="button" class="btn small" data-act="cobrarUna" data-id="${o.ID}">Solo esta</button></div></div>`).join('')}
    <div class="big-amount">${usd(m.total)}<small>${t && m.modo === 'pm' ? bs(totalBs) : ''}</small></div>
    <div class="segmented two">
      <button type="button" class="${m.modo === 'pm' ? 'on' : ''}" data-act="cmModo" data-m="pm">Pago móvil</button>
      <button type="button" class="${m.modo === 'ef' ? 'on' : ''}" data-act="cmModo" data-m="ef">Efectivo $</button></div>
    <div class="row2">
      <label class="field">Fecha del pago<input class="input" type="date" data-ch="cmFecha" value="${esc(m.fecha)}" max="${esc(hoyISO())}"></label>
      ${m.modo === 'pm' ? `<label class="field">Tasa BCV<input class="input" inputmode="decimal" data-in="cmTasa" value="${esc(m.tasa)}"></label>` : '<span></span>'}
    </div>
    ${m.modo === 'pm' ? (t ? `<p class="note">Verifique que recibió <b>${bs(totalBs)}</b> en el banco.</p>` : '<p class="note warn">Escriba la tasa BCV del día del pago.</p>') : ''}
    <p class="note">Para un pago mixto o un monto distinto, use "Solo esta" en cada cotización.</p>
    <div class="actions">
      <button type="button" class="btn ok block" data-act="confirmarCobroMultiple">Cobrar ${m.ordenes.length} cotizaciones</button>
      <button type="button" class="btn ghost block" data-act="cerrarHoja">Cancelar</button></div>`);
}

Object.assign(ACT, {
  cobFiltro(el) { S.cobFiltro = el.dataset.v; render(); },
  recordado(el) {
    // El enlace abre WhatsApp; aquí solo se anota el recordatorio.
    const ids = el.dataset.ids.split(',');
    const ahora = new Date().toISOString();
    (S.data.pendientes || []).forEach((o) => {
      if (ids.includes(String(o.ID))) { o.UltimoRecordatorio = ahora; o.Recordatorios = (o.Recordatorios || 0) + 1; }
    });
    guardarCache();
    setTimeout(() => { if (S.view === 'cobranza' || S.view === 'hoy') render(); }, 400);
    api('recordatorio', { ids }, 'rec' + ids.join('') + 'x' + Math.floor(Date.now() / 600000))
      .then((r) => aplicarEstado(r.estado))
      .catch((e) => toast('No se pudo anotar el recordatorio: ' + e.message, true));
  },
  cobrarGrupo(el) {
    const g = gruposCobranza().find((x) => String(x.clienteId) === String(el.dataset.cliente));
    if (!g) return;
    if (g.ordenes.length === 1) abrirCobro(g.ordenes[0].ID); else abrirCobroMultiple(g);
  },
  cobrarUna(el) { S.cobroMulti = null; abrirCobro(el.dataset.id); },
  cmModo(el) { S.cobroMulti.modo = el.dataset.m; pintarCobroMultiple(); },
  async confirmarCobroMultiple(el) {
    const m = S.cobroMulti;
    const t = parseNum(m.tasa) > 0 ? parseNum(m.tasa) : null;
    if (m.modo === 'pm' && !t) { toast('Indique la tasa BCV.', true); return; }
    if (!confirm('¿Registrar el cobro de ' + m.ordenes.length + ' cotizaciones de ' + m.nombre + '?')) return;
    el.disabled = true;
    let hechas = 0;
    try {
      for (const o of m.ordenes) {
        el.innerHTML = '<span class="spinner"></span> Cobrando ' + (hechas + 1) + ' de ' + m.ordenes.length;
        const r = await api('registrarPago', {
          id: o.ID,
          PagoMovilBs: m.modo === 'pm' ? r2(o.TotalUSD * t) : 0,
          EfectivoUsd: m.modo === 'ef' ? o.TotalUSD : 0,
          Fecha: m.fecha,
          Tasa: m.modo === 'pm' ? t : '',
          Referencia: '',
        }, m.codigo + 'o' + o.ID);
        aplicarEstado(r.estado);
        hechas++;
      }
      cerrarHoja();
      render();
      toast(hechas + ' cotizaciones cobradas ✓');
    } catch (e) {
      render();
      toast('Se cobraron ' + hechas + ' de ' + m.ordenes.length + '. ' + e.message, true);
      if (el.isConnected) { el.disabled = false; el.textContent = 'Reintentar las que faltan'; }
      m.ordenes = m.ordenes.slice(hechas);
      m.total = r2(m.ordenes.reduce((s, o) => s + o.TotalUSD, 0));
    }
  },
});

INP.cmTasa = function (el) { S.cobroMulti.tasa = el.value; };

CH.cmFecha = async function (el) {
  const m = S.cobroMulti;
  m.fecha = el.value || hoyISO();
  try {
    const r = await api('tasaFecha', { fecha: m.fecha });
    m.tasa = r && r.tasa ? String(r.tasa).replace('.', ',') : '';
    if (!m.tasa) toast('No hay tasa guardada para ese día. Escríbala.', true);
  } catch (e) {
    toast(e.message, true);
  }
  if (S.cobroMulti === m) pintarCobroMultiple();
};

// -----------------------------------------------------------------------------
// Inicio
// -----------------------------------------------------------------------------

(function iniciar() {
  S.data = ls.json(K.cache, null);
  S.draft = Object.assign(borradorVacio(), ls.json(K.draft, {}));
  S.fin = ls.json(K.fin, null);
  S.finMes = S.fin ? S.fin.mes.clave : '';
  render();
  if (ls.get(K.url) && ls.get(K.token)) sync(true);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo sin conexión */ });
  }
})();
