/**
 * Battle sandbox: a development page for trying the turn-based battle prototype by hand (`npm run dev`, then
 * `/battle-sandbox.html`). The production build bundles only `index.html`, so this page never ships with the game.
 */
import './sandbox.css';
import {
  reactionWindow, suggestCommand, type BattleCommand, type BattleCommandOption, type BattleDifficulty, type BattleEnemySnapshot,
  type BattleOpening, type BattleSnapshot, type Reaction, type SkillId,
} from '../game/battle';
import type { FactionId } from '../game/types';
import {
  actorName, describeBlow, describeLog, HERO_NAMES, moveName, noticeText, SandboxSession, summarize, TICK_MS, type BlowFeedback,
} from './session';

interface Settings {
  faction: FactionId;
  difficulty: BattleDifficulty;
  opening: BattleOpening;
  seed: string;
  latency: number;
  auto: boolean;
  ring: boolean;
  windows: boolean;
  sound: boolean;
}
declare global {
  interface Window { battleSandbox?: { readonly session: SandboxSession; readonly settings: Settings } }
}

const STORAGE_KEY = 'korovany2:battle-sandbox';
const DEFAULTS: Settings = {
  faction: 'guard', difficulty: 'standard', opening: 'neutral', seed: 'sandbox-1', latency: 0,
  auto: false, ring: true, windows: false, sound: true,
};
/** Approach rings appear this many ticks before impact and meet the target circle exactly at impact. */
const APPROACH_TICKS = 48;
const TARGET_RADIUS = 34, RING_RADIUS = 104;
const KIND_ICONS: Readonly<Record<string, string>> = { soldier: '⚔', archer: '🏹', captain: '⚒' };
const HERO_ICONS: Readonly<Record<FactionId, string>> = { elf: '🏹', guard: '🛡', villain: '🪓' };
const FACTIONS: readonly FactionId[] = ['elf', 'guard', 'villain'];
const DIFFICULTIES: readonly BattleDifficulty[] = ['story', 'standard', 'expert'];
const OPENINGS: readonly BattleOpening[] = ['neutral', 'first-strike', 'ambushed'];

function loadSettings(): Settings {
  let saved: Partial<Settings> = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Settings>; } catch { /* use defaults */ }
  const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
  const flag = (value: unknown, fallback: boolean): boolean => typeof value === 'boolean' ? value : fallback;
  return {
    faction: pick(saved.faction, FACTIONS, DEFAULTS.faction), difficulty: pick(saved.difficulty, DIFFICULTIES, DEFAULTS.difficulty),
    opening: pick(saved.opening, OPENINGS, DEFAULTS.opening),
    seed: typeof saved.seed === 'string' && saved.seed.length > 0 && saved.seed.length <= 80 ? saved.seed : DEFAULTS.seed,
    latency: Number.isInteger(saved.latency) && saved.latency! >= 0 && saved.latency! <= 12 ? saved.latency! : DEFAULTS.latency,
    auto: flag(saved.auto, DEFAULTS.auto), ring: flag(saved.ring, DEFAULTS.ring), windows: flag(saved.windows, DEFAULTS.windows),
    sound: flag(saved.sound, DEFAULTS.sound),
  };
}

