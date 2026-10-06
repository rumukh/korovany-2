# Turn-based battles with timed defence

Design proposal and headless prototype. **Nothing here is wired into the game yet:** the shipped campaign still
uses real-time combat (`../rules.ts`, `../monsters.ts`), and no runtime module imports this folder, so the production
bundle is unchanged. The prototype is plain, deterministic TypeScript with bots and tests
(`tests/battle-prototype.test.ts`, `tests/battle-bots.ts`).

The model is inspired by *Clair Obscur: Expedition 33*. The player chooses commands on their turn. On enemy turns,
the player reacts in real time: they **dodge** or **parry** each blow in its timing window, and parrying a whole
attack earns a counter.

## Why change the combat

A measurement of the real-time combat at `23bd6c0` (bots played 88 complete military campaigns through the public
`step()` input) found:

- **Very little fighting:** about 20–30 seconds per campaign, spread over 3–4 battles.
- **No way to lose:** no campaign was lost, even by a bot that never dodged or used an ability.
- **A dominant strategy:** circling a target while attacking beat the dodge mechanic.

World v3 has since added wilderness packs (wolves, ghouls and trolls). The problem was thin design rather than
real-time itself.

Turn-based battles fit this game because:

- its military fights are few, authored and tied to objectives;
- it is a narrative RPG at heart;
- its simulation already supports paused, deterministic transactions (`step({ narrative })`).

Timed defence keeps moment-to-moment skill for a **single hero**, which the Pillars of Eternity or Fallout model
would lack without a party. It also reuses what already exists: windup telegraphs and tell rings, the dodge input,
the authored `Windup`/`Strike`/`Recovery` troop and monster clips, and controller menu navigation.

## Design pillars

1. **Every blow is readable and answerable.** Tests enforce it: blows are spaced beyond the reaction lockout, the
   first blow leaves a full attempt window, and every move settles before it ends.
2. **Reactions are the core skill; commands are the strategy.** On standard difficulty a player who never reacts
   loses; a perfect player takes no damage.
3. **Faction identity carries over:** elven range and evasion, the guard's parries and protection, the mountain
   ruler's aggression.
4. **Few, short battles.** A post garrison fight takes about 1–2.5 minutes, with no grinding.
5. **Accessible.** Story difficulty is winnable without reactions, latency can be calibrated, and keyboard, mouse
   and controller have parity.
6. **Deterministic and measured.** Bots re-measure balance on every change, and the targets are tests.

## Rules (prototype)

All durations are 60 Hz ticks (`content.ts`).

### Turns, timeline and AP

- **Timeline:** combatants act on a conditional timeline. Each turn adds `100 / speed` to an actor's next time, so
  faster actors act more often. `snapshot.order` previews the next seven actors.
- **Hero's turn:** the battle waits for a command and **no time passes**. Commands are Attack, faction skills and a
  tonic (two per battle, each restoring a flat 50 HP).
- **AP:** a basic attack costs 0 AP and grants +1. Skills cost 1–3 AP. A successful parry grants +1. The maximum is
  6 and battles start with 2.
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
- **Dodge:** the wider window. It avoids the blow and nothing more.
- **Parry:** the tighter window. It avoids the blow, grants +1 AP and adds +1 to the attacker's break meter.
- **Counter:** parrying every blow of a move triggers an immediate counter. A melee hero cannot counter a far archer.
- **Heavy blows** (marked; the presenter must show a distinct cue) can only be dodged.
- **Latency calibration:** 0–12 ticks are subtracted from every press to absorb input and display delay.

| Early ticks before impact (late: dodge 3, parry 2) | Story | Standard | Expert |
| --- | --- | --- | --- |
| Dodge (elf: ×1.5) | 18 (elf 27) | 10 (elf 15) | 7 (elf 11) |
| Parry (guard: ×1.4) | 9 (guard 13) | 5 (guard 7) | 4 (guard 5) |

On standard difficulty that makes the parry window 133 ms wide and the dodge window 233 ms. Story difficulty also
scales enemy damage to 50%, and expert to 125%.

### Break

Hero hits, parries and counters fill an enemy's break meter. A broken enemy **loses its next turn** and takes 25%
extra damage until then. The meter does not fill while the enemy is broken.

### Heroes

