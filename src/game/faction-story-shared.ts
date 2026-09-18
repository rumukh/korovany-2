import { NPCS, QUESTS, text, type StoryAction, type StoryNpc, type StoryQuest, type StoryStage } from './narrative-data';
import type { FactionId, LocalizedText } from './types';

export { text as t };

export function choice(
  id: string, label: LocalizedText, entry: LocalizedText, response: LocalizedText,
  options: Omit<StoryAction, 'id' | 'text' | 'entry' | 'response'> = {},
): StoryAction {
  return { id, text: label, entry, response, ...options };
}

export function talk(
  at: string, objective: LocalizedText, prompt: LocalizedText, actions: StoryAction[],
  variants?: StoryStage['variants'],
): StoryStage {
  return { kind: 'talk', at, objective, prompt, actions, ...(variants ? { variants } : {}) };
}

export function chapter(
  id: string, requires: string | null, title: LocalizedText, description: LocalizedText,
  unresolved: LocalizedText, stages: StoryStage[],
): StoryQuest {
  return { id, kind: 'main', requires, title, description, unresolved, reward: 40, stages };
}

// Physical evidence is shared; testimony and the authority to act on it are not.
export function evidence(faction: FactionId, actionId: string): StoryStage {
  const stage = QUESTS.flatMap(quest => quest.stages)
    .find(candidate => candidate.kind === 'inspect' && candidate.actions[0]?.id === actionId);
  if (!stage) throw new Error(`Missing shared story evidence: ${actionId}`);
  return {
    ...stage,
    actions: stage.actions.map(action => ({ ...action, id: `${faction}-${action.id}` })),
  };
}

export function localStories(faction: FactionId): StoryQuest[] {
  const quests = QUESTS.filter(quest => quest.kind === 'side');
  const localActions = new Set(quests.flatMap(quest => quest.stages.flatMap(stage => stage.actions.map(action => action.id))));
  const memories = localMemories(faction);
  return quests.map(quest => ({
    ...quest,
    id: `${faction}-${quest.id}`,
    requires: quest.requires ? `${faction}-${quest.requires}` : null,
    stages: quest.stages.map(stage => {
      const prompt = faction === 'villain' && stage.actions[0]?.id === 'beacon-amnesty'
        ? text(
          'I can stand surety and ask the independent witnesses for civilian service in place of punishment. You can decide service in your fort, not erase every claim outside it. Raut’s former men will have their names posted where his officers can read them. Or the Candlekeepers can bring oil quietly and keep the three hidden. The light gets tended either way; only one lets them ask to come down.',
          'Я могу поручиться и просить независимых свидетелей о гражданской службе вместо наказания. Ты решаешь о службе в своём форте, но не отменяешь все обвинения за его пределами. Имена бывших людей Раута вывесим там, где их прочтут его офицеры. Или Свечники тихо носят масло, а трое остаются скрыты. Огонь будет в обоих случаях; только в одном они смогут просить разрешения спуститься.')
        : stage.prompt;
      return {
        ...stage, prompt,
        actions: stage.actions.map(action => ({
          ...action, id: `${faction}-${action.id}`,
          ...(action.id === 'beacon-amnesty' ? {
            entry: text(
              'Lev publicly stood surety for the three keepers and petitioned for civilian service. Their names and Nika’s account are available to witnesses. A promise of safe escort has not erased the charges against them.',
              'Лев открыто поручился за троих смотрителей и просит оставить их на гражданской службе. Имена и показания Ники доступны свидетелям. Обещание безопасного сопровождения не сняло обвинений.'),
          } : {}),
          ...(action.requiresActions ? { requiresActions: action.requiresActions.map(id => `${faction}-${id}`) } : {}),
        })),
        variants: [
          ...(stage.variants?.filter(variant => localActions.has(variant.after))
            .map(variant => ({ ...variant, after: `${faction}-${variant.after}` })) ?? []),
          ...(memories[stage.actions[0]!.id] ?? []).map(memory => ({
            after: `${faction}-${memory.after}`,
            prompt: text(`${memory.introduction.en}\n\n${prompt.en}`, `${memory.introduction.ru}\n\n${prompt.ru}`),
          })),
        ],
      };
    }),
  }));
}

interface LocalMemory { after: string; introduction: LocalizedText }