/** Short synthesized cues; created on the first user gesture, as browsers require. */
class Cues {
  enabled = true;
  private context: AudioContext | null = null;
  unlock(): void {
    if (!this.enabled) return;
    this.context ??= new AudioContext();
    if (this.context.state === 'suspended') void this.context.resume();
  }
  play(kind: 'windup' | 'heavy' | 'parry' | 'dodge' | 'hit'): void {
    const context = this.context;
    if (!this.enabled || !context || context.state !== 'running') return;
    const start = context.currentTime;
    const tone = (from: number, to: number, seconds: number, type: OscillatorType, volume: number): void => {
      const oscillator = context.createOscillator(), gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(from, start);
      oscillator.frequency.exponentialRampToValueAtTime(to, start + seconds);
      gain.gain.setValueAtTime(volume, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + seconds + 0.02);
    };
    if (kind === 'windup') tone(330, 520, 0.12, 'triangle', 0.08);
    else if (kind === 'heavy') tone(170, 110, 0.28, 'sawtooth', 0.06);
    else if (kind === 'parry') { tone(1560, 1320, 0.18, 'triangle', 0.12); tone(2340, 2200, 0.12, 'sine', 0.05); }
    else if (kind === 'dodge') tone(760, 240, 0.16, 'sine', 0.07);
    else tone(130, 50, 0.22, 'sine', 0.22);
  }
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const bar = (value: number, max: number, kind: string): string =>
  `<span class="bar ${kind}"><span style="width:${Math.max(0, Math.min(100, value / max * 100))}%"></span><em>${Math.round(value)} / ${max}</em></span>`;
const pips = (filled: number, total: number, kind: string): string =>
  Array.from({ length: total }, (_, i) => `<i class="pip ${kind}${i < filled ? ' on' : ''}"></i>`).join('');
const msLabel = (ticks: number): string => `${Math.round(ticks * TICK_MS)} ms`;

let settings = loadSettings();
let session = new SandboxSession({ ...setupOf(settings) }, settings.auto);
let visitFeedback: BlowFeedback[] = [];
let selecting: BattleCommandOption | null = null;
let notice: string | null = null;
let lastBlow: BlowFeedback | null = null;
let flash: { kind: string; text: string; until: number } | null = null;
let logLines: { text: string; kind: string }[] = [];
let lastLogId = 0, lastActionId = 0, renderedKey = '';
const cues = new Cues();

function setupOf(value: Settings) {
  return { seed: value.seed, faction: value.faction, encounter: 'post-garrison' as const, difficulty: value.difficulty,
    opening: value.opening, latencyTicks: value.latency };
}

const root = document.getElementById('sandbox')!;
root.innerHTML = `
  <header class="top">
    <div class="title">
      <h1>Battle sandbox</h1>
      <p>Korovany II · turn-based battles with timed defence · a development prototype that is not part of the published game</p>
    </div>
    <form class="setup">
      <label>Hero <select name="faction">${FACTIONS.map(f => `<option value="${f}">${HERO_NAMES[f]}</option>`).join('')}</select></label>
      <label>Difficulty <select name="difficulty">${DIFFICULTIES.map(d => `<option value="${d}">${d[0]!.toUpperCase()}${d.slice(1)}</option>`).join('')}</select></label>
      <label>Opening <select name="opening">${OPENINGS.map(o => `<option value="${o}">${o.replace('-', ' ')}</option>`).join('')}</select></label>
      <label>Seed <input name="seed" maxlength="80" size="12" autocomplete="off"></label>
      <label>Latency <input name="latency" type="number" min="0" max="12" step="1"> <output name="latencyMs"></output></label>
      <label class="check"><input type="checkbox" name="auto"> Auto commands</label>
      <label class="check"><input type="checkbox" name="ring"> Approach rings</label>
      <label class="check"><input type="checkbox" name="windows"> Show windows</label>
      <label class="check"><input type="checkbox" name="sound"> Sound</label>
      <button type="submit">New battle</button>
      <button type="button" data-action="random">Random seed</button>
    </form>
  </header>
  <main class="layout">
    <section class="stage">
      <ol class="timeline" aria-label="Turn order"></ol>
      <div class="field">
        <div class="band" data-band="far"><span class="band-label">Far</span><div class="cards"></div></div>
        <div class="band" data-band="close"><span class="band-label">Close</span><div class="cards"></div></div>
        <div class="reaction">
          <svg viewBox="-110 -110 220 220" aria-hidden="true"><circle class="target" r="${TARGET_RADIUS}"></circle><g class="rings"></g></svg>
          <div class="cue"></div>
        </div>
        <div class="hero-slot"></div>
        <div class="banner" hidden></div>
      </div>
      <div class="commands"></div>
      <p class="notice" aria-live="polite"></p>
    </section>
    <aside class="side">
      <section><h2>Last blow</h2><p class="last-blow">No blows yet.</p></section>
      <section><h2>Your reactions (this visit)</h2><dl class="stats"></dl></section>
      <section class="log"><h2>Combat log</h2><ol></ol></section>
      <section class="help">
        <h2>How to play</h2>
        <p>On your turn, pick a command: a basic attack costs nothing and grants 1 AP; skills cost AP. On enemy turns a ring
          closes on the centre at the moment each blow lands.</p>
        <p><kbd>E</kbd> <b>parry</b>: a tight window; +1 AP and break damage, and parrying every blow of a move earns a counter.
          <kbd>Q</kbd> <b>dodge</b>: a wider window that only avoids the blow. Red <b>heavy</b> blows can only be dodged.
          Only your first press near each blow counts, so mashing fails.</p>
        <p>Melee enemies must spend a turn to close in from the far band. Filling an enemy's break meter makes it lose its
          next turn.</p>
      </section>
    </aside>
  </main>
  <footer class="keys">
    <span><kbd>E</kbd> / left click / <kbd>RB</kbd> parry</span><span><kbd>Q</kbd> / right click / <kbd>B</kbd> dodge</span>
    <span><kbd>1</kbd>–<kbd>9</kbd> command or target</span><span><kbd>Enter</kbd> / <kbd>A</kbd> suggested command</span>
    <span><kbd>Esc</kbd> cancel or pause</span><span><kbd>R</kbd> rematch</span>
  </footer>`;

const $ = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!;
const form = $<HTMLFormElement>('form.setup');
const field = $<HTMLElement>('.field');
const reactionZone = $<HTMLElement>('.reaction');
const rings = $<SVGGElement>('.rings');
const cue = $<HTMLElement>('.cue');
const banner = $<HTMLElement>('.banner');

function syncForm(): void {
  const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  control('faction').value = settings.faction;
  control('difficulty').value = settings.difficulty;
  control('opening').value = settings.opening;
  control('seed').value = settings.seed;
  control('latency').value = String(settings.latency);
  for (const key of ['auto', 'ring', 'windows', 'sound'] as const) control(key).checked = settings[key];
  (form.elements.namedItem('latencyMs') as HTMLOutputElement).value = `ticks (${msLabel(settings.latency)})`;
}

function readForm(): Settings {
  const data = new FormData(form);
  const latency = Math.max(0, Math.min(12, Math.round(Number(data.get('latency')) || 0)));
  const seed = String(data.get('seed') ?? '').trim().slice(0, 80) || DEFAULTS.seed;
  return {
    faction: data.get('faction') as FactionId, difficulty: data.get('difficulty') as BattleDifficulty,
    opening: data.get('opening') as BattleOpening, seed, latency, auto: data.has('auto'), ring: data.has('ring'),
    windows: data.has('windows'), sound: data.has('sound'),
  };
}

function saveSettings(): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* storage is optional */ }
}