| Hero | HP | Speed | Damage | Defence identity | Skills |
| --- | --- | --- | --- | --- | --- |
| Elf | 120 | 115 | 24, ranged | Dodge window ×1.5 | **Aimed shot** (2 AP): 220%, +2 break. **Volley** (3): 90% to all. **Fall back** (2): every close enemy becomes far, then a shot. |
| Guard | 180 | 90 | 32, melee | Takes 90% damage; parry window ×1.4; counters deal 150% | **Shield bash** (2): +3 break. **Bulwark** (3): takes 35% damage until the guard's next turn, heals 25. |
| Mountain ruler | 150 | 100 | 34, melee | 10% lifesteal; the first blow taken from each enemy move grants +1 AP (rage) | **Cleave** (3): 110% to every close enemy. **War cry** (1): pulls every enemy close; the next attack deals 125%. |

### Enemies (the post garrison)

| Enemy | HP | Speed | Break | Moves (blow impact tick: damage; H = heavy) |
| --- | --- | --- | --- | --- |
| Soldier | 130 | 95 | 4 | Cut (38: 14); double cut (34: 10, 58: 10) |
| Archer | 90 | 100 | 3 | Loose (46: 12); pinning shot (64: 18 H); steps back when caught close (60%) |
| Captain | 200 | 85 | 6 | Hammer combo (32: 9, 52: 9, 86: 14, with a delayed third blow); overhead (56: 22 H); rally (30%): the next two attacks of every living defender deal 125% |

**Openings:** a battle can open neutral, with a first strike (the hero acts first) or ambushed (the enemies act
first and their melee troops start close).

## Prototype API

```ts
import { createBattle } from './index';
const battle = createBattle({ seed, faction, encounter: 'post-garrison', difficulty, opening, latencyTicks });
battle.command({ type: 'attack', target: 'soldier' }); // hero turn only; refused commands set snapshot.notice
battle.tick({ parry: true });                          // one tick of the current action; one-shot pulses
battle.snapshot();                                     // phase, timeline, AP, bands, blows with impact ticks, log
```

- **Malformed input throws:** setups, commands and inputs are checked before anything changes.
- **Unavailable commands** (`phase`, `target`, `ap`, `unavailable`, `item`) change nothing except `notice`.
- **Determinism:** state is plain data, and enemy decisions use a seeded Aegis PRNG. The same setup and the same
  inputs on the same ticks always produce the same battle.
- **Victory and defeat** freeze the battle.

## Measured balance

This is the post garrison battle, measured over 60 seeds per row with the neutral opening. The command policy is
deliberately simple and shared across reaction profiles, so the only variable is reaction skill. The human
profiles are **assumptions**, not player data:

| Profile | Timing error (σ) | Missed blows | Parry attempts |
| --- | --- | --- | --- |
| Novice | 150 ms | 15% | 35% |
| Average | 100 ms | 7% | 60% |
| Expert | 58 ms | 2% | 85% |

Each profile tries to press 1 tick early. Playtests must calibrate these numbers.

| Standard difficulty | Elf | Guard | Mountain ruler |
| --- | --- | --- | --- |
| No reactions | 0% | 0% | 0% |
| Masher (dodge every tick) | 0% | 0% | 0% |
| Novice | 88% | 77% | 73% |
| Average | 100%, 51% HP left | 100%, 55% HP left | 100%, 60% HP left |
| Expert | 100% | 100% | 100% |
| Perfect | 100%, no damage | 100%, no damage | 100%, no damage |
| Estimated minutes, average (5 s per command) | 2.2 | 2.3 | 1.4 |

- **Story difficulty:** no reactions wins 100% for every hero; a novice also wins 100%.
- **Expert difficulty:** average players win 85% / 87% / 85% (elf / guard / ruler); experts win 98% / 100% / 100%.
- **Openings:** averaged across heroes, a novice wins 79% neutral, 88% after a first strike and 62% when ambushed.
  The ruler alone barely minds ambushes, because it wants enemies close.

These targets are asserted by `tests/battle-prototype.test.ts`. To print the table:

```powershell
$env:KOROVANY_BATTLE_REPORT = '1'; npx vitest run tests/battle-prototype.test.ts
```

## Integration plan

