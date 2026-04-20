// ════════════════════════════════════════════════════════════════
//  game.js — CIPHER: Number Duel (Turn-Based)
//  - Turn order: random shuffle at game start
//  - One player guesses ALL opponents per turn
//  - Results: public (everyone sees in live log)
//  - Eliminated players still take turns but can't be elim'd again
// ════════════════════════════════════════════════════════════════

import { DB } from './firebase.js';

// ── State ─────────────────────────────────────────────────────────────────────
let myId       = null;
let myName     = null;
let roomCode   = null;
let gameState  = null;
let highlights = {}; // { targetId: Set<digitIndex> }

// ── Utilities ─────────────────────────────────────────────────────────────────
const uid  = () => Math.random().toString(36).slice(2, 11);
const room = () => Math.random().toString(36).slice(2, 8).toUpperCase();

function checkGuess(secret, guess) {
  let correct = 0;
  for (let i = 0; i < secret.length; i++) {
    if (secret[i] === guess[i]) correct++;
  }
  return correct;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── UI Helpers ────────────────────────────────────────────────────────────────
function screen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

export function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3000);
}

function loader(show) {
  const el = document.getElementById('loader');
  if (el) el.style.display = show ? 'flex' : 'none';
}

// ── Room Subscription ─────────────────────────────────────────────────────────
function subscribeRoom(code) {
  if (roomCode) DB.unsubscribe(`rooms/${roomCode}`);
  roomCode = code;
  DB.subscribe(`rooms/${code}`, (data) => {
    if (!data) return;
    gameState = data;
    render(data);
  });
}

// ── Create Room ───────────────────────────────────────────────────────────────
export async function createRoom(name, digits) {
  myId   = uid();
  myName = name;
  const code = room();
  await DB.set(`rooms/${code}`, {
    code, status: 'lobby', digits, host: myId,
    players: { [myId]: { id: myId, name, secret: null, eliminated: false, ready: false } },
    turnOrder: [], turnIndex: 0,
    currentTurnGuesses: {},
    guesses: {}, log: []
  });
  loader(false);
  subscribeRoom(code);
}

// ── Join Room ─────────────────────────────────────────────────────────────────
export async function joinRoom(name, code) {
  myId   = uid();
  myName = name;
  loader(true);
  const existing = await DB.get(`rooms/${code}`);
  loader(false);
  if (!existing)                   { toast('Room tidak ditemukan.', 'err'); return; }
  if (existing.status !== 'lobby') { toast('Game sudah dimulai.', 'err');  return; }
  await DB.update(`rooms/${code}/players`, {
    [myId]: { id: myId, name, secret: null, eliminated: false, ready: false }
  });
  subscribeRoom(code);
}

// ── Start Game ────────────────────────────────────────────────────────────────
export async function startGame() {
  if (!gameState) return;
  if (gameState.host !== myId) { toast('Hanya host yang bisa mulai.', 'err'); return; }
  if (Object.keys(gameState.players || {}).length < 2) { toast('Butuh minimal 2 pemain.', 'err'); return; }
  await DB.update(`rooms/${roomCode}`, { status: 'setup' });
}

// ── Submit Secret ─────────────────────────────────────────────────────────────
export async function submitSecret(secret) {
  const d = gameState?.digits;
  if (!d || secret.length !== d || !/^\d+$/.test(secret)) {
    toast(`Masukkan tepat ${d} digit angka.`, 'err'); return;
  }
  await DB.update(`rooms/${roomCode}/players/${myId}`, { secret, ready: true });
  toast('Angka rahasia terkunci! 🔒', 'ok');
}