function newBattle(): void {
  session = new SandboxSession(setupOf(settings), settings.auto);
  selecting = null;
  notice = null;
  lastBlow = null;
  flash = null;
  logLines = [];
  lastLogId = 0;
  lastActionId = 0;
  renderedKey = '';
  cues.enabled = settings.sound;
  syncForm();
  saveSettings();
}

function react(reaction: Reaction): void {
  cues.unlock();
  session.react(reaction);
}

function issue(option: BattleCommandOption, target?: string): void {
  const command: BattleCommand = option.command === 'attack' ? { type: 'attack', target: target! }
    : option.command === 'item' ? { type: 'item', item: 'tonic' }
      : { type: 'skill', skill: option.id as SkillId, ...(target ? { target } : {}) };
  const refused = session.command(command);
  notice = refused ? noticeText(refused) : null;
  selecting = null;
}

function choose(index: number): void {
  const s = session.snapshot;
  if (s.phase !== 'command' || session.paused) return;
  if (selecting) {
    const target = selecting.targets[index];
    if (target) issue(selecting, target);
    return;
  }
  const option = s.commands[index];
  if (!option) return;
  if (!option.enabled) { notice = noticeText(option.reason!); return; }
  if (option.targets.length > 1) { selecting = option; notice = null; return; }
  issue(option, option.targets[0]);
}

