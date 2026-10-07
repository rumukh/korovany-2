import { describe, expect, it } from "vitest";
import {
  ALLY_KITS, ENEMY_KITS, HERO_KITS, MOVE_TICKS, reactionWindow, TIMING,
  type BattleDifficulty, type BattleLogKind, type BattleNotice, type BattleOpening,
} from "../src/game/battle";
import { APPROACH_TICKS, CUE_RING, reactionBand, ringRadius } from "../src/ui/battle-hud";
import { translate } from "../src/ui/locale";

const FACTIONS = ["elf", "guard", "villain"] as const;
const DIFFICULTIES: BattleDifficulty[] = ["story", "standard", "expert"];

describe("battle HUD", () => {
  it("has Russian and English text for everything a battle can show", () => {
    const moves = new Set<string>(["attack", "counter", ...Object.keys(MOVE_TICKS)]);
    for (const kit of Object.values(ENEMY_KITS)) for (const move of kit.moves) moves.add(move.id);
    for (const kit of Object.values(ALLY_KITS)) moves.add(kit.move);
    const commands = new Set<string>(["attack", "tonic", "protect"]);
    for (const kit of Object.values(HERO_KITS)) for (const skill of kit.skills) commands.add(skill.id);
    const logs: BattleLogKind[] = ["damage", "heal", "dodge", "parry", "counter", "break", "recover", "defeated", "approach", "retreat",
      "rally", "item", "protect", "support", "join", "ward-down", "victory", "defeat"];
    const notices: BattleNotice[] = ["phase", "target", "ap", "unavailable", "item"];
    const openings: BattleOpening[] = ["neutral", "first-strike", "ambushed"];
    const keys = [
      ...[...moves].filter((move) => !commands.has(move) || move === "attack").map((move) => `battle.move.${move}`),
      ...[...commands].flatMap((command) => [`battle.command.${command}`, `battle.about.${command}`]),
      ...logs.map((kind) => `battle.log.${kind}`), "battle.log.damage.hero", "battle.log.damage.taken", "battle.log.heal.hero",
      ...notices.map((notice) => `battle.notice.${notice}`), ...openings.map((opening) => `battle.opening.${opening}`),
      ...["roundLabel", "now", "order", "enemies", "allies", "wards", "ap", "apLong", "tonics", "close", "far", "broken", "broken.help",
        "rallied", "guarding", "bulwark", "empowered", "break", "guard", "guard.help", "attacking", "defeated", "yourTurn", "enemyTurn",
        "allyTurn", "heroAction", "chooseTarget", "back", "cost", "blows", "heavyShort", "noBlow", "commands.keyboard", "targets.keyboard",
        "commands.controller", "wrecked", "cue.parry", "cue.dodge", "cue.parry.keyboard", "cue.dodge.keyboard", "cue.parry.controller",
        "cue.dodgeOnly", "cue.now", "defend.how", "defend.parry", "defend.dodge", "defend.heavy", "defend.ward", "fb.parried", "fb.dodged",
        "fb.hit", "fb.ap", "fb.early", "fb.late", "fb.heavy", "fb.lockout", "fb.none.keyboard", "fb.none.controller",
        "fb.counter", "fb.break", "fb.wrecked", "fb.join", "fb.wardHelp", "title"].map((key) => `battle.${key}`),
      ...FACTIONS.map((faction) => `faction.${faction}`), "battleHints",
    ];
    for (const language of ["en", "ru"] as const) {
      for (const key of keys) {
        const text = translate(language, key);
        expect(text, `${language} ${key}`).not.toBe(key);
        expect(text.length, `${language} ${key}`).toBeGreaterThan(0);
      }
      // Moves without their own name (skills) fall back to the command's name.
      for (const command of commands) expect(translate(language, `battle.command.${command}`)).not.toMatch(/^battle\./);
      expect(translate(language, "battle.cue.dodge.controller")).toBe("");
    }
    // The hero's own lines are grammatical: "You hit", not "You hits".
    expect(translate("en", "battle.log.damage.hero").replace("{t}", "Soldier").replace("{n}", "5")).toBe("You hit Soldier for 5");
    expect(translate("en", "battle.log.heal.hero").replace("{n}", "3")).toBe("You recover 3 health");
  });

  it("closes each approach ring on the target circle at impact, through visible success bands", () => {
    expect(ringRadius(APPROACH_TICKS)).toBeCloseTo(CUE_RING.start);
    expect(ringRadius(APPROACH_TICKS + 30)).toBeCloseTo(CUE_RING.start);
    expect(ringRadius(0)).toBeCloseTo(CUE_RING.target);
    for (let remaining = APPROACH_TICKS; remaining > -4; remaining--) expect(ringRadius(remaining - 1)).toBeLessThan(ringRadius(remaining));
    // The ring appears before a press can bind to its blow, so the whole attempt window is seen coming.
    expect(APPROACH_TICKS).toBeGreaterThan(TIMING.attempt);
    for (const faction of FACTIONS) {
      for (const difficulty of DIFFICULTIES) {
        const parry = reactionBand(reactionWindow(faction, difficulty, "parry"));
        const dodge = reactionBand(reactionWindow(faction, difficulty, "dodge"));
        for (const band of [parry, dodge]) {
          expect(band.inner).toBeLessThan(CUE_RING.target);
          expect(band.outer).toBeGreaterThan(CUE_RING.target);
          // At least 8 of the cue's 200 units wide: 8 px or more on the smallest cue (210 px).
          expect(band.outer - band.inner, `${faction} ${difficulty}`).toBeGreaterThanOrEqual(8);
        }
        // The gold parry band lies within the wider blue dodge band.
        expect(parry.outer).toBeLessThanOrEqual(dodge.outer);
        expect(parry.inner).toBeGreaterThanOrEqual(dodge.inner);
        expect(dodge.outer).toBeLessThan(CUE_RING.start);
      }
    }
  });
});