// ── Submit Guess ──────────────────────────────────────────────────────────────
export async function submitGuess(targetId, guessVal) {
  const d = gameState?.digits;
  if (!guessVal || guessVal.length !== d) { toast(`Masukkan ${d} digit.`, 'err'); return; }

  const order = gameState.turnOrder || [];
  const idx   = gameState.turnIndex ?? 0;
  if (order[idx] !== myId) { toast('Bukan giliran kamu!', 'err'); return; }
  if (gameState.currentTurnGuesses?.[targetId]) { toast('Sudah tebak pemain ini giliran ini.', 'err'); return; }

  const target = gameState.players?.[targetId];
  if (!target) return;

  const correct  = checkGuess(target.secret, guessVal);
  const guessKey = `${myId}_${targetId}_${Date.now()}`;
  const entry    = { from: myId, fromName: myName, target: targetId, targetName: target.name, guess: guessVal, correct, ts: Date.now() };

  await DB.update(`rooms/${roomCode}/guesses`, { [guessKey]: entry });
  await DB.update(`rooms/${roomCode}/currentTurnGuesses`, { [targetId]: entry });

  let logLine = target.eliminated
    ? `${myName} → ${target.name} [elim]: ${guessVal} = ${correct} benar`
    : `${myName} → ${target.name}: ${guessVal} = ${correct} benar`;

  let log = [...(gameState.log || []), logLine].slice(-50);

  // Elimination check (only if not already eliminated)
  if (!target.eliminated && correct === d) {
    await DB.update(`rooms/${roomCode}/players/${targetId}`, { eliminated: true, eliminatedBy: myName });
    log = [...log, `💥 ${target.name} DIELIMINASI oleh ${myName}!`].slice(-50);
    toast(`💥 ${target.name} DIELIMINASI!`, 'ok');

    const merged   = { ...gameState.players, [targetId]: { ...target, eliminated: true } };
    const survivors = Object.values(merged).filter(p => !p.eliminated);
    if (survivors.length <= 1) {
      const winner = survivors[0] ?? { id: myId, name: myName };
      await DB.update(`rooms/${roomCode}`, { status: 'ended', winner: winner.id, winnerName: winner.name, log });
      return;
    }
  }

  await DB.update(`rooms/${roomCode}`, { log });
}

// ── End Turn ──────────────────────────────────────────────────────────────────
export async function endTurn() {
  const order = gameState?.turnOrder || [];
  const idx   = gameState?.turnIndex ?? 0;
  if (order[idx] !== myId) { toast('Bukan giliran kamu.', 'err'); return; }

  // Must guess all opponents this turn
  const opponents       = Object.values(gameState.players || {}).filter(p => p.id !== myId);
  const guessedThisTurn = gameState.currentTurnGuesses || {};
  const unguessed       = opponents.filter(p => !guessedThisTurn[p.id]);
  if (unguessed.length > 0) {
    toast(`Tebak semua lawan dulu! Sisa: ${unguessed.map(p => p.name).join(', ')}`, 'err'); return;
  }

  const nextIdx    = (idx + 1) % order.length;
  const nextName   = gameState.players?.[order[nextIdx]]?.name ?? '???';
  const log        = [...(gameState.log || []), `━━ Giliran ${nextName} ━━`].slice(-50);
  await DB.update(`rooms/${roomCode}`, { turnIndex: nextIdx, currentTurnGuesses: {}, log });
}

// ── Toggle Highlight ──────────────────────────────────────────────────────────
export function toggleHighlight(targetId, idx) {
  if (!highlights[targetId]) highlights[targetId] = new Set();
  const s = highlights[targetId];
  s.has(idx) ? s.delete(idx) : s.add(idx);
  if (gameState) renderPlaying(gameState);
}

export function copyCode() {
  const code = document.getElementById('lobby-code')?.textContent?.trim();
  if (code) navigator.clipboard?.writeText(code).then(() => toast('Kode disalin! ✓', 'ok'));
}