function suggested(): void {
  const s = session.snapshot;
  if (s.phase !== 'command' || session.paused) return;
  const refused = session.command(suggestCommand(s));
  notice = refused ? noticeText(refused) : null;
  selecting = null;
}

function togglePause(force?: boolean): void {
  if (session.over) return;
  session.paused = force ?? !session.paused;
  renderedKey = '';
}

function describeCommand(s: BattleSnapshot, command: BattleCommand): string {
  if (command.type === 'item') return 'Tonic';
  const name = command.type === 'attack' ? 'Attack' : moveName(command.skill);
  return command.target ? `${name} → ${actorName(s, command.target)}` : name;
}

function enemyCard(s: BattleSnapshot, e: BattleEnemySnapshot): string {
  const dead = e.hp <= 0, acting = s.phase === 'action' && s.action?.actor === e.id;
  const targetIndex = selecting ? selecting.targets.indexOf(e.id) : -1;
  const classes = ['card', 'enemy', dead && 'dead', acting && 'acting', targetIndex >= 0 && 'targetable', e.broken && 'broken']
    .filter(Boolean).join(' ');
  const blows = acting ? s.action!.hits.map(h => `<i class="hit-pip ${h.outcome}${h.heavy ? ' heavy' : ''}"></i>`).join('') : '';
  return `<button type="button" class="${classes}" data-target="${e.id}"${targetIndex >= 0 ? '' : ' tabindex="-1"'}>
    ${targetIndex >= 0 ? `<span class="key">${targetIndex + 1}</span>` : ''}
    <span class="name">${KIND_ICONS[e.kind] ?? ''} ${escapeHtml(actorName(s, e.id))}</span>
    ${bar(e.hp, e.maxHp, 'hp')}
    <span class="meter" title="Break meter">${pips(e.breakMeter, e.breakMax, 'break')}</span>
    <span class="badges">${dead ? '<b class="badge">Fallen</b>' : ''}${e.broken ? '<b class="badge broken">Broken</b>' : ''}${
      e.rallied ? `<b class="badge rallied">Rallied ×${e.rallied}</b>` : ''}</span>
    ${acting ? `<span class="move">${escapeHtml(moveName(s.action!.move))} ${blows}</span>` : ''}
  </button>`;
}

function heroCard(s: BattleSnapshot): string {
  const h = s.hero, acting = s.phase === 'action' && s.action?.actor === 'hero';
  return `<div class="card hero${acting ? ' acting' : ''}${s.phase === 'command' ? ' turn' : ''}">
    <span class="name">${HERO_ICONS[h.faction]} ${HERO_NAMES[h.faction]}</span>
    ${bar(h.hp, h.maxHp, 'hp')}
    <span class="meter" title="Action points">${pips(h.ap, h.maxAp, 'ap')} <small>${h.ap} AP</small></span>
    <span class="badges"><b class="badge">Tonics ×${h.tonics}</b>${h.bulwark ? '<b class="badge guard">Bulwark</b>' : ''}${
      h.empowered > 1 ? `<b class="badge rallied">War cry ×${h.empowered}</b>` : ''}</span>
    ${acting ? `<span class="move">${escapeHtml(moveName(s.action!.move))}</span>` : ''}
  </div>`;
}