function localMemories(faction: FactionId): Partial<Record<string, LocalMemory[]>> {
  const orchard: Record<FactionId, LocalMemory[]> = {
    elf: [
      { after: 'supply-villages', introduction: text('You chose to keep the resistance close to home. This is one of the homes that choice must mean something to; we still need both women’s agreement.', 'Ты решил держать сопротивление ближе к дому. Вот один из домов, для которого это решение должно что-то значить. Согласие обеих женщин всё равно необходимо.') },
      { after: 'supply-partisans', introduction: text('Our wider blockade does not give the council a claim on every orchard. Before marching farther, leave these two women an agreement they can live with.', 'Расширенная блокада не даёт сходу права на каждый сад. Прежде чем идти дальше, оставь этим двум женщинам соглашение, с которым можно жить.') },
    ],
    guard: [
      { after: 'order-relief', introduction: text('Vesk assigned you relief, not ownership of our orchard. You can carry an agreement between these women without making it a palace order.', 'Веск назначил тебе помощь, не владение нашим садом. Можешь передать соглашение между женщинами, не делая его дворцовым приказом.') },
      { after: 'order-pursuit', introduction: text('I hear Vesk is sending you beyond the palace post. Do not turn this orchard into another foothold on the way. Both women have rights your assignment does not cancel.', 'Слышу, Веск посылает тебя дальше дворцового поста. Не превращай по пути этот сад в очередной плацдарм. У обеих женщин есть права, которых назначение не отменяет.') },
    ],
    villain: [
      { after: 'claim-dominion', introduction: text('You declared a campaign of dominion. Here the agreement is still between two women, not between you and an unclaimed piece of land.', 'Ты объявил поход за властью. Здесь соглашение всё ещё между двумя женщинами, а не между тобой и бесхозной землёй.') },
      { after: 'claim-plunder', introduction: text('You mean to bring royal freight to your fort. This orchard is not another load to take home; hear what its two claimants actually offered.', 'Ты намерен вернуть королевский груз в свой форт. Этот сад — не ещё одна партия добычи. Выслушай, что действительно предложили обе спорящие.') },
    ],
  };
  return {
    'orchard-witness': orchard[faction],
    'stag-start': [
      { after: 'orchard-share', introduction: text('Lida says the orchard work is shared now, by agreement. Keep that distinction when people start asking who ought to ring our bell.', 'Лида говорит, теперь работают в саду вместе, по согласию. Сохрани это различие, когда начнут решать, кто должен звонить в наш колокол.') },
      { after: 'orchard-deed', introduction: text('Lida kept access to the graves while the buyer kept the deed. You separated two claims there. I need the same care before this missing bell becomes an excuse to punish children.', 'Лида сохранила доступ к могилам, покупательница — купчую. Ты разделил два права. Здесь нужна такая же осторожность, пока пропавший колокол не стал поводом наказать детей.') },
    ],
    'wreck-start': [
      { after: 'ferry-repay', introduction: text('Oss is working under Ivet’s eye while another hand learns the ferry. I heard you did not call useful work an acquittal. Remember that when people ask what my crew did.', 'Осс работает под присмотром Иветы, пока сменщик учится паромному делу. Слышал, ты не назвал полезный труд оправданием. Помни это, когда спросят о моей команде.') },
      { after: 'ferry-trial', introduction: text('With Oss at a hearing, travelers are taking the long road. I know you are willing to stop useful work while claims are heard. Here, first establish which light the helmsman followed.', 'Пока Осс на разборе, путники едут длинной дорогой. Знаю, ради разбирательства ты готов остановить полезное дело. Здесь сперва установи, за каким огнём шёл рулевой.') },
    ],
    'beacon-start': [
      { after: 'ash-close', introduction: text('Tessa wrote that repairing the pit cost the workers their wages. Keeping people safe has a supply cost; I cannot pretend the beacon runs on gratitude either.', 'Тесса написала: ремонт отстойника стоил рабочим заработка. У безопасности есть цена снабжения. Не могу притвориться, будто и маяк держится на благодарности.') },
      { after: 'ash-channel-open', introduction: text('Tessa says the families moved their bedding before the spring channel opened. You checked where people would live before changing the water. Check who lives at our light before changing its supplies.', 'Тесса говорит, семьи вынесли постели до открытия родникового канала. Ты проверил, где люди будут жить, прежде чем менять воду. Проверь, кто живёт при нашем огне, прежде чем менять его снабжение.') },
    ],
  };
}

type NpcCopy = Pick<StoryNpc, 'greeting'> & Partial<Pick<StoryNpc,
  'name' | 'role' | 'locationId' | 'activity' | 'localQuestion' | 'local' | 'beliefQuestion' | 'belief' | 'reactions'>>;

export function residents(faction: FactionId, copy: Record<string, NpcCopy>): StoryNpc[] {
  return NPCS.map(npc => {
    const authored = copy[npc.id];
    if (!authored) throw new Error(`Missing ${faction} greeting for ${npc.id}`);
    return { ...npc, reactions: [], ...authored };
  });
}
