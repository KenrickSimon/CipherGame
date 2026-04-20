// ════════════════════════════════════════════════════════════════
//  game.js — CIPHER: Number Duel
//  All game logic, state management, and UI rendering.
// ════════════════════════════════════════════════════════════════

import { DB } from './firebase.js';

// ── State ─────────────────────────────────────────────────────────────────────
let myId       = null;   // this client's player ID
let myName     = null;   // this client's display name
let roomCode   = null;   // active room code
let gameState  = null;   // last received room snapshot
let highlights = {};     // { targetId: Set<digitIndex> } — green-marked digits

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
  el._t = setTimeout(() => el.classList.remove('show'), 2800);
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
  const data = {
    code,
    status: 'lobby',
    digits,
    host: myId,
    players: {
      [myId]: { id: myId, name, secret: null, eliminated: false, ready: false }
    },
    guesses: {},
    log: []
  };
  loader(true);
  await DB.set(`rooms/${code}`, data);
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
  if (!existing)                    { toast('Room tidak ditemukan.', 'err'); return; }
  if (existing.status !== 'lobby')  { toast('Game sudah dimulai.', 'err');  return; }
  await DB.update(`rooms/${code}/players`, {
    [myId]: { id: myId, name, secret: null, eliminated: false, ready: false }
  });
  subscribeRoom(code);
}

// ── Start Game ────────────────────────────────────────────────────────────────
export async function startGame() {
  if (!gameState) return;
  if (gameState.host !== myId) { toast('Hanya host yang bisa mulai.', 'err'); return; }
  const count = Object.keys(gameState.players || {}).length;
  if (count < 2) { toast('Butuh minimal 2 pemain.', 'err'); return; }
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

  const target = gameState.players?.[targetId];
  if (!target || target.eliminated) { toast('Pemain sudah dieliminasi.', 'err'); return; }
  if (!target.secret) { toast('Pemain belum set rahasia.', 'err'); return; }

  const correct  = checkGuess(target.secret, guessVal);
  const guessKey = `${myId}_${targetId}_${Date.now()}`;

  await DB.update(`rooms/${roomCode}/guesses`, {
    [guessKey]: {
      from:       myId,
      fromName:   myName,
      target:     targetId,
      targetName: target.name,
      guess:      guessVal,
      correct,
      ts:         Date.now()
    }
  });

  // Append to log (keep last 50)
  const log = [...(gameState.log || []),
    `${myName} → ${target.name}: ${guessVal} = ${correct} benar`
  ].slice(-50);
  await DB.update(`rooms/${roomCode}`, { log });

  // Check elimination
  if (correct === d) {
    await DB.update(`rooms/${roomCode}/players/${targetId}`, {
      eliminated: true, eliminatedBy: myName
    });
    toast(`💥 ${target.name} DIELIMINASI!`, 'ok');

    // Check win: survivors after this elimination
    const merged = {
      ...gameState.players,
      [targetId]: { ...target, eliminated: true }
    };
    const survivors = Object.values(merged).filter(p => !p.eliminated);
    if (survivors.length <= 1) {
      const winner = survivors[0] ?? { id: myId, name: myName };
      await DB.update(`rooms/${roomCode}`, {
        status:     'ended',
        winner:     winner.id,
        winnerName: winner.name
      });
    }
  }
}

// ── Toggle Digit Highlight ────────────────────────────────────────────────────
export function toggleHighlight(targetId, idx) {
  if (!highlights[targetId]) highlights[targetId] = new Set();
  const s = highlights[targetId];
  s.has(idx) ? s.delete(idx) : s.add(idx);
  if (gameState) renderPlaying(gameState);
}

// ── Copy Room Code ────────────────────────────────────────────────────────────
export function copyCode() {
  const code = document.getElementById('lobby-code')?.textContent?.trim();
  if (!code) return;
  navigator.clipboard?.writeText(code).then(() => toast('Kode disalin! ✓', 'ok'));
}

// ════════════════════════════════════════════════════════════════
//  RENDER PIPELINE
// ════════════════════════════════════════════════════════════════

function render(data) {
  switch (data.status) {
    case 'lobby':   renderLobby(data);   break;
    case 'setup':   renderSetup(data);   break;
    case 'playing': renderPlaying(data); break;
    case 'ended':   renderEnded(data);   break;
  }
}

// ── Lobby ─────────────────────────────────────────────────────────────────────
function renderLobby(data) {
  screen('screen-lobby');
  const el = document.getElementById('lobby-code');
  if (el) el.textContent = data.code;

  const youEl = document.getElementById('lobby-you');
  if (youEl) youEl.textContent = myName;

  const players = Object.values(data.players || {});
  const list = document.getElementById('lobby-players');
  if (list) {
    list.innerHTML = players.map(p => `
      <div class="player-chip ${p.id === myId ? 'me' : ''}">
        <span class="chip-icon">${p.id === data.host ? '♛' : '◆'}</span>
        <span>${p.name}</span>
        ${p.id === myId ? '<span class="chip-you">YOU</span>' : ''}
      </div>
    `).join('');
  }

  const startBtn = document.getElementById('btn-start');
  if (startBtn) startBtn.style.display = data.host === myId ? 'block' : 'none';

  const waitNote = document.getElementById('lobby-wait-note');
  if (waitNote) waitNote.style.display = data.host !== myId ? 'block' : 'none';
}