function commandsPanel(s: BattleSnapshot): string {
  if (session.over) return `<p class="hint">${s.phase === 'victory' ? 'Victory' : 'Defeat'}: press <kbd>R</kbd> for a rematch.</p>`;
  if (session.paused) return '<p class="hint">Paused.</p><button type="button" data-action="resume">Resume</button>';
  if (s.phase === 'action') {
    const enemyTurn = s.action!.actor !== 'hero';
    return `<p class="hint">${enemyTurn ? `${escapeHtml(actorName(s, s.action!.actor))} attacks: <kbd>E</kbd> parry or <kbd>Q</kbd> dodge as each ring closes.`
      : `${escapeHtml(moveName(s.action!.move))}…`}</p>`;
  }
  if (selecting) {
    const option = selecting;
    return `<p class="hint">Choose a target for <b>${escapeHtml(moveName(option.id))}</b>: ${option.targets.map((id, i) =>
      `<kbd>${i + 1}</kbd> ${escapeHtml(actorName(s, id))}`).join(' · ')}, or click a card.</p>
      <button type="button" data-action="cancel">Cancel (Esc)</button>`;
  }
  if (session.autoCommands) return '<p class="hint">Auto commands are on: the suggested command plays for you.</p>';
  const suggestion = suggestCommand(s);
  const suggestedId = suggestion.type === 'attack' ? 'attack' : suggestion.type === 'item' ? 'tonic' : suggestion.skill;
  return `<div class="buttons">${s.commands.map((option, i) => `<button type="button" class="command${option.id === suggestedId ? ' suggested' : ''}"
      data-option="${i}"${option.enabled ? '' : ` aria-disabled="true" title="${escapeHtml(noticeText(option.reason!))}"`}>
      <kbd>${i + 1}</kbd> ${escapeHtml(moveName(option.id))}${option.cost ? ` <small>${option.cost} AP</small>` : ''}${
      option.id === 'tonic' ? ` <small>×${s.hero.tonics}</small>` : ''}</button>`).join('')}</div>
    <p class="hint">Your turn. Suggested: <b>${escapeHtml(describeCommand(s, suggestion))}</b> (<kbd>Enter</kbd>). Click an enemy for a quick attack.</p>`;
}

function statsPanel(): string {
  const summary = summarize(visitFeedback);
  const advice = summary.latencyChange === null ? '' : (() => {
    const latency = Math.max(0, Math.min(12, settings.latency + summary.latencyChange!));
    return latency === settings.latency ? '' :
      `<dt>Suggestion</dt><dd>Your presses run ${summary.latencyChange! > 0 ? 'late' : 'early'}: try latency ${latency} (${msLabel(latency)})</dd>`;
  })();
  return `<dt>Blows</dt><dd>${summary.blows}</dd><dt>Parried</dt><dd>${summary.parried}</dd><dt>Dodged</dt><dd>${summary.dodged}</dd>
    <dt>Hit</dt><dd>${summary.hit}</dd><dt>Timing bias</dt><dd>${summary.bias === null ? '–' :
      `${summary.bias > 0 ? '+' : ''}${Math.round(summary.bias)} ms vs window centres`}</dd>${advice}`;
}

function bannerHtml(s: BattleSnapshot): string | null {
  if (session.over) {
    const blows = session.feedback, defended = blows.filter(f => f.outcome !== 'hit').length;
    return `<h2>${s.phase === 'victory' ? 'Victory' : 'Defeat'}</h2>
      <p>${s.round} turns · ${Math.round(s.tick / 60)} s of action · HP ${s.hero.hp} / ${s.hero.maxHp} · ${defended} of ${blows.length} blows defended</p>
      <p><button type="button" data-action="rematch">Rematch (R)</button> <button type="button" data-action="random">New seed</button></p>`;
  }
  if (session.paused) return '<h2>Paused</h2><p><button type="button" data-action="resume">Resume (Esc)</button></p>';
  return null;
}

function ingest(s: BattleSnapshot): void {
  for (const entry of s.log) {
    if (entry.id <= lastLogId) continue;
    lastLogId = entry.id;
    const text = describeLog(s, entry);
    if (text) logLines.unshift({ text, kind: entry.kind });
  }
  const action = s.action;
  if (action && action.id > lastActionId) {
    lastActionId = action.id;
    const blows = action.hits.length ? ` (${action.hits.length} blow${action.hits.length > 1 ? 's' : ''}${
      action.hits.some(h => h.heavy) ? ', heavy' : ''})` : '';
    logLines.unshift({ text: `${actorName(s, action.actor)}: ${moveName(action.move)}${blows}`, kind: 'action' });
    if (action.actor !== 'hero' && action.hits.length) cues.play(action.hits.some(h => h.heavy) ? 'heavy' : 'windup');
  }
  logLines = logLines.slice(0, 80);
}