| Area | Plan |
| --- | --- |
| Trigger | The existing engagement rules start a battle: troops target the hero, or a monster pack hunts. Participants are all hostiles of that site or lair, plus hostiles within about 20 m. Friendly troops, the convoy and the shipment within their current ranges join as allies or objectives. |
| World | While a battle is active the campaign schedule does not tick, as with an open conversation: convoy movement, escort, projectiles, the monster spawner and timers all pause. The battle runs on its own tick counter. Afterwards, defeated enemies go through today's kill bookkeeping (coins, health drops, kills, raid and post state), and the hero keeps their HP. |
| Contract | `GameInput.battle` is exclusive, like `narrative`: either a command or reaction pulses. `GameSnapshot.battle` mirrors `BattleSnapshot`, and `KorovanyBattle` becomes an Aegis resource. Update `CONTRACT.md`. |
| Saves | Autosave when a battle starts, and keep no mid-battle state at first: reloading during a battle restores that save and replays the same seeded battle. This keeps the strict validator (exact resource set, bounded timers) small. Full mid-battle saves can follow, since battle state is already plain data. |
| Presenter | Battle framing in place, with the camera on the hero and enemies placed by band (close about 2.5 m, far about 10 m) on walkable ground. Single-blow moves reuse `Windup`/`Strike`/`Recovery`. Multi-blow moves need clips whose contact frames land on their impact ticks; extend `troop-models.test.ts` the way it already checks windup and recovery durations. The hero needs `Parry`, `Counter`, a stagger and skill clips. Also needed: an optional approach ring (the tell ring closing at impact), a distinct heavy-blow cue that is not colour-only, Parried/Dodged/Hit feedback, the timeline, AP and the command menu. |
| Input | Proposed bindings: Dodge on Q, right mouse or B; Parry on E, left mouse or RB. In battle there is no hold-E interaction and no RB convoy command, so these do not conflict with exploration. Menus reuse dialogue-style keys 1–9, the mouse and controller navigation. Escape pauses. |
| Audio | A per-move windup cue and per-blow impact cues timed to ticks, a parry clang, a dodge whoosh and a break sound. The combat track already exists. |
| Text | RU/EN labels for commands, skills, notices and the combat log. |
| Tests and CI | Replace `CampaignDriver.fight()` with a battle bot so campaign acceptance keeps covering every faction. Add a browser battle suite and assign it once in the `Game` workflow matrix (`tests/ci-selection.test.ts`). |

## Content beyond the prototype

- **Military battles:**
  - Shipment escort: the wagon is a protectable participant that enemies may target; the guard's Bulwark grows an
    Interpose that redirects those blows so the guard can parry them.
  - Palace gate defence: waves of attackers.
  - Raut's redoubt and the Royal Citadel's Palace Marshal: multi-phase bosses with feints and delayed blows. Their
    second-phase reinforcements still arrive unless all three posts are supplied, keeping today's logistics link.
- **v3 monsters:**
  - Wolves: fast, fragile, short windups, attacking in quick sequence.
  - Ghouls: claw strings with a delayed swipe.
  - Trolls: solo, with slow heavy slams, so dodging is the answer, and a large break meter.
  - Packs respawn, so wilderness battles must stay under about a minute. Striking a beast in the field before it
    notices gives a first strike; being hit first means an ambush. An optional rule could resolve trivial packs
    without a battle.
- **Allies:** the home watch, the ruler's army and convoy weapons act as AI combatants or as support actions at the
  start of a round. Enemies can target them.
- **Progression:** replace the cosmetic level. Meta-upgrades map to damage, HP and tonic capacity (logistics), and
  supplied posts can restock tonics from convoy cargo.
- **Later options:**
  - A free-aim shot for the elf, reusing the new mouse-look and controller aiming.
  - Timed attack inputs for bonus damage.

## Roadmap and exit criteria

1. **Prototype (this folder).** Rules, one encounter, bots and targets. *Exit:* targets pass for all three heroes.
2. **Headless campaign integration.**
   - Trigger, world suspension, allies and objectives, monsters, battle-start checkpoints and kill bookkeeping.
   - Campaign acceptance plays every faction through battles.
   - *Exit:* every military path and every v3 species resolves through battles; saves before and after battles
     round-trip.
3. **Browser vertical slice for one battle.**
   - Camera, HUD, clips with keyed impacts, cues, RU/EN text, keyboard, mouse and controller.
   - *Exit:* human playtests confirm the timing feel; calibrate the human model and latency defaults from them.
4. **Content.** Every encounter, both bosses, all three monsters and progression. *Exit:* balance targets per
   encounter, plus boss targets (harder than a garrison).
5. **Release.** Retire the real-time combat paths, update the README, `CONTRACT.md`, the test bots and the CI
   matrix, and deliver through the `Game` workflow.

## Open decisions

- **Defeat:** keep it campaign-ending (today's rules and renown), or offer a retry from the battle's start (perhaps
  on story and standard only)?
- **Wilderness packs:** should every pack fight be a battle, or should trivial packs resolve in the field?
- **Allies:** AI only, or commandable on their own turns?
- **Final bindings:** the parry button for keyboard, mouse and controller.
- **Saves:** battle-start checkpoints only, or full mid-battle saves?
- **Staging:** in place (recommended), or a separate battle arena?
- **Real-time combat:** keep it as an option? Recommended: no; maintain one combat system.