// ── Setup ─────────────────────────────────────────────────────────────────────
function renderSetup(data) {
  const me = data.players?.[myId];
  // Check if all ready → transition to playing
  const allReady = Object.values(data.players || {}).every(p => p.ready);
  if (allReady) {
    DB.update(`rooms/${roomCode}`, { status: 'playing' });
    return;
  }

  if (me?.ready) {
    screen('screen-waiting');
    const waiting = Object.values(data.players || {})
      .filter(p => !p.ready).map(p => p.name).join(', ');
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

  const me       = data.players?.[myId];
  const allP     = Object.values(data.players || {});
  const targets  = allP.filter(p => p.id !== myId && !p.eliminated);
  const elimd    = allP.filter(p => p.id !== myId && p.eliminated);

  // ── My status bar
  const statusEl = document.getElementById('my-status');
  if (statusEl) {
    statusEl.innerHTML = me?.eliminated
      ? `<span class="tag elim">ELIMINATED</span>
         Rahasiamu: <span class="mono secret-val">${me.secret}</span>`
      : `<span class="tag alive">ALIVE</span>
         Rahasiamu: <span class="mono secret-val redacted">${me?.secret?.replace(/./g,'●') || '????'}</span>`;
  }

  // ── Guess panels
  const guessArea = document.getElementById('guess-area');
  if (guessArea) {
    if (me?.eliminated) {
      guessArea.innerHTML = '<div class="empty-state">Kamu dieliminasi. Tonton pertandingan.</div>';
    } else if (targets.length === 0) {
      guessArea.innerHTML = '<div class="empty-state">Semua lawan dieliminasi. Menunggu hasil...</div>';
    } else {
      guessArea.innerHTML = '';
      targets.forEach(t => guessArea.appendChild(buildGuessPanel(t, data)));
    }
  }

  // ── Eliminated list
  const elimEl = document.getElementById('elim-list');
  if (elimEl) {
    elimEl.innerHTML = elimd.length
      ? elimd.map(p => `
          <div class="elim-chip">
            <span class="elim-name">💀 ${p.name}</span>
            <span class="mono elim-secret">${p.secret}</span>
          </div>`).join('')
      : '<span class="dim">Belum ada yang dieliminasi.</span>';
  }

  renderLog(data.log || []);
  renderMatrix(data.guesses || {}, data.players || {});
}

// ── Guess Panel ───────────────────────────────────────────────────────────────
function buildGuessPanel(target, data) {
  const d = data.digits;
  const myGuesses = Object.values(data.guesses || {})
    .filter(g => g.from === myId && g.target === target.id)
    .sort((a, b) => a.ts - b.ts);

  const lastGuess = myGuesses.at(-1)?.guess ?? '';
  const hl = highlights[target.id] ?? new Set();

  // Digit display row
  let digitRow = '';
  if (lastGuess) {
    for (let i = 0; i < lastGuess.length; i++) {
      const green = hl.has(i);
      digitRow += `<button class="digit-cell ${green ? 'confirmed' : ''}"
        onclick="Game.toggleHighlight('${target.id}', ${i})"
        title="Klik untuk tandai sebagai benar">${lastGuess[i]}</button>`;
    }
  } else {
    for (let i = 0; i < d; i++) digitRow += `<div class="digit-cell empty">?</div>`;
  }

  // Recent guess history (last 5, newest first)
  const historyHtml = myGuesses.slice(-5).reverse().map(g => `
    <div class="history-row">
      <span class="mono">${g.guess}</span>
      <span class="correct-badge">${g.correct} / ${d} ✓</span>
    </div>`).join('');

  const panel = document.createElement('div');
  panel.className = 'guess-panel';
  panel.dataset.targetId = target.id;
  panel.innerHTML = `
    <div class="panel-top">
      <span class="target-label">${target.name}</span>
      <span class="guess-count">${myGuesses.length} tebakan</span>
    </div>
    <div class="digit-row">${digitRow}</div>
    ${lastGuess ? '<p class="digit-hint">Tap angka untuk tandai ✓ (hijau)</p>' : ''}
    <div class="guess-input-row">
      <input type="tel" class="guess-input" id="inp-${target.id}"
        maxlength="${d}" placeholder="${'0'.repeat(d)}"
        oninput="this.value=this.value.replace(/\\D/g,'')"
        onkeydown="if(event.key==='Enter')Game.submitGuess('${target.id}',this.value)">
      <button class="btn-guess" onclick="Game.submitGuess('${target.id}', document.getElementById('inp-${target.id}').value); document.getElementById('inp-${target.id}').value=''">
        TEBAK
      </button>
    </div>
    <div class="guess-history">${historyHtml}</div>
  `;
  return panel;
}

// ── Log ───────────────────────────────────────────────────────────────────────
function renderLog(log) {
  const el = document.getElementById('game-log');
  if (!el) return;
  el.innerHTML = [...log].reverse().slice(0, 25).map((line, i) => `
    <div class="log-line ${i === 0 ? 'latest' : ''}">${line}</div>
  `).join('') || '<div class="dim">Belum ada tebakan.</div>';
}

// ── Result Matrix ─────────────────────────────────────────────────────────────
function renderMatrix(guesses, players) {
  const el = document.getElementById('history-table');
  if (!el) return;

  const list = Object.values(players);
  const d    = gameState?.digits ?? 4;

  // Build: guesser → target → latest guess entry
  const matrix = {};
  Object.values(guesses).forEach(g => {
    if (!matrix[g.from]) matrix[g.from] = {};
    const prev = matrix[g.from][g.target];
    if (!prev || g.ts > prev.ts) matrix[g.from][g.target] = g;
  });

  let html = `<table>
    <thead><tr>
      <th class="th-label">↓ Penebak / Target →</th>
      ${list.map(p => `<th>${p.name}${p.eliminated ? ' 💀' : ''}</th>`).join('')}
    </tr></thead>
    <tbody>`;

  list.forEach(guesser => {
    html += `<tr>
      <td class="row-name">
        ${guesser.name}
        ${guesser.id === myId ? '<span class="you-badge">YOU</span>' : ''}
      </td>`;
    list.forEach(target => {
      if (guesser.id === target.id) {
        html += '<td class="cell-self">—</td>';
      } else {
        const e = matrix[guesser.id]?.[target.id];
        if (e) {
          const won = e.correct === d;
          html += `<td class="${won ? 'cell-win' : 'cell-val'}">
            <span class="mono">${e.guess}</span>
            <span class="matrix-badge ${won ? 'win' : ''}">${e.correct}✓</span>
          </td>`;
        } else {
          html += '<td class="cell-empty">–</td>';
        }
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

  const nameEl = document.getElementById('winner-name');
  const msgEl  = document.getElementById('winner-msg');
  const codeEl = document.getElementById('ended-code');

  if (nameEl) nameEl.textContent = data.winnerName ?? '???';
  if (msgEl)  msgEl.textContent  = data.winner === myId ? '🏆 KAMU MENANG!' : `${data.winnerName} menang!`;
  if (codeEl) codeEl.textContent = roomCode;

  const secrets = document.getElementById('ended-secrets');
  if (secrets) {
    secrets.innerHTML = Object.values(data.players || {}).map(p => `
      <div class="secret-row ${p.id === myId ? 'is-me' : ''} ${p.id === data.winner ? 'is-winner' : ''}">
        <span class="secret-name">${p.id === data.winner ? '🏆 ' : ''}${p.name}</span>
        <span class="mono secret-number">${p.secret ?? '????'}</span>
      </div>`).join('');
  }
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API — exposed to HTML via window.Game
// ════════════════════════════════════════════════════════════════
window.Game = {
  createRoom,
  joinRoom,
  startGame,
  submitSecret,
  submitGuess,
  toggleHighlight,
  copyCode,
  toast,
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Show local mode notice
  if (DB.isLocal) {
    setTimeout(() => toast('Mode lokal aktif — Firebase belum dikonfigurasi', 'info'), 800);
  }

  // Digit selector
  let selectedDigits = 3;
  document.querySelectorAll('.digit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.digit-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDigits = parseInt(btn.dataset.val);
    });
  });

  // Create room
  document.getElementById('btn-create')?.addEventListener('click', () => {
    const name = document.getElementById('create-name')?.value.trim();
    if (!name) { toast('Masukkan namamu.', 'err'); return; }
    createRoom(name, selectedDigits);
  });

  // Join room
  document.getElementById('btn-join')?.addEventListener('click', () => {
    const name = document.getElementById('join-name')?.value.trim();
    const code = document.getElementById('join-code')?.value.trim().toUpperCase();
    if (!name) { toast('Masukkan namamu.', 'err'); return; }
    if (!code) { toast('Masukkan kode room.', 'err'); return; }
    joinRoom(name, code);
  });

  // Lock secret
  document.getElementById('btn-lock-secret')?.addEventListener('click', () => {
    const val = document.getElementById('setup-input')?.value.trim();
    submitSecret(val);
  });

  // Enter keys on inputs
  document.getElementById('create-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create')?.click();
  });
  document.getElementById('join-code')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-join')?.click();
  });
  document.getElementById('setup-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-lock-secret')?.click();
  });
});