function onBlow(blow: BlowFeedback, now: number): void {
  lastBlow = blow;
  visitFeedback = [...visitFeedback, blow];
  cues.play(blow.outcome === 'parried' ? 'parry' : blow.outcome === 'dodged' ? 'dodge' : 'hit');
  flash = { kind: blow.outcome, text: blow.outcome === 'parried' ? 'PARRIED' : blow.outcome === 'dodged' ? 'DODGED' : `−${blow.damage}`,
    until: now + 450 };
}

function render(now: number): void {
  const s = session.snapshot;
  const key = [s.tick, s.phase, s.round, selecting?.id, notice, session.paused, session.autoCommands, lastLogId, visitFeedback.length].join('|');
  if (key !== renderedKey) {
    renderedKey = key;
    $('.timeline').innerHTML = s.order.map((id, i) =>
      `<li class="${id === 'hero' ? 'hero' : 'enemy'}${i === 0 ? ' current' : ''}">${id === 'hero' ? 'You' : escapeHtml(actorName(s, id))}</li>`).join('');
    for (const band of ['far', 'close'] as const) {
      $(`.band[data-band="${band}"] .cards`).innerHTML = s.enemies.filter(e => e.band === band).map(e => enemyCard(s, e)).join('');
    }
    $('.hero-slot').innerHTML = heroCard(s);
    $('.commands').innerHTML = commandsPanel(s);
    $('.notice').textContent = notice ?? '';
    $('.last-blow').textContent = lastBlow ? describeBlow(s, lastBlow) : 'No blows yet.';
    $('.stats').innerHTML = statsPanel();
    $('.log ol').innerHTML = logLines.map(line => `<li class="${line.kind}">${escapeHtml(line.text)}</li>`).join('');
    const html = bannerHtml(s);
    banner.hidden = html === null;
    banner.innerHTML = html ?? '';
    field.classList.toggle('enemy-turn', s.phase === 'action' && s.action?.actor !== 'hero');
  }
  renderRings(s, now);
}

function renderRings(s: BattleSnapshot, now: number): void {
  const action = s.action;
  const live = !session.over && !session.paused && s.phase === 'action' && action && action.actor !== 'hero';
  const pending = live ? action!.hits.filter(h => h.outcome === 'pending') : [];
  const t = s.tick + session.alpha;
  rings.innerHTML = settings.ring ? pending.map((hit, i) => {
    const remaining = hit.impact - t;
    if (remaining > APPROACH_TICKS || remaining < -3) return '';
    const radius = TARGET_RADIUS + Math.max(0, remaining) / APPROACH_TICKS * (RING_RADIUS - TARGET_RADIUS);
    return `<circle class="ring${hit.heavy ? ' heavy' : ''}${i > 0 ? ' later' : ''}" r="${radius.toFixed(2)}"></circle>`;
  }).join('') : '';
  const next = pending[0];
  let open = '';
  if (settings.windows && next) {
    const offset = t - settings.latency - next.impact;
    const parry = reactionWindow(settings.faction, settings.difficulty, 'parry');
    const dodge = reactionWindow(settings.faction, settings.difficulty, 'dodge');
    open = !next.heavy && offset >= -parry.early && offset <= parry.late ? 'parry-open'
      : offset >= -dodge.early && offset <= dodge.late ? 'dodge-open' : '';
  }
  reactionZone.className = `reaction${open ? ` ${open}` : ''}${flash && now < flash.until ? ` flash-${flash.kind}` : ''}`;
  if (flash && now < flash.until) cue.textContent = flash.text;
  else if (next) cue.innerHTML = `${next.heavy ? '<b class="heavy">HEAVY · dodge</b>' : 'parry <kbd>E</kbd> · dodge <kbd>Q</kbd>'}<small>blow ${
    next.index + 1} of ${action!.hits.length}</small>`;
  else cue.textContent = '';
}

