# Turn-based battles with timed defence

Every fight in the game is a battle: turn-based, with timed defence. This folder is the engine: plain, deterministic
TypeScript with no rendering and no world. `../battles.ts` runs it inside the campaign simulation (see
[Campaign battles](#campaign-battles)), the shell draws and controls it (`src/ui/battle-hud.ts`), and the
development [battle sandbox](#try-it-by-hand-the-battle-sandbox) plays it on its own. Bots and tests measure it
(`tests/battle-*.test.ts`, `tests/battle-bots.ts`).

The model is inspired by *Clair Obscur: Expedition 33*. The player chooses commands on their turn. On enemy turns,
the player reacts in real time: they **dodge** or **parry** each blow in its timing window, and parrying a whole
attack earns a counter.

## Why the combat changed

A measurement of the former real-time combat at `23bd6c0` (bots played 88 complete military campaigns through the
public `step()` input) found:

- **Very little fighting:** about 20–30 seconds per campaign, spread over 3–4 battles.
- **No way to lose:** no campaign was lost, even by a bot that never dodged or used an ability.
- **A dominant strategy:** circling a target while attacking beat the dodge mechanic.

World v3 had since added wilderness packs (wolves, ghouls and trolls). The problem was thin design rather than
real-time itself.

Turn-based battles fit this game because:

- its military fights are few, authored and tied to objectives;
- it is a narrative RPG at heart;
- its simulation already supported paused, deterministic transactions (`step({ narrative })`).

Timed defence keeps moment-to-moment skill for a **single hero**, which the Pillars of Eternity or Fallout model
would lack without a party. It also reuses what already existed: the authored `Windup`/`Strike`/`Recovery` troop and
monster clips and their tell rings, the dodge input, and controller menu navigation.

## Design pillars

1. **Every blow is readable and answerable.** Tests enforce it: blows are spaced beyond the reaction lockout, the
   first blow leaves a full attempt window, and every move settles before it ends.
2. **Reactions are the core skill; commands are the strategy.** On standard difficulty a player who never reacts
   loses a garrison battle; a perfect player takes no damage.
3. **Faction identity carries over:** elven range and evasion, the guard's parries and protection, the mountain
   ruler's aggression.
4. **Few, short battles.** A post garrison fight takes about 1–2.5 minutes, with no grinding.
5. **Accessible.** Story difficulty is winnable without reactions, latency can be calibrated, and keyboard, mouse
   and controller have parity.
6. **Deterministic and measured.** Bots re-measure balance on every change, and the targets are tests.

## Rules

All durations are 60 Hz ticks (`content.ts`).

### Turns, timeline and AP

- **Timeline:** combatants act on a conditional timeline. Each turn adds `100 / speed` to an actor's next time, so
  faster actors act more often. `snapshot.order` previews the next seven actors.
- **Hero's turn:** the battle waits for a command and **no time passes**. Commands are Attack, faction skills, a
  tonic (two per battle, each restoring a flat 50 HP) and, while a ward stands, **Cover the wagons**.
- **AP:** a basic attack costs 0 AP and grants +1, and so does covering the wagons. Skills cost 1–3 AP. A successful
  parry grants +1, and so does an elf's successful dodge. The maximum is 6 and battles start with 2.
- **Actions:** every action plays out tick by tick, both the hero's (damage lands at its impact tick) and the
  enemies' (their blows can be answered).

### Bands

Each enemy is either **close** or **far**.

- **Melee enemies** spend a turn approaching, and archers caught close usually step back.
- **Melee heroes:** striking a far target charges it, which pulls it close but deals 70%.
- **The elf** shoots at any band but deals 75% to close targets.

These two bands keep range meaningful without spatial tactics UI.

### Timed defence

Each enemy blow has an impact tick.

- **Attempt binding:** the first press within 24 ticks before impact is that blow's **one attempt**. Earlier presses
  bind to nothing, and any press starts an 8-tick lockout. As a result, a masher's bound press always falls before
  every standard and expert window. A test checks `attempt − lockout + 1 > widest window`.
- **Success:** a press succeeds inside `[impact − early, impact + late]`. Hits resolve 3 ticks after impact, plus the
  calibrated latency, so slightly late presses still count.
- **Dodge:** the wider window. It avoids the blow and nothing more (an elf also gains 1 AP).
- **Parry:** the tighter window. It avoids the blow, grants +1 AP and adds +1 to the attacker's break meter.
- **Counter:** parrying every blow of a move triggers an immediate counter. A melee hero cannot counter a far archer.
- **Heavy blows** (marked with a distinct ring, a `!` and a warning line) can only be dodged.
- **Latency calibration:** 0–12 ticks are subtracted from every press to absorb input and display delay.

| Early ticks before impact (late: dodge 3, parry 2) | Story | Standard | Expert |
| --- | --- | --- | --- |
| Dodge (elf: ×1.35) | 18 (elf 24) | 10 (elf 14) | 7 (elf 9) |
| Parry (guard: ×1.4) | 9 (guard 13) | 5 (guard 7) | 4 (guard 5) |

On standard difficulty that makes the parry window 133 ms wide and the dodge window 233 ms (the elf's 300 ms). Story
difficulty also scales enemy damage to 30%, and expert to 125%.

### Break

Hero hits, parries and counters fill an enemy's break meter. A broken enemy **loses its next turn** and takes 25%
extra damage until then. The meter does not fill while the enemy is broken.

### Heroes

| Hero | HP | Speed | Damage | Defence identity | Skills |
| --- | --- | --- | --- | --- | --- |
| Elf | 120 | 115 | 24, ranged | Dodge window ×1.35; a dodge grants +1 AP | **Aimed shot** (2 AP): 220%, +2 break. **Volley** (3): 90% to all. **Fall back** (2): every close enemy becomes far, then a shot. |
| Guard | 180 | 90 | 32, melee | Takes 90% damage; parry window ×1.4; counters deal 150% | **Shield bash** (2): +3 break. **Bulwark** (3): takes 35% damage until the guard's next turn, heals 25 and repairs each ward by 30. |
| Mountain ruler | 150 | 100 | 34, melee | 10% lifesteal; the first blow taken from each enemy move grants +1 AP (rage) | **Cleave** (3): 110% to every close enemy. **War cry** (1): pulls every enemy close; the next attack deals 125%. |

In the campaign the hero brings their campaign HP (the maximum includes vitality purchases) and the kit's damage
scaled by damage purchases. HP carries over between battles.

### Enemies

| Enemy | HP | Speed | Break | Moves (blow impact tick: damage; H = heavy) |
| --- | --- | --- | --- | --- |
| Soldier | 130 | 95 | 4 | Cut (38: 14); double cut (34: 10, 58: 10) |
| Archer | 90 | 100 | 3 | Loose (46: 12); pinning shot (64: 18 H); steps back when caught close (60%) |
| Captain | 185 | 85 | 6 | Hammer combo (32: 9, 52: 9, 86: 14, with a delayed third blow); overhead (56: 22 H); rally (30%): the next two attacks of every living defender deal 125% |
| Raut (warlord; the elf's and the guard's final battle) | 380 | 90 | 8 | Reaping arc (30: 9, 50: 9, 86: 14); skull-splitter (76: 24 H); earthshaker (40: 11, 88: 20 H); rally (20%) |
| Palace Marshal (the mountain ruler's final battle) | 360 | 100 | 8 | Halberd flurry (28: 7, 44: 7, 60: 7, 92: 11); shield charge (54: 20 H); feinted thrust (72: 17); rally (20%) |
| Grave wolf | 56 | 120 | 2 | Bite (26: 7); snapping lunge (24: 5, 42: 5) |
| Barrow ghoul | 96 | 100 | 3 | Raking claws (30: 7, 48: 7, 80: 11); grave rend (52: 15) |
| Bog troll | 420 | 70 | 8 | Slam (68: 26 H); fist and slam (40: 14, 92: 22 H); backhand (44: 16) |
| Raid wagon (legacy v1 campaign) | 200 | — | — | Never acts; it must be destroyed |

Troops strike a ward instead of the hero with a chance per attack (soldier 30%, archer 35%, captain 25%, bosses
15%); beasts never do.

### Wards and allies

- **Wards** are the convoy and an escorted shipment near the hero. A ward at zero is wrecked (the convoy is
  disabled, the shipment wrecked); both stay repairable in the field. A cart fights from the convoy (its kit's `ward`),
  so a wrecked convoy's weapon leaves the battle. **Cover the wagons** (0 AP, grants 1 AP) takes the hero's
  turn: until the next one, blows aimed at a ward come at the hero instead, where they can be parried or dodged.
- **Allies** act on the timeline against the weakest enemy, and enemies never target them:

| Ally | Speed | Damage | Move |
| --- | --- | --- | --- |
| Soldier | 80 | 12 | Strike |
| Archer | 85 | 10 | Shoot |
| Captain | 75 | 16 | Strike |
| Arrow cart (the elves' convoy) | 70 | 10 | Cart volley |
| Siege cart (the mountain army's convoy) | 45 | 26 | Siege shot |

**Openings:** a battle can open neutral, with a first strike (the hero acts first) or ambushed (the enemies act
first and their melee troops start close).

## Engine API

```ts
import { battleSnapshot, commandBattle, joinBattle, startBattle, tickBattle } from './index';
const state = startBattle({ seed, faction, enemies: [{ id: 'wolf-1', kind: 'wolf' }], difficulty, opening, latencyTicks });
commandBattle(state, { type: 'attack', target: 'wolf-1' }); // hero's turn only; refused commands set snapshot.notice
tickBattle(state, { parry: true });                          // one tick of the current action; one-shot pulses
battleSnapshot(state);                                       // phase, timeline, AP, bands, blows with impact ticks, log
```

- **State is plain data:** a `BattleState` is serializable, so campaign saves hold it as it is. `createBattle(setup)`
  wraps the same functions in an object (`command`, `tick`, `snapshot`) for the sandbox and the bots.
- **Setups:** exactly one of a preset `encounter` (sandbox and bots) and an `enemies` roster (with optional HP and a
  close band), plus optional `allies`, `wards` and `hero` (campaign HP, maximum and damage).
- **Joining:** `joinBattle(state, enemies)` adds enemies to a running battle (the fortress's reinforcement wave).
- **Malformed input throws:** setups, commands and inputs are checked before anything changes.
- **Unavailable commands** (`phase`, `target`, `ap`, `unavailable`, `item`) change nothing except `notice`.
- **Blow snapshots:** each blow in `action.hits` reports its target, outcome and reaction, and the tick of its one
  bound press (`pressed`, after latency compensation), so a presenter can show how early or late a press was.
- **Windows:** `reactionWindow(faction, difficulty, reaction)` is the single source of a reaction's window.
- **Suggestions:** `suggestCommand(snapshot)` returns the shared, deliberately simple command policy. The bots use
  it, and the sandbox offers it as a suggestion and as automatic commands.
- **Determinism:** enemy decisions use a seeded Aegis PRNG kept in the state. The same setup and the same inputs on
  the same ticks always produce the same battle.
- **Victory and defeat** freeze the battle.

## Campaign battles

`../battles.ts` integrates the engine into every campaign (world versions 1, 2 and 3). `../CONTRACT.md` has the exact
contract; in short:

| Area | As built |
| --- | --- |
| Field | Nobody deals damage in the field. Hostiles notice and chase the hero; projectiles in flight are harmless. |
| Engagement | `KorovanyEngagement` runs after the field systems. A field swing or arrow that lands on a hostile opens a battle with a **first strike**. Otherwise a hostile hunting the hero within contact range (its reach plus the hero's radius and 0.25 m; about 15 m for archers) opens one, **ambushed** when it comes from more than about 110° off the hero's heading. |
| Participants | The trigger, its group (post, raid escort, fortress or pack) within 30 m and other engaged hostiles within 18 m, at most five. Friendly troops within 22 m (at most three) and the convoy's weapon within 16 m are allies; the convoy and an escorted shipment within 16 m are wards. Melee enemies within 5 m start close. |
| Staging | In place, never in an arena: the hero faces the trigger, and each enemy gets a close place (beside the hero) and a far place (5–8 m) on its bearing, walkable, clear of other bodies and, for a beast, within its leash. Enemies walk to the place of their band. |
| World | While `CampaignData.battle` exists, every field system rests (movement, AI, convoy, escort, projectiles, the monster spawner, timers). `KorovanyBattle` runs first in each tick: the battle advances one tick per world tick while an action plays and waits on the hero's turn. Story commands other than tracking and closing are refused. |
| Presentation | The battle log drives the world: wounds, deaths with today's kill bookkeeping (coins, health drops, kills, raid, post and boss outcomes), ward damage, poses (`windup`/`attack`/`recovery` round each blow), effects and events. `GameSnapshot.battle` adds display names. |
| Final battle | The commander fights with two fortress guards. Unless all three posts are supplied, a wave of three soldiers (40 HP each, levies rushed from the walls) joins once the commander falls below 60% HP. |
| Outcome | Victory clears the battle and the field resumes in the same tick. Defeat ends the campaign, as before. |
| Saves | The session keeps a checkpoint taken as the battle began; saves during a battle hold it, so continuing restarts the battle. The validator regenerates the battle record from the saved world, trigger, opening and seed, and rejects any difference. |
| Options | Difficulty and latency compensation (`step({ battleOptions })`, saved) apply to battles that begin afterwards. |
| Shell | The battle HUD (`src/ui/battle-hud.ts`) keeps the battlefield clear: the turn order along the top, the enemies (HP, close or far, guard pips, broken, rallied, attacking) on the left, the hero (HP, AP, tonics, allies, wards) at the bottom left, and at the bottom right the commands and targets (1–9, the mouse or the controller; target numbers also mark the enemy cards) or, on enemy turns, the move and how to defend it. The road panels and minimap hide, the cursor is free, and the camera eases behind the hero's shoulder towards the foe it faces (`src/view/camera.ts`). Centred on the hero, the defence cue draws an approach ring per blow that meets the target circle at impact (rings appear 42 ticks ahead), the parry (gold) and dodge (blue) success bands, **NOW!** at the parry moment, a red ring and "!" for heavy blows, the Parry and Dodge keys that light up while they would succeed (always for the next blow a press would answer: the first unanswered one whose window is still open), and a report of every blow (parried, dodged, or hit with how early or late the press was, a press within the lockout, or none; a press arriving just after an unanswered blow lands turns its report into "too late"). The **Defence hints** setting (on by default) controls the bands, the lit keys and the explanations. Parry: `E`, `Space`, left click on the world, or `A`/`RT`. Dodge: `Q`, right click, or `B`. |
| Audio | A parry clang, victory and reinforcement cues, the existing hurt and kill sounds, and the combat music. |
| Text | RU/EN commands, skills, notices, log lines, guides and settings. |
| Tests and CI | `battle-engine`, `battle-campaign` (engagement and openings, the field at rest, saves mid-battle, allies and covering the wagons, options), `battle-balance` and `battle-prototype` (bots), `battle-hud` (every string the HUD can show, in both languages, and the defence cue's geometry), and `battle-browser` (the real shell in Chrome: commands, targets, the defence cue and its feedback, hints off, keyboard, mouse and controller; and the HUD driven tick by tick through real engine battles, for its reports and the blow it cues) in browser shard 1 of the `Game` workflow. Campaign acceptance plays every faction through its battles, the reinforcement wave included, with battle bots (`tests/driver.ts`). |

## Try it by hand: the battle sandbox

A development page plays a preset battle in real time:

```powershell
npm run dev   # then open http://127.0.0.1:5173/battle-sandbox.html
```

The page is `battle-sandbox.html` with `src/battle-sandbox/`. The production build bundles only `index.html`, so the
sandbox never ships with the game. What it offers:

- **Setup:** pick the hero, difficulty, opening, seed and latency compensation. Changing the hero, difficulty or
  opening starts a new battle.
- **Your turn:** pick a command with the mouse or `1`–`9`. Targeted commands then take `1`–`3` or a click on an
  enemy card. `Enter` (or `A` on a controller) plays the suggested command, and clicking an enemy is a quick attack.
- **Enemy turns:** a ring closes on the centre circle at the moment each blow lands; red rings are heavy blows.
  - Parry with `E`, left click or `RB`.
  - Dodge with `Q`, right click or `B`.
- **Feedback:** each blow reports the outcome and how many milliseconds early or late your press was against its
  window. The stats panel suggests a latency setting once your presses lean consistently early or late.
- **Options:**
  - *Show windows* tints the circle while each window is open.
  - *Auto commands* lets you practise reactions only.
  - *Sound* adds simple synthesized cues.
- **Other keys:** `Esc` pauses and `R` restarts the same battle. The page also pauses when it loses focus.

`tests/battle-sandbox.test.ts` covers the page's DOM-free core (`src/battle-sandbox/session.ts`): the 60 Hz clock
and its frame clamp, reaction pulses, per-blow timing feedback and the latency suggestion.

## Measured balance

The bots share one deliberately simple command policy (`suggestCommand`) across reaction profiles, so the only
variable is reaction skill. The human profiles are **assumptions**, not player data:

| Profile | Timing error (σ) | Missed blows | Parry attempts |
| --- | --- | --- | --- |
| Novice | 150 ms | 15% | 35% |
| Average | 100 ms | 7% | 60% |
| Expert | 58 ms | 2% | 85% |

Each profile tries to press 1 tick early. Playtests must calibrate these numbers.

### Post garrison

A soldier, an archer and a captain; 60 seeds per row, neutral opening, no allies or upgrades.

| Standard difficulty | Elf | Guard | Mountain ruler |
| --- | --- | --- | --- |
| No reactions | 0% | 0% | 0% |
| Masher (dodge every tick) | 0% | 0% | 0% |
| Novice | 93% | 88% | 77% |
| Average | 100%, 55% HP left | 100%, 56% HP left | 100%, 60% HP left |
| Expert | 100% | 100% | 100% |
| Perfect | 100%, no damage | 100%, no damage | 100%, no damage |
| Estimated minutes, average (5 s per command) | 1.9 | 2.1 | 1.4 |

- **Story difficulty:** no reactions wins 100% for every hero; a novice also wins 100%.
- **Expert difficulty:** average players win 85% / 93% / 88% (elf / guard / ruler); experts win 98% / 100% / 100%.
- **Openings:** averaged across heroes, a novice wins 86% neutral, 91% after a first strike and 73% when ambushed.

These targets are asserted by `tests/battle-prototype.test.ts`. To print the table:

```powershell
$env:KOROVANY_BATTLE_REPORT = '1'; npx vitest run tests/battle-prototype.test.ts
```

### Beasts

Standard difficulty, 40 seeds, neutral opening: wins, then the average HP left after a win.

| Encounter and reactions | Elf | Guard | Mountain ruler |
| --- | --- | --- | --- |
| Wolf pack (four), none | 100%, 45% | 100%, 53% | 100%, 67% |
| Wolf pack, novice | 100%, 68% | 100%, 66% | 100%, 89% |
| Ghoul pack (three), none | 0% | 0% | 8% |
| Ghoul pack, novice | 100%, 55% | 100%, 52% | 100%, 57% |
| Troll, none | 57%, 9% | 100%, 43% | 95%, 31% |
| Troll, novice | 100%, 52% | 100%, 57% | 100%, 59% |

A wolf pack only wears the hero down; ghouls need reactions; a troll is a long fight that costs much of the hero's
health without them.

### The final battle

The commander and two fortress guards, with the reinforcement wave; standard difficulty and 40 seeds unless noted.
"+1" is one damage and one vitality purchase.

| Reactions and upgrades | Elf | Guard | Mountain ruler |
| --- | --- | --- | --- |
| Average, none | 38% | 93% | 55% |
| Novice, +1 | 30% | 20% | 45% |
| Average, +1 | 85% (3.5 min) | 95% (4.1 min) | 90% (1.6 min) |
| Expert, +1 | 100% | 100% | 100% |
| Novice, +2 | 83% | 43% | 78% |
| Story difficulty, novice, none | 100% | 100% | 100% |
| Expert difficulty, average, +1 | 23% | 23% | 43% |

The final battle is the hardest one: upgrades, supplying the optional third post (no wave) and reactions decide it,
and story difficulty carries novices. `tests/battle-balance.test.ts` asserts the beast and final-battle targets.

## Decisions

- **Defeat** stays campaign-ending (today's rules and renown); there is no retry.
- **Wilderness packs:** every pack fight is a battle.
- **Allies** act on their own, never targeted.
- **Saves:** battle-start checkpoints only; full mid-battle saves can follow, since battle state is already plain data.
- **Staging:** in place.
- **Real-time combat** is retired: the game maintains one combat system.

## Future work

- Human playtests to calibrate the timing profiles and the default latency.
- Hero `Parry`, `Counter` and stagger clips, and multi-blow enemy clips keyed to each move's impact ticks (battle poses
  scrub the existing `Windup`/`Strike`/`Recovery` clips today).
- Progression beyond damage and vitality: tonic capacity, and supplied posts restocking tonics from convoy cargo.
- A free-aim shot for the elf, reusing mouse-look and controller aiming, and timed attack inputs for bonus damage.
