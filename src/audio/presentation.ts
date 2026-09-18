import type { GameSnapshot, LocalizedText } from "../game";
import type { Language } from "../ui/storage";
import type { Overlay } from "../ui/shell";
import { translate } from "../ui/locale";
import type { SpeechLine } from "./speech";

export interface SpeechOutput {
  speak(key: string, lines: readonly SpeechLine[]): void;
  cancelSpeech(): void;
  setSpeechActive(active: boolean): void;
}

export interface SpeechSelection { player?: LocalizedText; restart?: boolean }

export class SpeechPresentation {
  private sceneKey = "";
  private revision = 0;
  private focused = true;
  private audible = false;
  private lines: { speaker: string; text: LocalizedText; name?: LocalizedText }[] = [];

  constructor(private readonly sound: SpeechOutput) {}

  reset(): void {
    this.sceneKey = "";
    this.lines = [];
    this.sound.cancelSpeech();
  }

  setFocused(focused: boolean): void {
    this.focused = focused;
    this.sound.setSpeechActive(focused && this.audible);
  }

  sync(snapshot: GameSnapshot | null, overlay: Overlay, atTitle: boolean, language: Language, selection?: SpeechSelection): void {
    const story = !atTitle && (overlay === "dialogue" || overlay === "inspection");
    const terminal = !atTitle && overlay === "terminal";
    const paused = !atTitle && overlay !== null && !story && !terminal;
    this.audible = story || terminal;
    this.sound.setSpeechActive(this.focused && this.audible);
    if (paused) return;
    const dialogue = story ? snapshot?.narrative?.dialogue : null;
    const inspection = story ? snapshot?.narrative?.inspection : null;
    const ending = terminal ? snapshot?.narrative?.ending : null;
    const key = JSON.stringify([snapshot?.runId, snapshot?.faction,
      dialogue ? ["dialogue", dialogue.npcId, dialogue.text] :
        inspection ? ["inspection", inspection.locationId, inspection.text] :
          ending ? ["ending", ending] : atTitle ? "title" : selection?.player ? ["choice", selection.player] : "game"]);
    if (selection?.restart || selection?.player || this.sceneKey !== key) {
      this.sceneKey = key;
      this.revision++;
      this.lines = [];
      if (selection?.player) this.lines.push({ speaker: "player", text: selection.player });
      if (dialogue) this.lines.push({ speaker: dialogue.npcId, text: dialogue.text, name: dialogue.name });
      else if (inspection) this.lines.push({ speaker: "narrator", text: inspection.text });
      else if (ending) this.lines.push({ speaker: "narrator", text: ending });
    }
    // A selected "leave" reply is still audible while movement resumes.
    this.audible ||= this.lines.length > 0 && !atTitle;
    this.sound.speak(`${snapshot?.runId ?? "title"}:${this.revision}:${language}`, this.lines.map(line => ({
      speaker: line.speaker, language, text: line.text[language],
      label: line.name?.[language] ?? translate(language, `audio.${line.speaker}`),
    })));
    this.sound.setSpeechActive(this.focused && this.audible);
  }
}