let previousPad: boolean[] = [];
function pollGamepad(): void {
  const pad = navigator.getGamepads?.().find(p => p?.connected && p.mapping === 'standard') ?? null;
  if (!pad) { previousPad = []; return; }
  const pressed = pad.buttons.map(button => button.pressed);
  const edge = (index: number): boolean => pressed[index] === true && previousPad[index] !== true;
  if (edge(1)) { if (selecting) { selecting = null; } else react('dodge'); }
  if (edge(5)) react('parry');
  if (edge(0)) suggested();
  if (edge(9)) togglePause();
  previousPad = pressed;
}

const typing = (target: EventTarget | null): boolean =>
  target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;

window.addEventListener('keydown', event => {
  if (typing(event.target) && event.code !== 'Escape') return;
  if (event.repeat) return;
  const digit = /^Digit([1-9])$/.exec(event.code);
  if (event.code === 'KeyQ') react('dodge');
  else if (event.code === 'KeyE') react('parry');
  else if (digit) choose(Number(digit[1]) - 1);
  else if (event.code === 'Enter' || event.code === 'NumpadEnter') suggested();
  else if (event.code === 'Escape') {
    if (typing(event.target)) (event.target as HTMLElement).blur();
    else if (selecting) selecting = null;
    else togglePause();
  } else if (event.code === 'KeyR') newBattle();
  else return;
  cues.unlock();
  event.preventDefault();
});

field.addEventListener('pointerdown', event => {
  if (session.snapshot.phase !== 'action' || session.paused) return;
  if (event.button === 0) react('parry');
  else if (event.button === 2) react('dodge');
  else return;
  event.preventDefault();
});
field.addEventListener('contextmenu', event => event.preventDefault());

root.addEventListener('click', event => {
  const element = (event.target as Element).closest<HTMLElement>('[data-option], [data-target], [data-action]');
  if (!element) return;
  cues.unlock();
  if (element.dataset.option !== undefined) choose(Number(element.dataset.option));
  else if (element.dataset.target !== undefined) {
    const s = session.snapshot, attack = s.commands.find(option => option.command === 'attack');
    if (selecting) issue(selecting, element.dataset.target);
    else if (s.phase === 'command' && !session.paused && !session.autoCommands && attack?.targets.includes(element.dataset.target)) {
      issue(attack, element.dataset.target);
    }
  } else if (element.dataset.action === 'cancel') selecting = null;
  else if (element.dataset.action === 'resume') togglePause(false);
  else if (element.dataset.action === 'rematch') newBattle();
  else if (element.dataset.action === 'random') {
    settings = { ...readForm(), seed: `sandbox-${Math.floor(Math.random() * 1e6)}` };
    newBattle();
  }
});

form.addEventListener('submit', event => {
  event.preventDefault();
  cues.unlock();
  settings = readForm();
  newBattle();
});
form.addEventListener('change', event => {
  const name = (event.target as HTMLInputElement).name;
  if (name === 'faction' || name === 'difficulty' || name === 'opening') {
    settings = readForm();
    newBattle();
    return;
  }
  if (!['auto', 'ring', 'windows', 'sound'].includes(name)) return;
  const next = readForm();
  settings = { ...settings, auto: next.auto, ring: next.ring, windows: next.windows, sound: next.sound };
  session.autoCommands = settings.auto;
  cues.enabled = settings.sound;
  if (settings.sound) cues.unlock();
  renderedKey = '';
  saveSettings();
});
form.addEventListener('input', () => {
  const latency = Math.max(0, Math.min(12, Math.round(Number((form.elements.namedItem('latency') as HTMLInputElement).value) || 0)));
  (form.elements.namedItem('latencyMs') as HTMLOutputElement).value = `ticks (${msLabel(latency)}), applies to the next battle`;
});
window.addEventListener('blur', () => togglePause(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) togglePause(true); });

window.battleSandbox = { get session() { return session; }, get settings() { return settings; } };

let last = performance.now();
function frame(now: number): void {
  const seconds = (now - last) / 1000;
  last = now;
  pollGamepad();
  for (const blow of session.advance(seconds)) onBlow(blow, now);
  ingest(session.snapshot);
  render(now);
  requestAnimationFrame(frame);
}
newBattle();
requestAnimationFrame(frame);