// ════════════════════════════════════════════════════════════════
//  RENDER PIPELINE
// ════════════════════════════════════════════════════════════════
function render(data) {
  switch (data.status) {
    case 'lobby':   renderLobby(data);   break;
    case 'setup':   checkSetup(data);    break;
    case 'playing': renderPlaying(data); break;
    case 'ended':   renderEnded(data);   break;
  }
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function renderLobby(data) {
  screen('screen-lobby');
  const codeEl = document.getElementById('lobby-code');
  if (codeEl) codeEl.textContent = data.code;
  const youEl = document.getElementById('lobby-you');
  if (youEl) youEl.textContent = myName;

  const list = document.getElementById('lobby-players');
  if (list) {
    list.innerHTML = Object.values(data.players || {}).map(p => `
      <div class="player-chip ${p.id === myId ? 'me' : ''}">
        <span class="chip-icon">${p.id === data.host ? '♛' : '◆'}</span>
        <span>${p.name}</span>
        ${p.id === myId ? '<span class="chip-you">YOU</span>' : ''}
      </div>`).join('');
  }
  const startBtn = document.getElementById('btn-start');
  if (startBtn) startBtn.style.display = data.host === myId ? 'block' : 'none';
  const waitNote = document.getElementById('lobby-wait-note');
  if (waitNote) waitNote.style.display = data.host !== myId ? 'block' : 'none';
}

// ── Setup ─────────────────────────────────────────────────────────────────────
function checkSetup(data) {
  const allReady = Object.values(data.players || {}).every(p => p.ready);

  if (allReady && data.host === myId) {
    const order     = shuffle(Object.keys(data.players));
    const firstName = data.players[order[0]]?.name ?? '???';
    DB.update(`rooms/${roomCode}`, {
      status: 'playing', turnOrder: order, turnIndex: 0,
      currentTurnGuesses: {}, log: [`━━ Giliran pertama: ${firstName} ━━`]
    });
    return;
  }

  const me = data.players?.[myId];
  if (me?.ready) {
    screen('screen-waiting');
    const waiting = Object.values(data.players || {}).filter(p => !p.ready).map(p => p.name).join(', ');
    const el = document.getElementById('waiting-msg');
    if (el) el.textContent = `Menunggu: ${waiting || 'semua pemain...'}`;
    return;
  }

  screen('screen-setup');
  const dEl = document.getElementById('setup-digits');
  if (dEl) dEl.textContent = data.digits;
  const inp = document.getElementById('setup-input');
  if (inp) { inp.maxLength = data.digits; inp.placeholder = '—'.repeat(data.digits); }
}

// ── Playing ───────────────────────────────────────────────────────────────────
function renderPlaying(data) {
  screen('screen-playing');

  const order      = data.turnOrder || [];
  const idx        = data.turnIndex ?? 0;
  const currentId  = order[idx];
  const isMyTurn   = currentId === myId;
  const me         = data.players?.[myId];
  const allPlayers = Object.values(data.players || {});
  const currentP   = data.players?.[currentId];

  // ── Turn banner
  const banner = document.getElementById('turn-banner');
  if (banner) {
    banner.className = `turn-banner ${isMyTurn ? 'my-turn' : 'other-turn'}`;
    banner.innerHTML = isMyTurn
      ? `<span class="turn-icon">🎯</span><strong>GILIRAN KAMU!</strong> Tebak semua lawan, lalu klik AKHIRI GILIRAN`
      : `<span class="turn-icon">⏳</span>Giliran <strong>${currentP?.name ?? '???'}</strong> sedang menebak...`;
  }

  // ── My status
  const statusEl = document.getElementById('my-status');
  if (statusEl) {
    statusEl.innerHTML = `
      ${me?.eliminated ? '<span class="tag elim">ELIMINATED</span>' : '<span class="tag alive">ALIVE</span>'}
      Rahasiamu: <span class="mono secret-val">${me?.secret ?? '????'}</span>`;
  }

  // ── Turn order strip
  const strip = document.getElementById('turn-order-strip');
  if (strip) {
    strip.innerHTML = order.map((pid, i) => {
      const p = data.players?.[pid];
      if (!p) return '';
      return `<div class="turn-chip ${i===idx?'current':''} ${pid===myId?'is-me':''} ${p.eliminated?'is-elim':''}">
        ${i===idx?'▶ ':''}${p.name}${p.eliminated?' 💀':''}
      </div>`;
    }).join('');
  }

  // ── Guess area
  const guessArea = document.getElementById('guess-area');
  if (guessArea) {
    if (!isMyTurn) {
      guessArea.innerHTML = '<div class="empty-state">Menunggu giliran kamu...</div>';
    } else {
      guessArea.innerHTML = '';
      const opponents = allPlayers.filter(p => p.id !== myId);
      opponents.forEach(t => guessArea.appendChild(buildGuessPanel(t, data)));

      // End turn button
      const remaining = opponents.filter(p => !data.currentTurnGuesses?.[p.id]).length;
      const btn = document.getElementById('btn-end-turn');
      if (btn) {
        btn.disabled = remaining > 0;
        btn.textContent = remaining > 0 ? `AKHIRI GILIRAN (sisa ${remaining})` : 'AKHIRI GILIRAN ➜';
        btn.className = remaining > 0 ? 'btn btn-outline' : 'btn btn-coral';
      }
    }
  }

  // ── Elim list
  const elimEl = document.getElementById('elim-list');
  if (elimEl) {
    const elimd = allPlayers.filter(p => p.eliminated);
    elimEl.innerHTML = elimd.length
      ? elimd.map(p => `<div class="elim-chip"><span class="elim-name">💀 ${p.name}</span><span class="mono elim-secret">${p.secret}</span></div>`).join('')
      : '<span class="dim">Belum ada yang dieliminasi.</span>';
  }

  renderLog(data.log || []);
  renderMatrix(data.guesses || {}, data.players || {}, data);
}

// ── Guess Panel ───────────────────────────────────────────────────────────────
function buildGuessPanel(target, data) {
  const d            = data.digits;
  const allMyGuesses = Object.values(data.guesses || {})
    .filter(g => g.from === myId && g.target === target.id)
    .sort((a, b) => a.ts - b.ts);
  const doneThisTurn = data.currentTurnGuesses?.[target.id];
  const lastGuess    = allMyGuesses.at(-1)?.guess ?? '';
  const hl           = highlights[target.id] ?? new Set();

  let digitRow = lastGuess
    ? [...lastGuess].map((ch, i) =>
        `<button class="digit-cell ${hl.has(i)?'confirmed':''}" onclick="Game.toggleHighlight('${target.id}',${i})">${ch}</button>`
      ).join('')
    : Array(d).fill('<div class="digit-cell empty">?</div>').join('');

  const historyHtml = allMyGuesses.slice(-5).reverse().map(g => `
    <div class="history-row">
      <span class="mono">${g.guess}</span>
      <span class="correct-badge">${g.correct} / ${d} ✓</span>
    </div>`).join('');

  const panel = document.createElement('div');
  panel.className = `guess-panel ${doneThisTurn ? 'done-this-turn' : ''} ${target.eliminated ? 'is-elim' : ''}`;

  panel.innerHTML = `
    <div class="panel-top">
      <div>
        <span class="target-label">${target.name}</span>
        ${target.eliminated ? '<span class="tag elim" style="margin-left:8px;font-size:0.58rem">ELIM</span>' : ''}
      </div>
      ${doneThisTurn
        ? `<span class="guessed-badge">✓ ${doneThisTurn.guess} = ${doneThisTurn.correct} benar</span>`
        : `<span class="guess-count">${allMyGuesses.length} riwayat</span>`
      }
    </div>
    <div class="digit-row">${digitRow}</div>
    ${lastGuess ? '<p class="digit-hint">Tap angka untuk tandai ✓ (hijau)</p>' : ''}
    ${doneThisTurn
      ? `<div class="already-guessed-note">✓ Sudah ditebak giliran ini</div>`
      : `<div class="guess-input-row">
           <input type="tel" class="guess-input" id="inp-${target.id}" maxlength="${d}"
             placeholder="${'0'.repeat(d)}" inputmode="numeric"
             oninput="this.value=this.value.replace(/\\D/g,'')"
             onkeydown="if(event.key==='Enter'){Game.submitGuess('${target.id}',this.value);this.value=''}">
           <button class="btn-guess"
             onclick="Game.submitGuess('${target.id}',document.getElementById('inp-${target.id}').value);document.getElementById('inp-${target.id}').value=''">
             TEBAK
           </button>
         </div>`
    }
    <div class="guess-history">${historyHtml}</div>`;
  return panel;
}

// ── Log ───────────────────────────────────────────────────────────────────────
function renderLog(log) {
  const el = document.getElementById('game-log');
  if (!el) return;
  el.innerHTML = [...log].reverse().slice(0, 30).map((line, i) => {
    const isMark = line.startsWith('━━');
    const isElim = line.includes('DIELIMINASI');
    return `<div class="log-line ${i===0?'latest':''} ${isMark?'turn-marker':''} ${isElim?'elim-line':''}">${line}</div>`;
  }).join('') || '<div class="dim">Belum ada tebakan.</div>';
}

// ── Matrix ────────────────────────────────────────────────────────────────────
function renderMatrix(guesses, players, data) {
  const el = document.getElementById('history-table');
  if (!el) return;
  const list = Object.values(players);
  const d    = data?.digits ?? 4;
  const matrix = {};
  Object.values(guesses).forEach(g => {
    if (!matrix[g.from]) matrix[g.from] = {};
    const prev = matrix[g.from][g.target];
    if (!prev || g.ts > prev.ts) matrix[g.from][g.target] = g;
  });

  const order = data.turnOrder || [];
  const idx   = data.turnIndex ?? 0;

  let html = `<table><thead><tr>
    <th class="th-label">↓ Penebak / Target →</th>
    ${list.map(p => `<th>${p.name}${p.eliminated?' 💀':''}</th>`).join('')}
  </tr></thead><tbody>`;

  list.forEach(guesser => {
    const isTurn = order[idx] === guesser.id;
    html += `<tr class="${isTurn?'current-turn-row':''}">
      <td class="row-name">${isTurn?'▶ ':''}${guesser.name}${guesser.id===myId?'<span class="you-badge">YOU</span>':''}</td>`;
    list.forEach(target => {
      if (guesser.id === target.id) { html += '<td class="cell-self">—</td>'; return; }
      const e = matrix[guesser.id]?.[target.id];
      if (e) {
        const won = e.correct === d;
        html += `<td class="${won?'cell-win':'cell-val'}">
          <span class="mono">${e.guess}</span>
          <span class="matrix-badge ${won?'win':''}">${e.correct}✓</span>
        </td>`;
      } else {
        html += '<td class="cell-empty">–</td>';
      }
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  el.innerHTML = html;
}

// ── Ended ─────────────────────────────────────────────────────────────────────
function renderEnded(data) {
  screen('screen-ended');
  document.getElementById('winner-name').textContent = data.winnerName ?? '???';
  document.getElementById('winner-msg').textContent  = data.winner === myId ? '🏆 KAMU MENANG!' : `${data.winnerName} menang!`;
  document.getElementById('ended-code').textContent  = roomCode;
  const secrets = document.getElementById('ended-secrets');
  if (secrets) {
    secrets.innerHTML = Object.values(data.players || {}).map(p => `
      <div class="secret-row ${p.id===myId?'is-me':''} ${p.id===data.winner?'is-winner':''}">
        <span class="secret-name">${p.id===data.winner?'🏆 ':''}${p.name}</span>
        <span class="mono secret-number">${p.secret??'????'}</span>
      </div>`).join('');
  }
}

// ════════════════════════════════════════════════════════════════
//  GLOBAL API + INIT
// ════════════════════════════════════════════════════════════════
window.Game = { createRoom, joinRoom, startGame, submitSecret, submitGuess, endTurn, toggleHighlight, copyCode };

document.addEventListener('DOMContentLoaded', () => {
  if (DB.isLocal) setTimeout(() => toast('Mode lokal — Firebase belum dikonfigurasi', 'info'), 800);

  let selectedDigits = 3;
  document.querySelectorAll('.digit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.digit-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDigits = parseInt(btn.dataset.val);
    });
  });

  document.getElementById('btn-create')?.addEventListener('click', () => {
    const name = document.getElementById('create-name')?.value.trim();
    if (!name) { toast('Masukkan namamu.', 'err'); return; }
    createRoom(name, selectedDigits);
  });
  document.getElementById('btn-join')?.addEventListener('click', () => {
    const name = document.getElementById('join-name')?.value.trim();
    const code = document.getElementById('join-code')?.value.trim().toUpperCase();
    if (!name) { toast('Masukkan namamu.', 'err'); return; }
    if (!code) { toast('Masukkan kode room.', 'err'); return; }
    joinRoom(name, code);
  });
  document.getElementById('btn-lock-secret')?.addEventListener('click', () => {
    submitSecret(document.getElementById('setup-input')?.value.trim());
  });
  document.getElementById('btn-end-turn')?.addEventListener('click', endTurn);

  ['create-name','join-code','setup-input'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const map = { 'create-name': 'btn-create', 'join-code': 'btn-join', 'setup-input': 'btn-lock-secret' };
      document.getElementById(map[id])?.click();
    });
  });
});
