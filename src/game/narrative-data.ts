import type { FactionId, LocalizedText } from './types';

export const text = (en: string, ru: string): LocalizedText => ({ en, ru });
export const STORY_TITLE = text('The Hollow Road', 'Глухой тракт');

export type CivicFaction = 'commons' | 'registry' | 'lanterns';
export type EndingId = 'commons' | 'compact' | 'cinder';

export interface StoryAction {
  id: string;
  text: LocalizedText;
  entry: LocalizedText;
  response: LocalizedText;
  reputation?: Partial<Record<CivicFaction, number>>;
  ending?: EndingId;
  gate?: 'conquest';
  requiresActions?: string[];
}

export interface StoryStage {
  kind: 'talk' | 'inspect';
  at: string;
  objective: LocalizedText;
  prompt: LocalizedText;
  actions: StoryAction[];
  variants?: { after: string; prompt: LocalizedText }[];
}

export interface StoryQuest {
  id: string;
  kind: 'main' | 'side';
  title: LocalizedText;
  description: LocalizedText;
  unresolved: LocalizedText;
  requires: string | null;
  reward: number;
  stages: StoryStage[];
}

export interface StoryNpc {
  id: string;
  locationId: string;
  name: LocalizedText;
  role: LocalizedText;
  faction: FactionId;
  activity: LocalizedText;
  greeting: LocalizedText;
  localQuestion: LocalizedText;
  local: LocalizedText;
  beliefQuestion: LocalizedText;
  belief: LocalizedText;
  reactions?: { after: string; text: LocalizedText }[];
}

const action = (
  id: string, en: string, ru: string, entryEn: string, entryRu: string,
  responseEn: string, responseRu: string, reputation?: StoryAction['reputation'],
): StoryAction => ({
  id, text: text(en, ru), entry: text(entryEn, entryRu), response: text(responseEn, responseRu),
  ...(reputation ? { reputation } : {}),
});

const talk = (
  at: string, en: string, ru: string, promptEn: string, promptRu: string,
  actions: StoryAction[], variants?: StoryStage['variants'],
): StoryStage => ({
  kind: 'talk', at, objective: text(en, ru), prompt: text(promptEn, promptRu), actions,
  ...(variants ? { variants } : {}),
});

const inspect = (
  at: string, id: string, en: string, ru: string, evidenceEn: string, evidenceRu: string,
): StoryStage => ({
  kind: 'inspect', at, objective: text(en, ru), prompt: text(evidenceEn, evidenceRu),
  actions: [action(id, 'Examine the traces.', 'Осмотреть следы.',
    evidenceEn, evidenceRu, evidenceEn, evidenceRu)],
});

const remembered = (after: string, en: string, ru: string) => ({ after, prompt: text(en, ru) });

export const CIVIC_FACTIONS: { id: CivicFaction; name: LocalizedText }[] = [
  { id: 'commons', name: text('Border Villages', 'Приграничные общины') },
  { id: 'registry', name: text('Crown Garrison', 'Коронный гарнизон') },
  { id: 'lanterns', name: text('Candlekeepers', 'Свечники') },
];

export const ENDINGS: Record<EndingId, LocalizedText> = {
  commons: text('Three Bells', 'Три колокола'),
  compact: text('The Cloister’s Prisoner', 'Узник скита'),
  cinder: text('Broken Glass', 'Разбитое стекло'),
};

export const ENDING_EPILOGUES: Record<EndingId, LocalizedText> = {
  commons: text(
    'Raut is dead. The supplied posts hold the route while the convoy carries Radek’s three bells to the waiting watches. Elin loosens the old binding only after each bell answers the next. The dead leave the glass; no living keeper takes their place. Yara’s volunteers mend ropes, dry salt and find replacements for exhausted neighbors. One village misses a watch during harvest, and carts wait two days rather than risk the silence. Mara sends the lost drivers’ wages to their families and hires another convoy. There is a road again, but keeping it open is work no victory can finish.',
    'Раут мёртв. Снабжённые заставы держат путь, пока обоз везёт три колокола Радека к дежурным. Элин снимает старую привязь, лишь когда звон проходит от одного колокола к другому. Мёртвые покидают стекло; живого пленника вместо них не будет. Добровольцы Яры чинят верёвки, сушат соль, подменяют измотанных соседей. Во время жатвы одна деревня пропускает дежурство. Обозы ждут два дня: в тишину никто не едет. Мара отправляет жалованье погибших возчиков семьям и нанимает новый обоз. Тракт снова открыт, но содержать его придётся и после победы.'),
  compact: text(
    'Raut is dead. The convoy brings salt and provisions to the Old Cloister. Elin takes the binding of his own will, releasing the dead one by one from the glass. He can walk as far as the worn stone at the gate, no farther. Grain wagons pass beneath the renewed wards. Visitors bring him news, then requests, then disputes about whose cargo should go first. For now he refuses to sell passage. Mara sends the lost drivers’ wages home. She leaves a spare key with a Candlekeeper: the person who brings Elin bread must never become the only person allowed through his door.',
    'Раут мёртв. Обоз доставляет соль и припасы в Старый скит. Элин по своей воле принимает привязь и одного за другим освобождает мёртвых из стекла. Он может дойти до стёртого камня у ворот. Дальше — нет. Под обновлённой защитой идут телеги с зерном. Посетители приносят новости, потом просьбы, потом споры о том, чей груз пропускать первым. Пока Элин не берёт платы за проход. Мара отправляет жалованье погибших возчиков домой. Запасной ключ она оставляет одному из Свечников: тот, кто приносит Элину хлеб, не должен решать, кого к нему пускать.'),
  cinder: text(
    'Raut is dead. Behind the secured posts, Elin opens the binding and the convoy crews break the ward-glass. The last captive voices leave the Old Cloister. The Caller has no borrowed chorus there now; neither does the road have its old shelter. Drivers travel by daylight, pay more guards and turn back in bad weather. A winter delivery is lost to snow, another to men with crossbows. Two distant hamlets are abandoned before spring. Mara sends the lost drivers’ wages home and hangs a glass shard over the inn hearth, out of reach. Her next contract includes money for the drivers’ families.',
    'Раут мёртв. За прикрытием взятых застав Элин размыкает привязь, а обозники разбивают обережное стекло. Последние пленные голоса покидают Старый скит. Оклику больше не у кого заимствовать здесь хор; у тракта больше нет прежней защиты. Возчики ездят засветло, нанимают лишнюю охрану, пережидают непогоду. Один зимний груз губит снег, другой отбирают люди с арбалетами. До весны жители двух дальних хуторов уходят из своих домов. Мара отправляет жалованье погибших возчиков домой и вешает осколок над очагом, где не достать. В новом договоре предусмотрены деньги семьям возчиков.'),
};

export const QUESTS: StoryQuest[] = [
  {
    id: 'missing-names', kind: 'main', requires: null, reward: 30,
    title: text('I. The Empty Seats', 'I. Пустые облучки'),
    description: text(
      'Mara’s convoy has returned to the Roadward Inn without its drivers. The grain is untouched. Your first job as her hired captain is to find out where the men left the road.',
      'Обоз Мары вернулся на Трактовый двор без возчиков. Зерно цело. Первое дело нанятого ею капитана — узнать, где люди сошли с дороги.'),
    unresolved: text(
      'Mara keeps the drivers’ wages in separate purses. No one has brought her enough evidence to send them to the families.',
      'Мара хранит жалованье возчиков в отдельных кошелях. Оснований отдать деньги семьям у неё пока нет.'),
    stages: [
      talk('mara', 'Ask Mara about the returned convoy.', 'Расспросить Мару о вернувшемся обозе.',
        'Three carts. All the horses, every sack. Not one driver. Ren found black glass beneath the grain; I paid to carry barley, not that. Toman saw them pass Greenhollow. Find him. And if someone calls from the trees, look before you answer.',
        'Три телеги. Все лошади, все мешки. Ни одного возчика. Рен нашёл под зерном чёрное стекло. Я брала подряд на ячмень, не на это. Томан видел обоз у Зелёной лощины. Найди его. И если из леса позовут — сперва погляди, кто зовёт.',
        [action('names-start', 'I’ll find Toman. Leave the glass wrapped until I return.',
          'Я найду Томана. Стекло пока не разворачивай.',
          'Mara gave me the drivers’ descriptions and pay-token numbers. Her grain hid unlisted black panels; Toman is the last known witness to the men.',
          'Мара дала приметы возчиков и номера их расчётных жетонов. Под зерном лежали неуказанные чёрные пластины. Последним людей видел Томан.',
          'Ren has put it in the empty stall. Nobody sleeps beside it. Bring me what you find, not a tavern story.',
          'Рен сложил его в пустом стойле. Спать там я никому не велела. Принеси мне хоть что-то надёжнее трактирных слухов.')]),
      talk('toman', 'Find Toman in Greenhollow.', 'Найти Томана в Зелёной лощине.',
        'The lead driver stopped by the orchard. Said his wife was calling him in for supper. I knew her. Buried her last winter. He answered, climbed down, and the other two followed him between the trees. I rang our handbell. The horses came back. The men didn’t.',
        'Передний возчик остановился у сада. Сказал: жена к ужину зовёт. Я её знал. Прошлой зимой хоронили. Он ответил, слез, остальные двое пошли за ним между деревьями. Я ударил в ручной колокол. Лошади вернулись. Люди — нет.',
        [action('names-witness', 'Show me where he left the cart. I’ll follow the tracks, not the voice.',
          'Покажи, где он слез. Я пойду по следам, не на голос.',
          'Toman heard a dead woman’s voice. A driver answered it before leaving the road. This is an account, not yet proof of what took them.',
          'Томан слышал голос умершей. Возчик ответил и только потом ушёл с дороги. Пока это свидетельство, а не доказательство того, что с ними случилось.',
          'Past the leaning apple tree. I stopped where our salt ran out. You won’t get me to pretend I went farther.',
          'За кривой яблоней. Я дошёл до конца соляной полосы. Дальше не пошёл и врать об этом не стану.')]),
      inspect('old-orchard', 'names-stones',
        'Examine the cart tracks at the Old Orchard.', 'Осмотреть следы обоза в Старом саду.',
        'Three sets of bootprints leave the wheel ruts. None returns. A torn salt pouch hangs from the lead cart’s broken rail; rain has washed a gap through the spilled line. Under a sackcloth scrap lies black glass wrapped in linen stitched for a burial shroud. A brass shipping tag bears the mark of Reed Chapel. There is no blood or sign of a struggle.',
        'Три цепочки следов уходят из колеи. Обратных нет. На обломке борта висит порванный мешочек с солью; дождь промыл разрыв в просыпанной полосе. Под клочком мешковины — чёрное стекло, завёрнутое в полотно с погребальным швом. На латунной бирке знак Камышовой часовни. Ни крови, ни следов борьбы.'),
      talk('toman', 'Tell Toman what the tracks show.', 'Обсудить находку с Томаном.',
        'So they walked away. Don’t tell their wives that means they’re dead. We call the voice the Caller. Salt without gaps and a bell with someone at the rope keep it off. Answer it, and you start wanting to follow. I can warn the road openly, or move the nearest households inside our boundary first. Moving quietly will take all night.',
        'Значит, ушли своими ногами. Только жёнам не говори, будто это значит — погибли. Голос мы зовём Окликом. Целая полоса соли и колокол, у которого дежурят, не дают ему подступить. Ответишь — самому захочется идти за ним. Могу сразу предупредить весь тракт. А могу сперва тихо собрать ближние семьи за нашей полосой. На это уйдёт ночь.',
        [
          action('names-public', 'Warn everyone now. Tell them exactly what you saw; I’ll stand beside you.',
            'Предупреди всех сейчас. Расскажи, что видел. Я буду рядом.',
            'I backed Toman’s warning in front of the carters. Greenhollow began checking its salt and bell rope; word of the chapel wrapping will also reach the soldiers.',
            'При возчиках я подтвердил рассказ Томана. В Зелёной лощине проверяют соль и колокольную верёвку. Весть об обёртке из часовни дойдёт и до солдат.',
            'The warning is up. Two drivers have refused to leave, which is better than losing two more. Sella at Mirecross handles the chapel’s river freight. Take her that tag.',
            'Предупреждение вывесили. Двое возчиков отказались ехать. Лучше так, чем ещё двоих недосчитаться. Селла в Болотном броде разбирает речные грузы часовни. Покажи ей бирку.',
            { commons: 2, registry: -1, lanterns: 1 }),
          action('names-shelter', 'Bring the families in first. Ask the Candlekeepers to pass the warning house to house.',
            'Сперва собери семьи. Пусть Свечники предупредят каждый дом.',
            'I helped Toman arrange shelter inside the tended boundary. The warning travels by trusted visitors tonight; travelers farther down the road may not hear it in time.',
            'Я помог Томану устроить семьи внутри охраняемой полосы. Сегодня предупреждение передают из дома в дом; до дальних путников оно может не дойти вовремя.',
            'There are people sleeping under the mill stairs now. We’ll manage. Sella at Mirecross knows the chapel freight. Go while the Candlekeepers make their rounds.',
            'Теперь у нас и под мельничной лестницей спят. Ничего, потеснимся. Селла в Болотном броде знает грузы часовни. Ступай к ней, пока Свечники обходят дома.',
            { lanterns: 2, commons: 1, registry: 1 }),
        ]),
    ],
  },
  {
    id: 'river-record', kind: 'main', requires: 'missing-names', reward: 35,
    title: text('II. What Was Taken from the Dead', 'II. Что забрали у мёртвых'),
    description: text(
      'The wrapping on the glass came from Reed Chapel. Follow its freight through the Fens and find out why burial supplies travel beneath grain.',
      'Стекло было обёрнуто полотном из Камышовой часовни. Проследить путь груза через Топи и узнать, зачем погребальные припасы прячут под зерном.'),
    unresolved: text(
      'The chapel’s remaining shrouds stay under lock. No one has established where the missing bundles went.',
      'Оставшиеся саваны часовни заперты на ключ. Куда ушли пропавшие тюки, так и не выяснили.'),
    stages: [
      talk('sella', 'Show the shipping tag to Sella at Mirecross.', 'Показать Селле в Болотном броде грузовую бирку.',
        'Chapel tag. I hauled six matching crates out of the flood. They were stored in the Drowned Archive, where the upper shelves stay dry most years. One crate broke on the steps. Go look at what they packed beneath the shrouds. Mind the third step; it won’t bear you.',
        'Бирка часовни. Я вытащила из воды шесть ящиков с такими. Держали их в Затопленном архиве: верхние полки обычно сухие. Один разбился на ступенях. Глянь, что лежало под саванами. Только на третью ступень не наступай — не выдержит.',
        [action('river-start', 'I’ll check the broken crate. Keep its matching tags.',
          'Осмотрю разбитый ящик. Остальные бирки сохрани.',
          'Sella recovered chapel crates after the flood. One remains broken on the archive steps; its packing may link the glass to the burial stores.',
          'После разлива Селла подняла ящики часовни. Один разбился на лестнице архива. По упаковке можно проверить связь стекла с погребальными запасами.',
          'Tags are on the nail. I keep them until I’m paid. Sometimes after.',
          'Бирки на гвозде. Держу их, пока не заплатят. Иногда и потом.')],
        [
          remembered('names-public',
            'Your warning got here before you. Now every wet footprint belongs to a ghost. The chapel tag is real, though: I recovered six of those crates at the Drowned Archive. One broke on the steps. Inspect the packing, not the stories.',
            'Твоё предупреждение пришло раньше тебя. Теперь каждый мокрый след у нас оставляет мертвец. А бирка настоящая: в Затопленном архиве я подняла шесть таких ящиков. Один разбился на лестнице. Осмотри упаковку, слухи никуда не денутся.'),
          remembered('names-shelter',
            'A Candlekeeper came through at dawn. Said Greenhollow had people sleeping under the mill stairs. I’ve sent dry sacks. As for your tag: six matching crates came out of the Drowned Archive. One broke on the steps. The packing is still there.',
            'На рассвете заходил Свечник. Говорит, в Зелёной лощине люди спят под лестницей мельницы. Я отправила сухие мешки. А по твоей бирке — шесть таких ящиков подняли из Затопленного архива. Один разбился на лестнице. Упаковка ещё там.'),
        ]),
      inspect('drowned-archive', 'river-plates',
        'Examine the broken burial-supply crate.', 'Осмотреть разбитый ящик с погребальными припасами.',
        'The crate holds salt-caked shrouds, coffin nails with wood still on them, and sacks of pale bone ash. A black panel fits its padded lid. The outward tag names Reed Chapel; the return tag names a furnace shipment through Saltmarket. These were not unused burial supplies. Someone collected them from graves, packed them carefully and sent glass back in the same crates.',
        'В ящике саваны с соляной коркой, гробовые гвозди с остатками дерева и мешки светлого костяного пепла. В мягкую прокладку крышки точно ложится чёрная пластина. На бирке отправления — Камышовая часовня, на обратной — печной груз через Соляной торг. Припасы уже побывали в могилах. Их собрали, аккуратно упаковали, а назад в тех же ящиках отправили стекло.'),
      talk('ivet', 'Ask Ivet why the chapel shipped used burial materials.', 'Узнать у Иветы, почему часовня отправляла вещи из могил.',
        'Raut’s quartermasters called it emergency ward-making. They took our burial salt first, then opened old graves. I counted what they took. When the bell cord wore through, there was nothing left to trade for a new one. The next consignment waits outside. We can stop it here, or mark the crates and let Orsa follow them to the buyer.',
        'Интенданты Раута сказали: срочно делают защиту. Сперва забрали погребальную соль, потом вскрыли старые могилы. Я считала всё, что увозили. Когда перетёрлась колокольная верёвка, на новую уже нечего было выменять. Следующая партия ждёт снаружи. Можно оставить её здесь. Можно пометить ящики, а Орса проследит, кому они достанутся.',
        [
          action('river-open', 'Keep this consignment. Give me your tally; I’ll take it to Orsa.',
            'Оставь эту партию. Дай мне опись — отнесу Орсе.',
            'Ivet withheld the next consignment and gave me her tally. The chapel keeps its remaining salt and linen; the buyer will know the supply has been challenged.',
            'Ивета задержала следующую партию и отдала мне опись. Соль и полотно остались в часовне; покупатель узнает, что поставку остановили.',
            'The crates are back inside. There’s salt at the threshold again, and the graves will stay shut. Orsa can check my quantities against what reached Saltmarket.',
            'Ящики занесли обратно. На пороге снова есть соль, могилы больше не откроют. Орса сверит мою опись с тем, что дошло до Соляного торга.',
            { commons: 2, lanterns: 1, registry: -2 }),
          action('river-seal', 'Mark this last load. I’ll follow it; don’t promise them another.',
            'Пометь последний груз. Я пойду по следу. Нового им не обещай.',
            'Ivet marked the crates and copied their contents for me. We let one more shipment leave to identify its buyer; the chapel must stretch its scant burial stores until then.',
            'Ивета пометила ящики и переписала для меня содержимое. Ещё один груз уйдёт, чтобы мы нашли покупателя. Часовне пока придётся обходиться скудными остатками.',
            'There’s a cross burned beneath each handle. Orsa knows to look. I’ve kept enough salt for the door, but we’re cutting the last linen into strips.',
            'Под каждой ручкой выжжен крест. Орса знает, где искать. На порог соли я оставила, а последнее полотно уже режем на полосы.',
            { registry: 2, lanterns: -1, commons: -1 }),
        ]),
    ],
  },
  {
    id: 'winter-price', kind: 'main', requires: 'river-record', reward: 40,
    title: text('III. Black Freight', 'III. Чёрный груз'),
    description: text(
      'Burial freight passes through the Salt Coast to the furnaces of the Ash Steppe. Establish what the glass does, who orders it and who gets to travel under its protection.',
      'Погребальные грузы идут через Соляной берег к печам Пепельной степи. Узнать, как действует стекло, кто его заказывает и кого оно защищает.'),
    unresolved: text(
      'Orsa leaves a space in her freight accounts for the black panels. Until the furnace evidence is checked, the buyers can still call them ordinary cargo.',
      'Орса оставляет в грузовой книге незаполненные строки под чёрные пластины. Пока печи не обследованы, покупатели могут называть их обычным товаром.'),
    stages: [
      talk('orsa', 'Bring the chapel tally to Orsa at Saltmarket.', 'Передать опись часовни Орсе на Соляном торге.',
        'I can match the crates, but a mark doesn’t tell me what was inside. At the Tide Observatory they keep the weighing slings and unload damaged freight. Find the sling from the barley shipment. It carried twice the declared weight.',
        'Ящики я найду. Но клеймо ещё не говорит, что в них было. В Приливной башне хранят грузовые стропы и разбирают повреждённый товар. Найди стропу от партии ячменя. На ней подняли вдвое больше, чем заявили.',
        [action('winter-start', 'I’ll check the sling and the damaged freight.',
          'Проверю стропу и повреждённый груз.',
          'The chapel tally matches a freight run through Saltmarket. Orsa needs the unloading evidence before she will accuse its buyer.',
          'Опись часовни совпала с перевозкой через Соляной торг. Орсе нужны следы разгрузки, прежде чем она предъявит что-либо покупателю.',
          'Hana keeps the damaged pieces on the lower shelf. Don’t throw out the packing. It tells us which cargo traveled together.',
          'Хана складывает обломки на нижнюю полку. Упаковку не выбрасывай. По ней видно, что везли вместе.')],
        [
          remembered('river-open',
            'Ivet’s next shipment never arrived. Good for her threshold; bad for quietly tracing the buyer. We still have the last barley load’s damaged freight at the Tide Observatory. Its weighing sling carried twice the declared weight. Start there.',
            'Новая партия Иветы не пришла. Для её порога хорошо, для слежки за покупателем — хуже. В Приливной башне остался повреждённый груз от прошлой партии ячменя. Стропа выдержала вдвое больше заявленного веса. Начни с неё.'),
          remembered('river-seal',
            'I found Ivet’s burned crosses beneath the handles. The same carrier brought barley and took the marked crates back inland. His damaged freight and weighing sling are at the Tide Observatory. We can check him without tipping him off.',
            'Я нашла кресты Иветы под ручками. Тот же перевозчик привёз ячмень и увёз помеченные ящики вглубь страны. Повреждённый груз и стропа остались в Приливной башне. Можно проверить, не спугнув его.'),
        ]),
      inspect('tide-observatory', 'winter-tides',
        'Inspect the weighing sling and broken freight at the Tide Observatory.',
        'Осмотреть грузовую стропу и обломки в Приливной башне.',
        'Black glass chips are ground into the sling beside barley husks. A broken panel is grooved to fit a wagon’s covered frame, not a window. The maker’s stamp matches a delivery docket from Cinderwell; the buyer is Raut’s convoy office. The burial crates traveled back empty of glass and heavy with chapel freight. The loading weights confirm both journeys.',
        'В стропе рядом с ячменной шелухой застряла чёрная стеклянная крошка. Паз на разбитой пластине сделан под крытый воз, не под окно. Клеймо мастера совпадает с отметкой в отправке из Углеземья; покупатель — обозная служба Раута. Обратно те же ящики везли уже без стекла, с грузом часовни. Вес при погрузке подтверждает оба рейса.'),
      talk('beran', 'Ask Beran in Cinderwell about the wagon panels.', 'Расспросить Берана в Углеземье о пластинах для повозок.',
        'That’s my stamp. We call it ward-glass. Bone ash, burial salt, a little bronze from a bell. The first cooled pane spoke in my apprentice’s dead father’s voice. Not all the voices are the Caller. Some are stuck inside, holding it back. Raut’s men watched a test at the quarry. The test bed and rejects are still there.',
        'Моё клеймо. Мы зовём его обережным стеклом. Костяной пепел, погребальная соль, немного колокольной бронзы. Первая остывшая пластина заговорила голосом покойного отца моего подмастерья. Не каждый голос — Оклик. Некоторые заперты внутри и сдерживают его. Люди Раута смотрели испытание в карьере. Стенд и брак ещё там.',
        [action('winter-molds', 'I’ll examine the test bed. Keep the rejected pieces for comparison.',
          'Осмотрю стенд. Брак не выбрасывай — нужно сравнить.',
          'Beran identifies his glass and says it holds the dead as a ward against the Caller. Raut’s men observed the quarry test. I need more than the maker’s explanation.',
          'Беран признал своё стекло. По его словам, оно держит мёртвых и за их счёт защищает от Оклика. Испытание видели люди Раута. Объяснений мастера пока недостаточно.',
          'The cold furnace, nearest the loading bench. Handle a shard by its cloth. If it speaks, let it finish without helping it.',
          'У холодной печи, рядом с погрузочным столом. Бери осколок через тряпку. Заговорит — пусть говорит. Не подсказывай ему.')]),
      inspect('glass-quarry', 'winter-glass',
        'Examine the ward-glass test bed at the Glass Quarry.', 'Осмотреть стенд обережного стекла в Стеклянном карьере.',
        'Two cart frames stand on the test bed: one glazed, one bare. Both salt lines were deliberately broken. Only the bare frame’s seat bears rope burns. The dated tally records two handlers lost from that frame after answering voices; the man inside the glazed frame remained at his post. Raut’s inspector countersigned the test and ordered another batch. Crushed coffin fittings remain in the mixing trough. Beran’s account, the chapel freight and the shipment weights fit together. The panels work as a fitted enclosure, not as loose cargo beneath grain sacks.',
        'На стенде два каркаса повозок: со стеклом и без. Обе соляные полосы нарочно разорваны. Борозды от верёвки есть лишь на сиденье открытого каркаса. В журнале за тот день — двое пропавших из него после ответа голосам; человек за стеклом остался на месте. Инспектор Раута подписал итог испытания и заказал новую партию. В смесительном корыте остались дроблёные гробовые скобы. Рассказ Берана, грузы часовни и весовые записи складываются в одну цепь. Пластины защищают, когда собраны в ограждение, а не лежат грузом под мешками с зерном.'),
      talk('orsa', 'Discuss the glass trade with Orsa at Saltmarket.', 'Обсудить с Орсой торговлю стеклом.',
        'So the villages give up their burial wards and Raut sells passage to the people who can pay. I have two old panels and money set aside for more. I won’t order a new casting. But do I keep the old glass for winter freight, or put that money into salt and ordinary bell repairs? The second reaches more houses. It won’t shelter a cart between them.',
        'Выходит, деревни отдают погребальную защиту, а Раут продаёт проход тем, кто платит. У меня две старые пластины и деньги на новые. Новую плавку я не закажу. Но старое стекло оставить для зимних грузов или пустить деньги на соль и ремонт обычных колоколов? Тогда хватит на большее число домов. Только телегу между ними это не укроет.',
        [
          action('winter-ration', 'Keep the old panels for the winter loads. No new glass, and no secret cargo.',
            'Оставь старые пластины для зимних грузов. Без новых отливок и тайного груза.',
            'Orsa reserved her existing glass for winter freight and canceled new purchases. I accepted continued use of the captive dead until we can reach the source of the binding.',
            'Орса оставила имеющееся стекло для зимних перевозок и отменила новые закупки. Я согласился пока пользоваться трудом пленных мёртвых — до тех пор, пока мы не доберёмся до привязи.',
            'The old panels stay listed in my books. Anyone hiring a covered wagon will know what covers it. Vesk at Crownbridge handled the requisitions; take him the test tally.',
            'Старые пластины внесены в мою книгу. Кто наймёт крытый воз, будет знать, чем тот крыт. Реквизиции проходили через Веска у Коронного моста. Отнеси ему журнал испытания.',
            { registry: 2, commons: 1, lanterns: -1 }),
          action('winter-open', 'Spend it on salt and bell repairs. Keep the panels as evidence, not merchandise.',
            'Потрать деньги на соль и колокола. Стекло оставь как улику, не на продажу.',
            'Orsa withdrew the panels from hire and used her purchase fund for local wards. Houses will benefit first; long winter runs remain exposed.',
            'Орса больше не сдаёт пластины внаём. Деньги на закупку пойдут на местную защиту. Сперва помогут домам; дальние зимние рейсы останутся без укрытия.',
            'The panels are locked away, and the repair orders have gone out. That won’t make the long stretches safe. Vesk at Crownbridge handled the requisitions. Let him see what they became.',
            'Пластины заперты, заказы на ремонт отправлены. Дальние перегоны от этого безопасными не станут. Реквизиции проходили через Веска у Коронного моста. Пусть увидит, во что они превратились.',
            { commons: 2, lanterns: 2, registry: -2 }),
        ]),
    ],
  },
  {
    id: 'weight-of-names', kind: 'main', requires: 'winter-price', reward: 45,
    title: text('IV. The Price of Passage', 'IV. Плата за проход'),
    description: text(
      'Raut’s purchases are established. Check whether he knew what they cost the villages, then follow the older ward-work from Crownlands to Frostspine.',
      'Закупки Раута доказаны. Проверить, знал ли он об их последствиях для деревень, и проследить старую защиту от Коронных земель до Инейного хребта.'),
    unresolved: text(
      'The foundry evidence stops short of Raut’s own orders. Vesk keeps the store keys close and waits for someone to return.',
      'Улики из литейной ещё не связали с личными приказами Раута. Веск держит ключи от склада при себе и ждёт, что за ними вернутся.'),
    stages: [
      talk('vesk', 'Ask Vesk at Crownbridge about Raut’s requisitions.', 'Расспросить Веска у Коронного моста о реквизициях Раута.',
        'I counted the sacks taken. Other people counted the missing. They sent me salt-crusted door ropes and broken bell parts with their complaints. I kept those returns in the Sealed Vault. Compare the dates with your furnace tally. The escort fees are there too.',
        'Я считал вывезенные мешки. Пропавших считали другие. Вместе с жалобами мне присылали просоленные дверные шнуры и обломки колоколов. Я сохранил всё в Опечатанном подвале. Сверь даты с журналом печи. Сборы за сопровождение тоже там.',
        [action('weight-start', 'Give me the key. I’ll compare the returned ward parts with the orders.',
          'Дай ключ. Сверю остатки защиты с приказами.',
          'Vesk kept physical returns from stripped villages alongside requisitions and escort payments. Together they may show what Raut knew and when.',
          'Веск сохранил остатки деревенской защиты вместе с реквизициями и платежами за сопровождение. По ним можно установить, что и когда стало известно Рауту.',
          'Bottom lock sticks. Lift the key; don’t force it. I would rather not add a locksmith to the people I owe.',
          'Нижний замок заедает. Приподними ключ, не ломай. Не хватало ещё слесарю задолжать.')]),
      inspect('tax-vault', 'weight-order',
        'Compare returned ward parts and convoy payments in the Sealed Vault.',
        'Сверить остатки защиты и платежи за обозы в Опечатанном подвале.',
        'One returned bell yoke has an empty crown where its bronze was sawn away. Its village complaint lists disappearances after the removal. Raut marked the complaint “received” before renewing the same requisition. His personal share of paid escorts rises in the following weeks. A scorched courier tube holds a refused request to consult the old ward instructions at Star Monastery. This is not an inspector acting alone.',
        'У одного колокольного подвеса спилена бронзовая корона. В приложенной жалобе перечислены люди, пропавшие после изъятия. Раут отметил получение жалобы, а затем продлил ту же реквизицию. В следующие недели выросла его личная доля от платных проводок. В опалённом тубусе гонца — отклонённая просьба свериться со старыми наставлениями Звёздного монастыря. Инспектор действовал не сам по себе.'),
      talk('nika', 'Ask Nika at High Pass about the monastery courier.', 'Расспросить Нику на Высоком перевале о монастырском гонце.',
        'I guided that courier down and back. Raut broke the seal in front of us. Read the warning, asked how many wagons his glass could cover, and sent us away. On the return journey the courier heard her dead brother below the path. I held her coat until she stopped trying to climb down. Lev kept her copy at Star Monastery.',
        'Я вела того гонца вниз и обратно. Раут при нас сломал печать. Прочёл предупреждение, спросил, на сколько возов хватит стекла, и велел нам идти. На обратном пути гонец услышала под тропой покойного брата. Я держала её за полы, пока она не перестала лезть вниз. Лев сохранил её копию в Звёздном монастыре.',
        [action('weight-courier', 'I’ll read the copy. May I give Vesk your account with it?',
          'Прочту копию. Можно передать Веску и твой рассказ?',
          'Nika saw Raut read a warning and choose to continue. She also pulled the courier back after she answered the Caller: an answer draws a listener out, but does not kill them outright.',
          'Ника видела, как Раут прочёл предупреждение и не остановил дело. Она удержала гонца, ответившую Оклику: ответ тянет человека за голосом, но не убивает сразу.',
          'Use my name. He already knows who carried the lamp. Tell Lev I want my good boots back when the courier can spare them.',
          'Передай с моим именем. Он и так знает, кто нёс фонарь. А Льву скажи: когда гонец сможет, пусть вернёт мои хорошие сапоги.')]),
      inspect('star-monastery', 'weight-census',
        'Study the old ward fittings and instructions at Star Monastery.',
        'Изучить старые защитные крепления и наставления в Звёздном монастыре.',
        'A keeper’s copper wrist-piece is worn smooth on the inside. The servicing sketches show it fastened to a glass anchor at the Old Cloister, in Hollowvale. A living volunteer once bore the binding; later hands substituted the dead. Three independent bell watches can take over if all are maintained before the anchor is opened. Without either arrangement, breaking the anchor releases its captives and ends the glass protection. Repairs annotated over several generations agree with the wear on the fittings.',
        'Медный обруч смотрителя изнутри стёрт до блеска. На рабочих чертежах он соединён со стеклянной привязью в Старом скиту, в Глухой долине. Когда-то её добровольно принимал живой смотритель; позже его заменили мёртвыми. Три отдельных колокольных дозора могут подхватить защиту, если наладить их до размыкания привязи. Иначе разлом освободит пленников и прекратит защиту стекла. Пометки о ремонте сделаны разными руками за несколько поколений; они совпадают с износом креплений.'),
      talk('vesk', 'Bring the warning and Nika’s account back to Vesk.', 'Вернуться к Веску с предупреждением и рассказом Ники.',
        'The dates agree. He read it, kept taking the burial stores, and collected his share. I can take these returns to the villages myself. They’ll have questions for me as well. Or I can stay at this desk and copy each new requisition before it leaves. If my name goes out first, I lose that access.',
        'Даты сходятся. Он прочёл, продолжил забирать погребальные запасы и получать свою долю. Я могу сам отвезти всё это в деревни. Там и ко мне найдутся вопросы. Или останусь за столом и буду снимать копию с каждой новой реквизиции. Если моё имя огласят сейчас, доступа больше не будет.',
        [
          action('weight-trial', 'Take the evidence to them yourself. I’ll escort you, not speak in your place.',
            'Отвези улики сам. Я дам охрану, но отвечать за тебя не стану.',
            'Vesk agreed to face the village witnesses with the original returns. I promised an escort, not an acquittal. Raut’s trade is supported by freight, damaged wards, payments and testimony.',
            'Веск согласился привезти подлинные улики деревенским свидетелям. Я обещал охрану, не оправдание. Торговлю Раута подтверждают грузы, сломанная защита, платежи и показания.',
            'The returns are packed with the accounts. I’ll go when the escort is ready. Ada in Hollow Village knows the approach to the Old Cloister. You still need to see the binding itself.',
            'Обломки упакованы вместе со счетами. Поеду, когда будет охрана. Ада в Глухой деревне знает подход к Старому скиту. Саму привязь тебе ещё нужно увидеть.',
            { commons: 2, lanterns: 1, registry: -2 }),
          action('weight-pardon', 'Stay and copy the orders. I’ll keep your name out of it for now.',
            'Останься и снимай копии. Пока я твоего имени не назову.',
            'I left Vesk in place to copy requisitions and concealed his help for now. The evidence survives in several hands, but villagers will have to wait to question the man who counted their losses.',
            'Я оставил Веска снимать копии и пока скрыл его помощь. Улики разойдутся по нескольким рукам, но деревням придётся подождать, прежде чем расспросить человека, считавшего их потери.',
            'The next copies will leave with ordinary freight. This buys us time, not forgiveness. Find Ada in Hollow Village; she can direct you to the Old Cloister.',
            'Следующие копии уйдут с обычным грузом. Мы выиграли время, не прощение. Найди Аду в Глухой деревне — она укажет путь к Старому скиту.',
            { registry: 2, lanterns: 1, commons: -1 }),
        ],
        [
          remembered('winter-ration',
            'Orsa told me she still uses the old panels. Then our own freight relies on the same captive dead. I won’t leave that out of the account. Raut knew what he was doing; the dates and Nika’s testimony settle it. Shall I take the evidence to the villages, or stay here copying new orders under cover?',
            'Орса сказала, что пока пользуется старыми пластинами. Значит, и наши грузы зависят от тех же пленных мёртвых. В отчёте я это не скрою. Раут знал, что делает: даты и показания Ники сходятся. Мне ехать с уликами в деревни или остаться здесь и тайно копировать новые приказы?'),
          remembered('winter-open',
            'Orsa’s repair orders came through. She’s buying rope and salt instead of glass. It will help the houses, not the couriers between them. Raut’s knowledge is established by these dates and Nika’s account. I can take the evidence to the villages, or keep this desk and copy the orders still going out.',
            'Пришли заказы Орсы на ремонт. Она покупает верёвки и соль вместо стекла. Домам поможет, гонцам между ними — нет. По этим датам и рассказу Ники видно: Раут всё знал. Я могу отвезти улики в деревни или сохранить место и копировать приказы, которые ещё уходят отсюда.'),
        ]),
    ],
  },
  {
    id: 'unwritten-road', kind: 'main', requires: 'weight-of-names', reward: 50,
    title: text('V. Who Keeps the Watch', 'V. Кому стоять дозор'),
    description: text(
      'Find the binding in Hollowvale and decide how to deal with it. Carrying out the plan requires two supplied posts, the enemy caravan destroyed and Raut defeated.',
      'Найти привязь в Глухой долине и решить, как с ней поступить. Для исполнения плана нужны две снабжённые заставы, разгром вражеского каравана и победа над Раутом.'),
    unresolved: text(
      'Elin keeps the binding untouched. The captive voices remain in the glass; nobody has agreed who will keep the road when Raut is gone.',
      'Элин не трогает привязь. Пленные голоса остаются в стекле. Кто будет держать тракт после Раута, так и не решили.'),
    stages: [
      talk('ada', 'Ask Ada in Hollow Village about the Old Cloister.', 'Расспросить Аду в Глухой деревне о Старом ските.',
        'Start at the Echo Well. The furnace carts used to wash their burial sacks there. We covered the mouth after the water began talking. Elin has opened a safe approach, but he won’t break anything with people still on the road. Neither will you, I hope.',
        'Начни с Колодца эха. Печные обозы полоскали там мешки из-под погребальных остатков. Мы закрыли устье, когда вода заговорила. Элин расчистил безопасный подход, но ничего не ломает, пока на тракте люди. Надеюсь, и ты не станешь.',
        [action('road-start', 'I’ll examine the well without answering it, then find Elin.',
          'Осмотрю колодец, отвечать не буду. Потом найду Элина.',
          'Ada connects the Echo Well to the furnace freight. Elin has maintained an approach to the binding, but has not attempted to undo it.',
          'Ада связала Колодец эха с печными обозами. Элин следит за подходом к привязи, но ещё не пытался её разомкнуть.',
          'Stay between the salt marks. Three dead carters came here with requisition freight from the Old Orchard. I buried them. Their tokens and my notes are beside the well; see if Mara can identify them.',
          'Держись между соляными отметками. С грузом реквизиции из Старого сада привезли троих мёртвых возчиков. Я их похоронила. Жетоны и мои записи у колодца. Посмотри, сможет ли Мара их опознать.')],
        [
          remembered('weight-trial',
            'Vesk sent word he’ll bring the broken ward parts himself. Good. There are people here who want to ask about them. Your way lies past the Echo Well to Elin at the Old Cloister. Keep inside his salt marks; the well has learned more voices than it ought to know.',
            'Веск передал, что сам привезёт обломки защиты. Хорошо. Здесь есть кому его расспросить. Тебе идти мимо Колодца эха к Элину в Старый скит. Держись его соляных отметок: колодец выучил слишком много голосов.'),
          remembered('weight-pardon',
            'More copied orders, and still nobody willing to stand here and explain them. I’ll keep the copies dry anyway. Elin is at the Old Cloister, beyond the Echo Well. He marked an approach with salt. Follow it, and don’t answer what comes out of the well.',
            'Опять копии приказов. А прийти и объяснить их некому. Всё равно уберу бумаги от сырости. Элин в Старом скиту, за Колодцем эха. Он отметил подход солью. Иди по нему. Тому, что заговорит из колодца, не отвечай.'),
          remembered('borrowed-restore',
            'Mila told me she’s using her own name at home again. That won’t stop the Caller borrowing the other one; they know to keep the door shut. You do the same at the Echo Well: don’t answer. Beyond it, Elin has marked the approach to the Old Cloister with salt.',
            'Мила сказала, дома её снова зовут своим именем. Оклику это не помешает воспользоваться чужим; они знают, что дверь надо держать закрытой. И ты у Колодца эха не отвечай. За ним Элин отметил солью подход к Старому скиту.'),
        ]),
      inspect('name-well', 'road-names',
        'Examine the closed mouth of the Echo Well.', 'Осмотреть закрытое устье Колодца эха.',
        'The three pay tokens match Mara’s numbers. Ada’s burial notes describe the same old scars Mara recorded. The drivers are dead; what killed them remains uncertain. Bone grit and shroud-thread cling beneath the washing ledge. Black splinters catch in the overflow, where a copper conduit leads toward the Old Cloister. Below the lid, a voice asks for the lead driver’s coat in the words Toman heard. That voice is not evidence of a survivor.',
        'Номера трёх жетонов совпадают с номерами Мары. В погребальных записях Ады — те же старые шрамы, что описала Мара. Возчики мертвы. От чего погибли, пока неясно. Под промывочным жёлобом костяная крошка и нити саванов. В сливе чёрные осколки; оттуда медный отвод уходит к Старому скиту. Из-под крышки просят кафтан переднего возчика — словами, которые слышал Томан. Голос не доказывает, что кто-то выжил.'),
      inspect('last-archive', 'road-index',
        'Examine the binding with Elin at the Old Cloister.', 'Осмотреть привязь с Элином в Старом скиту.',
        'The glass anchor sits in a copper cradle, patched with the same black castings found in Raut’s freight. Burial cloth is fused into its layers. Elin briefly closes the old wrist-piece around his hand: the voices recede into a single strained breath. He opens it before the fastening catches. Three unused bell connections surround the cradle; their spacing matches the monastery sketches. All three alternatives require workers and supplies from outside. Opening the fastening before they arrive would leave the road unprotected.',
        'Стеклянная привязь лежит в медной люльке. Заплаты на ней отлиты из того же чёрного стекла, что в грузах Раута. Между слоями вплавлено погребальное полотно. Элин ненадолго сжимает на руке старый обруч: голоса сливаются в один тяжёлый вдох. Он размыкает его прежде, чем защёлкнется крепление. Вокруг люльки три незадействованных колокольных отвода; расположение совпадает с монастырскими чертежами. Для любого из трёх способов нужны люди и припасы извне. Открыть крепление до их прибытия — значит оставить тракт без защиты.'),
      talk('elin', 'Agree on a plan with Elin after securing the convoy route.',
        'Обсудить с Элином план, обеспечив обозу путь.',
        'Three bells can replace this binding, but only with Radek’s castings and Yara’s willing watches. Or I take it myself. I am offering, captain; you are not sentencing me. We can also break it all and send the dead away, with no ward left for the long road. Whichever we choose, your convoy must bring the workers and supplies. You can leave this undecided and come back.',
        'Три колокола заменят привязь, но нужны отливки Радека и добровольные дозоры Яры. Или я приму её сам. Это моё предложение, капитан, не твой приговор. Можно и всё разбить, отпустить мёртвых. Только весь тракт останется без защиты. Какой бы способ мы ни выбрали, людей и припасы должен привезти твой обоз. Не обязательно решать сейчас. Можешь вернуться позже.',
        [
          {
            ...action('ending-commons', 'We’ll bring the three bells to the village watches.',
              'Доставим три колокола деревенским дозорам.',
              'I committed the convoy to the Three Bells plan. Once Raut is defeated, Radek’s bells and Yara’s volunteers will take over before Elin releases the captive dead. The binding is still intact.',
              'Я обязался провести обоз ради плана «Три колокола». После гибели Раута колокола Радека и добровольцы Яры примут дозор, и лишь затем Элин отпустит пленных мёртвых. Пока привязь цела.',
              'Radek has the bells; Yara has people willing to tend them. We still have to get them through. I’ll leave the binding alone until Raut falls and all three watches answer.',
              'У Радека есть колокола, у Яры — люди, готовые дежурить. Их ещё надо провести. Я не трону привязь, пока Раут не погибнет и все три дозора не ответят.',
              { commons: 3, lanterns: 2, registry: -1 }),
            ending: 'commons', gate: 'conquest', requiresActions: ['bell-mourn', 'stag-dependents'],
          },
          {
            ...action('ending-compact', 'I accept your offer. We’ll provision the cloister before you bind yourself.',
              'Я принимаю твоё предложение. Снабдим скит, прежде чем ты примешь привязь.',
              'I accepted Elin’s offer to take the binding willingly. He will replace the captive dead and remain confined to the Old Cloister. We must keep his supplies and visitors from becoming one person’s monopoly. The ritual requires Raut’s defeat and an escorted convoy; agreeing to it does not bind anyone.',
              'Я принял предложение Элина добровольно взять привязь на себя. Он заменит пленных мёртвых и останется в пределах Старого скита. Нельзя отдавать снабжение и доступ к нему в одни руки. Для обряда нужны победа над Раутом и обоз с охраной; само согласие никого не привязывает.',
              'I know how far the old keeper could walk. I’ve measured it. Bring the stores when Raut is gone, and leave the door open to more than soldiers. Until then, the fastening stays loose.',
              'Я знаю, докуда мог ходить прежний смотритель. Сам отмерил. Когда Раута не станет, привези припасы. И не оставляй дверь открытой только для солдат. До тех пор обруч не замкнут.',
              { registry: 3, lanterns: 1, commons: -1 }),
            ending: 'compact', gate: 'conquest',
          },
          {
            ...action('ending-cinder', 'We break the glass and release them. No one takes their place.',
              'Разобьём стекло и отпустим их. Никого на их место не поставим.',
              'I chose Broken Glass. Once Raut is defeated and the work crews can pass, we will destroy the binding and free the dead. The road will lose its supernatural shelter; guards and good weather will matter again. For now, the glass remains whole.',
              'Я выбрал «Разбитое стекло». После гибели Раута, когда пройдут рабочие, мы уничтожим привязь и освободим мёртвых. Тракт потеряет сверхъестественное укрытие; снова придётся полагаться на охрану и погоду. Пока стекло цело.',
              'Then no replacement keeper. I’ll prepare the cradle so it can be opened without trapping another voice. First Raut, then the glass. Warn the drivers before we start; some will choose not to make the journey.',
              'Значит, нового пленника не будет. Подготовлю люльку, чтобы её можно было открыть, не поймав ещё один голос. Сначала Раут, потом стекло. Перед началом предупреди возчиков: кто-то откажется ехать.',
              { lanterns: 3, commons: 1, registry: -3 }),
            ending: 'cinder', gate: 'conquest',
          },
        ],
        [
          remembered('bell-mourn',
            'Radek sent the dimensions of his three bells. They fit the unused connections. Castings are only half of it: Yara must have willing watches whose households can spare them. Otherwise I can take the binding myself, or we can break it without a replacement. The workers will need your convoy and the supplied posts.',
            'Радек прислал размеры трёх колоколов. Подходят к свободным отводам. Но отливки — половина дела: у Яры должны быть добровольцы, чьи семьи могут отпустить их в дозор. Иначе привязь приму я. Или разомкнём её без замены. Для работы понадобятся твой обоз и припасы на заставах.'),
          remembered('stag-dependents',
            'Yara has volunteers, and their families will eat while they stand watch. That makes the three-bell plan possible, if Radek has agreed to cast them. Without his bells there is still my offer, or breaking the binding outright. We need to agree on a method before asking the workers to set out.',
            'У Яры есть добровольцы, их семьи не будут голодать во время дозора. С ними план трёх колоколов возможен, если Радек согласился их отлить. Без колоколов остаётся моё предложение или полный разлом привязи. Нужно выбрать способ, прежде чем звать людей в дорогу.'),
          remembered('bell-road',
            'Radek’s single heavy bell will serve its own crossing. It cannot stand in for three separate watches. My offer still stands: I take the binding willingly. Or we free the dead without replacing the ward. Either method needs a work crew brought here safely.',
            'Один тяжёлый колокол Радека послужит своему переезду. Три отдельных дозора он не заменит. Моё предложение в силе: я добровольно приму привязь. Или отпустим мёртвых без новой защиты. В любом случае сюда нужно безопасно доставить людей для работы.'),
          remembered('stag-secret',
            'The families have kept their bell, but Yara has no shared watch to offer us. I won’t bind unwilling households to a rota. I can take the old binding myself, or we can free the dead without replacing it. We will need provisions at the cloister either way.',
            'Семьи оставили себе колокол, но общего дозора у Яры для нас нет. Я не стану навязывать дежурство тем, кто не согласен. Могу принять старую привязь сам. Или освободим мёртвых без замены. Припасы в скиту понадобятся в любом случае.'),
        ]),
    ],
  },
  {
    id: 'orchard-claim', kind: 'side', requires: null, reward: 25,
    title: text('The Roots Below the Deed', 'Корни под межой'),
    description: text(
      'Lida’s orchard has a new owner who wants to clear the oldest trees. Find out what lies beneath them before anyone brings an axe.',
      'Новая хозяйка сада Лиды хочет вырубить старые деревья. Узнать, что лежит под ними, прежде чем принесут топор.'),
    unresolved: text(
      'The sale remains disputed. Lida tends the trees she can reach; the oldest row goes unpruned while both households wait.',
      'Спор о продаже не решён. Лида ухаживает за доступными деревьями; старый ряд стоит необрезанным, пока обе семьи ждут.'),
    stages: [
      talk('lida', 'Hear Lida’s request in Greenhollow.', 'Выслушать просьбу Лиды в Зелёной лощине.',
        'The woman who bought the orchard isn’t a fool. Half the trees no longer bear, and she paid with the price of her house. But my wife is under the oldest apple tree. When I said so, the cutters called it a trick. There are burial stones under the nettles. Find them before this becomes a fight.',
        'Женщина, купившая сад, не дура. Половина деревьев уже не плодоносит, а она ради покупки дом продала. Только под самой старой яблоней лежит моя жена. Я сказала — рубщики решили, что выдумываю. В крапиве есть могильные камни. Найди их, пока мы не передрались.',
        [action('orchard-start', 'I’ll look beneath the nettles. Ask the cutters to wait.',
          'Посмотрю под крапивой. Попроси рубщиков подождать.',
          'Lida says the old orchard row was planted over family burials. The buyer needs productive land; the cutters will wait for the graves to be checked.',
          'По словам Лиды, старый ряд сада посадили над семейными могилами. Покупательнице нужна плодоносящая земля. Рубщики подождут, пока мы проверим захоронения.',
          'They’ve gone to sharpen their tools. That gives you a little time, not much. Don’t pull on a root if you find cloth.',
          'Пошли точить инструмент. Немного времени есть. Найдёшь полотно — за корень не тяни.')]),
      inspect('old-orchard', 'orchard-pact',
        'Examine the stones and exposed roots in the Old Orchard.', 'Осмотреть камни и обнажённые корни в Старом саду.',
        'Six low stones follow the oldest row. Each names a burial; the planting dates are later. A storm-torn root holds shroud cloth, not a fresh body. The new survey pegs run straight across the graves. Felling and grubbing this row would disturb the burials, but the younger trees beyond it remain productive. Nothing here shows a curse.',
        'Вдоль старого ряда шесть низких камней с надгробными надписями. Даты посадки позднее дат смерти. На вывороченном бурей корне — старое полотно савана, не свежее тело. Новые межевые колышки проходят прямо через могилы. Если корчевать ряд, захоронения пострадают. Молодые деревья за ним ещё плодоносят. Признаков проклятия здесь нет.'),
      talk('toman', 'Ask Toman what the orchard buyer was told.', 'Узнать у Томана, что сказали покупательнице сада.',
        'I witnessed the sale. The deed said “old orchard”; nobody showed her the graves. She won’t dig them up now she knows. She offered Lida two terms: work the younger rows together and divide the fruit, or keep the sale as it stands and pay Lida to tend the burial row. Lida hasn’t answered either.',
        'Я был свидетелем продажи. В купчей написали «старый сад», могилы ей не показали. Теперь знает и трогать не будет. Предложила Лиде два выхода: вместе работать в молодом ряду и делить плоды или оставить купчую как есть, а Лиде платить за уход за могильным рядом. Лида пока ни на что не ответила.',
        [action('orchard-witness', 'I’ll take both offers to Lida. Keep the grave boundaries marked.',
          'Передам Лиде оба предложения. Границы могил пусть останутся отмечены.',
          'Toman confirms the buyer was not told about the graves. She accepts their preservation and has offered either shared cultivation or paid care under her ownership.',
          'Томан подтвердил: о могилах покупательнице не сообщили. Она согласна их сохранить и предлагает либо совместную работу, либо оплаченный уход при сохранении её собственности.',
          'I moved the pegs myself. This time both women saw where I put them.',
          'Колышки я сам переставил. На этот раз обе видели, куда.')],
        [
          remembered('names-public',
            'Since the warning, people won’t take the orchard path alone. That doesn’t make its roots cursed. I witnessed the sale; the buyer wasn’t shown the graves. Now she offers shared work and fruit, or wages for Lida to tend the burial row while the deed stands. Both offers are hers, not something I can impose.',
            'После предупреждения люди боятся ходить по саду в одиночку. Корни от этого проклятыми не стали. При продаже я был, могил покупательнице не показали. Теперь она предлагает совместную работу и раздел плодов либо плату Лиде за уход за могильным рядом при сохранении купчей. Это её предложения, не мой приказ.'),
        ]),
      talk('lida', 'Discuss the buyer’s offers with Lida.', 'Обсудить с Лидой предложения покупательницы.',
        'She could have dug first and argued later. I’ll give her that. Sharing means seeing her at my wife’s tree every morning. Wages mean asking permission to do work I’ve done for twenty years. I can live with either, I think. Which offer would you carry back?',
        'Могла ведь сперва раскопать, потом спорить. За это ей спасибо. Делить сад — значит каждое утро видеть её у дерева моей жены. Брать плату — просить разрешения на работу, которую двадцать лет делаю. Наверное, я смогу и так, и так. Какой ответ ты бы отнёс?',
        [
          action('orchard-share', 'Tell her you’ll share the work and the fruit. Keep the burial row out of the bargain.',
            'Согласись делить работу и плоды. Могильный ряд оставьте за пределами торга.',
            'I carried Lida’s acceptance of shared cultivation. The graves remain untouched. Both women have a claim on the harvest and a reason to argue over the work.',
            'Я передал согласие Лиды на совместный уход. Могилы не тронут. У обеих женщин теперь есть доля урожая и повод спорить о работе.',
            'We’ve divided the rows, not the graves. She prunes too hard for my liking. I suppose she’ll say I keep every dead branch. We start together tomorrow.',
            'Ряды поделили, могилы — нет. На мой вкус, она слишком много обрезает. Наверное, скажет, что я за каждую сухую ветку держусь. Завтра начнём вместе.',
            { commons: 2, lanterns: 1 }),
          action('orchard-deed', 'Accept the paid care. Have Toman witness your right to reach the graves.',
            'Согласись ухаживать за плату. Пусть Томан засвидетельствует право ходить к могилам.',
            'Lida accepted wages while the buyer kept the deed. Toman witnessed unrestricted access to the graves. The burials are safe, but Lida no longer decides what happens to the living orchard.',
            'Лида согласилась на плату, купчая осталась у покупательницы. Томан засвидетельствовал свободный доступ к могилам. Захоронения целы, но живым садом Лида больше не распоряжается.',
            'The first pay is on my shelf. Feels odd. I can come to the tree whenever I want; the rest of the orchard is hers to manage. I’m trying not to watch.',
            'Первая плата лежит на полке. Непривычно. К дереву могу прийти когда захочу. Остальным садом ведает она. Стараюсь не смотреть.',
            { registry: 2, commons: -1 }),
        ]),
    ],
  },
  {
    id: 'stag-oath', kind: 'side', requires: null, reward: 25,
    title: text('The Missing Warning', 'Украденный звон'),
    description: text(
      'The warning bell has vanished from the Stag Shrine. Yara needs it found before a patrol decides whom to punish.',
      'Из Оленьего святилища пропал сигнальный колокол. Яра хочет найти его прежде, чем дозорные назначат виновного.'),
    unresolved: text(
      'The Stag Shrine remains silent. Yara has no common watch to offer the road, and the scattered households fend for themselves.',
      'Оленье святилище молчит. Общего дозора для тракта у Яры нет; разбросанные семьи защищаются как могут.'),
    stages: [
      talk('yara', 'Ask Yara at Thornwatch about the missing bell.', 'Расспросить Яру в Терновом дозоре о колоколе.',
        'The shrine bell is gone. Not cracked. Gone. The patrol wants to search the children who gather antlers there. A child couldn’t lift the yoke, but that hasn’t slowed the patrol down. Go look at the frame. Tell me how it was taken.',
        'Колокол святилища пропал. Не треснул. Пропал. Дозорные хотят обыскать детей, которые собирают там рога. Ребёнок и подвес не поднимет, но дозорных это не смущает. Осмотри раму. Скажи мне, как его сняли.',
        [action('stag-start', 'I’ll check the frame. Keep the patrol away from the children until then.',
          'Проверю раму. Пока не пускай дозорных к детям.',
          'Yara asked for evidence of how the shrine bell was removed. The accusation against the antler-gatherers rests on nothing but their presence nearby.',
          'Яра попросила выяснить, как сняли колокол. Детей обвинили лишь потому, что они бывают рядом и собирают рога.',
          'They have snares to clear. I’ll keep them at it. Be quick.',
          'У них силки не сняты. Займу этим. Только не тяни.')]),
      inspect('stag-shrine', 'stag-bell',
        'Examine the empty bell frame at the Stag Shrine.', 'Осмотреть пустую раму в Оленьем святилище.',
        'The yoke pins were withdrawn with a proper iron drift, not broken. Wool wrapped around the clapper kept it quiet. Two deep adult boot tracks lead toward the rear of the shrine; a drag mark stops at stone paving. A strip of flour-sack cloth hangs on the frame. Whoever took the bell meant to use it intact.',
        'Штифты выбили железным пробойником, а не выломали. Язык обмотали шерстью, чтобы не звенел. За святилище ведут глубокие следы двух взрослых; полоса от волокуши теряется на каменных плитах. На раме висит лоскут мучного мешка. Колокол снимали не на лом.'),
      talk('toman', 'Ask Toman about the flour-sack cloth.', 'Расспросить Томана о лоскуте мучного мешка.',
        'That’s the mill’s coarse sacking. Two families took some to patch the shelter behind the shrine. One woman asked to borrow a drift yesterday. Said a hinge was stuck. They came from houses without a bell, and the shrine was left untended at night. Don’t send soldiers in after them. Speak to Yara once you’ve seen where they sleep.',
        'Это наша грубая мешковина. Две семьи взяли её залатать навес за святилищем. Вчера женщина просила пробойник: будто петлю заело. Они пришли из домов, где нет колокола. А у святилища по ночам никто не дежурил. Не посылай за ними солдат. Посмотри, где они спят, потом поговори с Ярой.',
        [action('stag-witness', 'I’ll check the shelter without bringing the patrol.',
          'Проверю навес. Дозорных с собой не возьму.',
          'Toman lent tools and sacking to displaced families behind the shrine. They had reason to want a working bell close to their beds; he did not see them take it.',
          'Томан давал инструмент и мешковину семьям за святилищем. Им нужен был действующий колокол рядом с ночлегом. Самой кражи он не видел.',
          'There’s an old man on crutches and three children. Knock on the stone before going round the back. They’re frightened enough.',
          'Там старик на костылях и трое детей. Постучи по камню, прежде чем зайти за навес. Они и так напуганы.')]),
      inspect('stag-shrine', 'stag-shelter',
        'Check the shelter behind the Stag Shrine.', 'Осмотреть навес за Оленьим святилищем.',
        'The bell hangs from a low beam above five bedrolls. Its clapper is unwrapped; a fresh salt boundary encloses the sleepers. A woman shows the blister the hauling rope left on her palm. She agrees to return the bell to the shared frame if someone keeps watch there and meals are set aside for those who cannot take a turn. No one offers to leave the children alone again.',
        'Колокол висит на низкой балке над пятью подстилками. Язык развёрнут; спящих окружает свежая полоса соли. Женщина показывает волдырь на ладони от верёвки. Она согласна вернуть колокол на общую раму, если там будут дежурить и оставлять еду тем, кто не может выйти в дозор. Снова бросать детей без присмотра никто не собирается.'),
      talk('yara', 'Bring the families’ terms to Yara.', 'Передать Яре условия семей.',
        'They used it better than we did. I have hunters willing to share a watch, but their dependents need to eat while they’re away. I can set aside part of the communal meat and open the shrine to the families. Or leave them the bell and keep their hiding place out of the patrol’s talk. Then there’s no shared warning here.',
        'Они хоть пользовались колоколом, не то что мы. Есть охотники, готовые дежурить по очереди. Только их семьи нужно кормить, пока они в дозоре. Могу выделить долю общего мяса и открыть святилище для этих людей. Или оставить им колокол и не рассказывать дозорным про навес. Тогда общего сигнала у нас не будет.',
        [
          action('stag-dependents', 'Set aside food for their dependents. I’ll back the families’ place in the shared watch.',
            'Выдели еду их семьям. Я поддержу их место в общем дозоре.',
            'Yara and the families restored the shrine bell together. Hunters volunteered for a shared watch after meals were guaranteed for their dependents. These are willing allies for a future network, not people assigned to it.',
            'Яра и семьи вместе вернули колокол. Охотники согласились на общий дозор, когда для их близких выделили еду. Это добровольные союзники для будущей сети, а не назначенные мной люди.',
            'The bell is up. We’ve got a rota, and the dependents eat from the same pot as the hunters. Tell Elin we can teach other willing watches. Don’t tell him it runs itself.',
            'Колокол подняли. Очередь составили, семьи едят из одного котла с охотниками. Передай Элину: можем обучить другие добровольные дозоры. Только не говори, будто дальше всё само пойдёт.',
            { commons: 3, lanterns: 1, registry: 1 }),
          action('stag-secret', 'Leave the bell with the families. Keep the patrol away from their shelter.',
            'Оставь колокол семьям. Не подпускай дозорных к навесу.',
            'Yara left the bell with the displaced households and concealed their shelter from the patrol. They retain a close warning, but no common watch forms around the shrine.',
            'Яра оставила колокол переселенцам и скрыла навес от дозорных. У семей есть свой сигнал, но общего дозора при святилище не появилось.',
            'They still have the bell. The patrol has stopped asking me where they sleep. I can protect that much; I can’t offer Elin a shared watch we never made.',
            'Колокол у них. Дозорные больше не спрашивают, где они спят. Это я уберегу. Но общего дозора для Элина у меня нет.',
            { lanterns: 2, commons: -1, registry: -2 }),
        ]),
    ],
  },
  {
    id: 'ferry-debt', kind: 'side', requires: null, reward: 30,
    title: text('The Fare on the Step', 'Плата на ступени'),
    description: text(
      'A wet handprint returns to the ferry steps each night. Oss wants to know what the drowned passenger is still waiting for.',
      'Каждую ночь на ступенях переправы появляется мокрый отпечаток ладони. Осс хочет понять, чего ещё ждёт утонувший пассажир.'),
    unresolved: text(
      'Oss leaves the last crossing empty. The wet print keeps returning, and the passenger’s family has no account of his death.',
      'Последним рейсом Осс ходит без людей. Мокрый след появляется снова; семья пассажира так и не узнала, как он погиб.'),
    stages: [
      talk('oss', 'Ask Oss about the night passenger at Lantern Ferry.', 'Расспросить Осса о ночном пассажире на Фонарной переправе.',
        'Same handprint every dusk. No feet coming up to it. I scrub the step; it comes back. A man drowned here in the spring flood. The chapel has his things. See whether they kept his fare token. Maybe I’ve been leaving the wrong coin.',
        'Каждый вечер одна и та же ладонь. А следов ног к ней нет. Отскребаю ступень — снова проступает. Весной, в разлив, тут утонул человек. Его вещи в часовне. Посмотри, сохранился ли проездной жетон. Может, я не ту монету оставляю.',
        [action('ferry-start', 'I’ll look for his belongings at the chapel. Don’t make another night crossing alone.',
          'Поищу его вещи в часовне. Ночью один больше не выходи.',
          'Oss reports a recurring wet handprint at the ferry. A passenger drowned there during the spring flood; his belongings were taken to Reed Chapel.',
          'Осс рассказал о мокром отпечатке, который возвращается на переправу. Пассажир утонул там во время весеннего разлива; его вещи унесли в Камышовую часовню.',
          'I’ve tied the boat up before sunset. First time in years I’ve been early for anything.',
          'Лодку привязал до заката. Первый раз за много лет хоть куда-то успел заранее.')]),
      inspect('reed-chapel', 'ferry-token',
        'Examine the drowned passenger’s belongings at Reed Chapel.',
        'Осмотреть вещи утонувшего пассажира в Камышовой часовне.',
        'A brass fare token is sewn inside the coat lining. A length of ferry safety rope was preserved with it: one end snapped into fibers, the other was cut cleanly. The burial label says the body was recovered downstream with a loop still around its wrist. The token was not buried with him. The cut alone does not say why it was made.',
        'В подкладку кафтана зашит латунный проездной жетон. С ним сохранили кусок страховочного каната: один конец разлохмачен, другой ровно срезан. На погребальной бирке отмечено, что тело нашли ниже по течению, с петлёй на запястье. Жетон с ним не похоронили. Сам срез ещё не объясняет, зачем резали канат.'),
      talk('ivet', 'Ask Ivet who survived the ferry accident.', 'Спросить Ивету, кто пережил несчастье на переправе.',
        'His daughter. I dried her by this stove. She said the ferry swung broadside and her father went over with the safety loop on his wrist. Oss had a knife in his hand. She couldn’t see what he cut. That is all she saw; don’t add to it. The token belongs in the shroud. I can see to that.',
        'Его дочь. Я сушила её у этой печи. Говорит, паром развернуло боком, отец упал за борт с петлёй на запястье. У Осса в руке был нож. Что он резал, она не видела. Это всё, что она рассказала. Не добавляй от себя. Жетон нужно вернуть в саван. Я займусь.',
        [action('ferry-witness', 'Return the token to him. I’ll ask Oss about the cut rope.',
          'Верни ему жетон. Я спрошу Осса о перерезанном канате.',
          'Ivet confirms the daughter survived and saw Oss holding a knife, but not the cutting itself. She will return the withheld token; I still need Oss’s account of the rope.',
          'Ивета подтвердила: дочь выжила и видела у Осса нож, но самого разреза не видела. Ивета вернёт покойному жетон. Мне ещё нужно услышать от Осса, что было с канатом.',
          'I’ll take someone with me to the grave. If the print stops, it tells us he wanted his fare. It won’t tell us whether Oss did right.',
          'На могилу возьму кого-нибудь с собой. Если след исчезнет, значит, ему нужен был жетон. Прав ли был Осс — это по следу не узнаешь.')]),
      talk('oss', 'Ask Oss why the safety rope was cut.', 'Спросить Осса, зачем перерезали страховочный канат.',
        'I cut it. The loop caught the rudder and held us across the current. There were four others in the boat. I could have tried another knot; I didn’t. His daughter knows where to find me. Ivet will hear my account with witnesses. I can go now and tie up the ferry, or stay under her oversight and teach another hand before I leave.',
        'Я разрезал. Петля зацепила руль, нас держало поперёк течения. В лодке ещё четверо. Можно было попробовать развязать другой узел. Я не попробовал. Дочь знает, где меня найти. Ивета выслушает меня при свидетелях. Могу идти сейчас, привязав паром. Могу пока остаться под её присмотром и обучить сменщика.',
        [
          action('ferry-repay', 'Stay under Ivet’s oversight and teach a replacement. Give the family free passage, not excuses.',
            'Останься под присмотром Иветы, обучи сменщика. Семью вози бесплатно, без оправданий.',
            'Oss gave Ivet his account and stayed to train a replacement under her oversight. The family crosses without payment. Returning the token ended the wet prints; it did not settle responsibility for the cut rope.',
            'Осс передал Ивете свой рассказ и остался обучать сменщика под её присмотром. Семья ездит бесплатно. После возвращения жетона мокрые следы исчезли. Кто ответит за перерезанный канат, ещё не решено.',
            'No print since the burial. Ivet checks the crossings, and the new hand is learning the knots. The girl takes the free passage. She sits at the far end.',
            'После похорон следа нет. Ивета проверяет рейсы, сменщик учит узлы. Девочка ездит бесплатно. Садится на дальнем конце.',
            { lanterns: 2, commons: 1, registry: -1 }),
          action('ferry-trial', 'Go to the hearing now. Leave the ferry tied until another ferryman is found.',
            'Иди к свидетелям сейчас. Паром пусть стоит, пока не найдут другого перевозчика.',
            'Oss agreed to an immediate hearing and suspended his crossings. Ivet returned the token and the prints stopped. Travelers must use the longer land route while another ferryman is sought.',
            'Осс согласился сразу дать показания и прекратил рейсы. Ивета вернула жетон, следы перестали появляться. Пока ищут другого паромщика, путникам придётся ехать в обход по суше.',
            'My account is with the witnesses. The boat stays tied; I won’t take another fare while they hear it. No wet hand on the step now. Just people asking when they can cross.',
            'Мой рассказ у свидетелей. Лодка привязана, пока разбираются — плату не беру. Мокрой ладони на ступени больше нет. Только люди спрашивают, когда можно переправиться.',
            { registry: 2, commons: 1, lanterns: -2 }),
        ]),
    ],
  },
  {
    id: 'wreck-light', kind: 'side', requires: null, reward: 30,
    title: text('The Second Shore Light', 'Второй береговой огонь'),
    description: text(
      'A wreck lies below Wreckers’ Rest. The surviving helmsman insists he followed two channel lights, though the shore should show only one.',
      'Под Приютом корабельщиков разбилось судно. Выживший рулевой утверждает, что шёл на два створных огня, хотя с берега должен быть виден только один.'),
    unresolved: text(
      'The salvaged cargo is sold a little at a time. The helmsman’s account of the second light remains untested.',
      'Поднятый груз понемногу распродают. Рассказ рулевого о втором огне так никто и не проверил.'),
    stages: [
      talk('dren', 'Hear Dren’s account at Wreckers’ Rest.', 'Выслушать Дрена в Приюте корабельщиков.',
        'We pulled twelve out. Four are still missing. The helmsman says he saw two lights lining up a channel through the rocks. Hana keeps the true shore lamp. Ask her whether it moved before you let him put all of this on us. I’ve got enough people shouting already.',
        'Двенадцать вытащили. Четверых всё ещё нет. Рулевой говорит, видел два огня — будто створ через камни. Настоящий береговой огонь у Ханы. Узнай, не сдвигали ли его, прежде чем позволишь свалить всё на нас. Тут и без тебя криков хватает.',
        [action('wreck-start', 'I’ll inspect the shore lamp first. Keep the remaining cargo together.',
          'Сперва осмотрю береговой огонь. Остатки груза пока не разбирай.',
          'Dren disputes the helmsman’s claim. I will check the fixed lamp at the Tide Observatory before attributing the wreck to a false signal.',
          'Дрен оспаривает слова рулевого. Я проверю неподвижный фонарь Приливной башни, прежде чем связывать крушение с ложным сигналом.',
          'The unsold sacks are under canvas. Nobody touches them until you’ve spoken to Hana.',
          'Непроданные мешки под парусиной. До разговора с Ханой никто их не тронет.')]),
      inspect('tide-observatory', 'wreck-mount',
        'Examine the shore lamp’s mount at the Tide Observatory.', 'Осмотреть крепление берегового фонаря в Приливной башне.',
        'Old lime seals across the lamp bolts are unbroken. Its beam still meets the channel marker on the same bearing. A spare red lens is missing from the rack; its socket has fresh copper filings. The fixed light was not moved. A second portable lamp could have made a false alignment, but the empty rack does not identify who used it.',
        'Старая известковая пломба поперёк болтов цела. Луч по-прежнему направлен на створную веху. На стойке нет запасной красной линзы, в гнезде свежая медная стружка. Неподвижный огонь не переносили. Переносной фонарь мог дать ложный створ, но пустое гнездо ещё не указывает, кто его взял.'),
      talk('hana', 'Ask Hana about the missing red lens.', 'Расспросить Хану о пропавшей красной линзе.',
        'Dren’s crew borrowed a portable lamp to search the shallows. Before the wreck, not after. I saw its red light above the wrong rocks that night and rang the warning, but the ship was already turning. Their lamp had a split carrying sleeve sewn with sail thread. If you find it, compare that seam.',
        'Команда Дрена брала переносной фонарь — искать на мелководье. До крушения, не после. В ту ночь я видела красный огонь над другими камнями и ударила тревогу. Судно уже поворачивало. У их фонаря был лопнувший чехол, зашитый парусной нитью. Найдёшь — сравни шов.',
        [action('wreck-witness', 'I’ll look through the salvage for the lamp and sleeve.',
          'Поищу среди поднятого груза фонарь и чехол.',
          'Hana places a borrowed red lamp on the dangerous bearing before the ship struck. She can identify its repaired carrying sleeve, but could not see who held it.',
          'По словам Ханы, взятый взаймы красный фонарь стоял на опасном направлении до удара судна о камни. Она опознает чинёный чехол, но самого человека у фонаря не видела.',
          'It should be cold enough to handle now. Don’t let anyone call the second light a wandering soul. I know the color of my own lens.',
          'Теперь уже остыл, можно брать. Только не слушай про блуждающую душу. Цвет собственной линзы я знаю.')]),
      inspect('wreckers-rest', 'wreck-cache',
        'Inspect the lamp hidden with the salvage at Wreckers’ Rest.',
        'Осмотреть фонарь среди груза в Приюте корабельщиков.',
        'Under the unsold sacks lies the red lamp, wrapped in a split sleeve repaired with sail thread. Its foot is packed with the same white grit as the false bearing above the rocks. Fresh oil remains in the reservoir; the lens’s copper rim bears the observatory’s equipment mark. Beside it are tally sticks dividing the cargo before any salvage hearing. The lamp and repaired sleeve match Hana’s account. Who set the false light still needs to be established.',
        'Под непроданными мешками лежит красный фонарь в лопнувшем чехле с парусным швом. В основание набилась та же белая крошка, что на ложном створе над камнями. В бачке осталось масло; на медной оправе линзы — клеймо Приливной башни. Рядом счётные палочки с разделом груза ещё до разбора прав на спасённое. Фонарь и чинёный чехол соответствуют рассказу Ханы. Кто именно поставил ложный огонь, ещё предстоит выяснить.'),
      talk('dren', 'Bring the false lamp and Hana’s account to Dren.', 'Предъявить Дрену ложный фонарь и рассказ Ханы.',
        'My crew put it there. They said an empty coaster was coming. I let them, and the coaster wasn’t empty. We’ve eaten some of the flour. I can turn over what remains with our names attached, or ask the survivors to leave it here as a debt while we repair the true warning light. They may refuse. I won’t hide the lamp either way.',
        'Фонарь поставили мои. Сказали, идёт пустой каботажник. Я разрешил. А он был не пустой. Часть муки мы уже съели. Могу отдать остаток и назвать всех наших. Или попросить выживших оставить его нам в долг, пока чиним настоящий сигнальный огонь. Они могут отказать. Фонарь я больше прятать не буду.',
        [
          action('wreck-restitution', 'Load what remains for the survivors. I’ll carry the lamp and your account with it.',
            'Грузи остаток для выживших. Я передам им фонарь и твой рассказ.',
            'The remaining cargo went to the surviving crew, with the false lamp and Dren’s account. The shore households must replace the food already eaten; the deaths are still for witnesses to judge.',
            'Остаток груза передали выжившей команде вместе с ложным фонарём и рассказом Дрена. Береговым семьям предстоит возместить съеденное. Обстоятельства гибели людей ещё будут разбирать свидетели.',
            'The sacks are gone. The survivors took the lamp too. People here are angry about supper; I’ve told them whose flour we were eating.',
            'Мешки увезли. Фонарь выжившие тоже забрали. Наши злятся, что нечего на ужин поставить. Я сказал им, чью муку мы ели.',
            { registry: 2, lanterns: 1, commons: -1 }),
          action('wreck-relief', 'Ask for a food loan, openly. If they agree, have Hana witness the debt and the repair work.',
            'Открыто попроси еду в долг. Если согласятся, пусть Хана засвидетельствует долг и ремонт.',
            'The survivors allowed the food to remain as a witnessed debt, not lawful salvage. Dren’s crew must repair the warning equipment under Hana’s eye. The injured sailors still lack payment for what they lost.',
            'Выжившие согласились оставить еду в долг при свидетелях, а не признать законной добычей. Команда Дрена чинит сигнальное оборудование под присмотром Ханы. Пострадавшие моряки пока не получили возмещения.',
            'They agreed to the loan. Made me count every sack in front of them. Hana holds the tally and the lamp keys now. I’m not allowed to touch a signal alone.',
            'На долг согласились. Заставили пересчитать при них каждый мешок. Опись и ключи от фонарей теперь у Ханы. К сигналам одному мне подходить нельзя.',
            { commons: 2, registry: -1, lanterns: 1 }),
        ]),
    ],
  },
  {
    id: 'ash-water', kind: 'side', requires: null, reward: 30,
    title: text('What Boiling Leaves Behind', 'Что остаётся после кипячения'),
    description: text(
      'People in Cinderwell are falling ill despite intact salt lines. Tessa suspects the well rather than the Caller.',
      'В Углеземье болеют за целыми соляными полосами. Тесса подозревает не Оклик, а колодезную воду.'),
    unresolved: text(
      'Tessa carries water from farther uphill for the worst cases. The source of the contamination remains in use.',
      'Для самых тяжёлых больных Тесса носит воду с горы. Источником заражения так никто и не занялся.'),
    stages: [
      talk('tessa', 'Hear Tessa’s findings in Cinderwell.', 'Выслушать Тессу в Углеземье.',
        'Cramps, vomiting, the same households every week. No voices. Their salt is dry. Boiling the well water hasn’t helped; the uphill spring water has. I need you to follow the old channel at the Ash Cairn. Don’t taste either sample. I already have enough patients who were curious.',
        'Резь в животе, рвота, каждую неделю в одних домах. Голосов нет. Соль сухая. Кипячёная вода из колодца не помогает, из верхнего родника — помогает. Пройди старый канал у Пепельного кургана. Только пробы не пей. Любопытных больных у меня уже достаточно.',
        [action('ash-start', 'I’ll follow the channel and look for where the two waters meet.',
          'Пройду вдоль канала и найду, где смешивается вода.',
          'Tessa’s cases cluster around the lower well. Improvement after switching water suggests contamination, not an attack by the Caller. The old channel may reveal the source.',
          'Больные Тессы берут воду из нижнего колодца. После смены воды им лучше — это похоже на загрязнение, а не на нападение Оклика. Старый канал может вывести к источнику.',
          'Take a stoppered jar for each side of the drain. Mark which is which before you come back. Not after.',
          'Возьми по банке с каждой стороны стока. Подпиши, где какая, до возвращения. Не после.')]),
      inspect('ash-cairn', 'ash-channel',
        'Trace the well feeder at the Ash Cairn.', 'Проследить приток колодца у Пепельного кургана.',
        'A split settling pit leaks gray furnace wash directly into the lower well feeder. Upstream stones are clean; below the leak they carry a pale metallic crust. The older spring channel remains clear behind a silted sluice. Opening it would give clean water a separate route, but its overflow passes through the rooms workers have made in the old cellar. The leak, the deposits and Tessa’s cases point to ordinary poisoning.',
        'Из треснувшего отстойника серая промывочная вода печей идёт прямо в приток нижнего колодца. Выше течения камни чистые, ниже покрыты светлым металлическим налётом. Старый родниковый канал за занесённой задвижкой чист. Его можно открыть отдельно, но перелив пойдёт через комнаты, которые рабочие устроили в бывшем подвале. Течь, налёт и наблюдения Тессы указывают на обычное отравление.'),
      talk('tessa', 'Choose a practical remedy with Tessa.', 'Обсудить с Тессой, как дать людям чистую воду.',
        'That fits. Boiling won’t remove what the wash leaves in the pot. The workers will stop the washing line to rebuild the pit, but lose their pay meanwhile. Or we open the old channel now and move the cellar families into the dry loft. They’ve agreed, if their bedding goes first. Neither means the sick are cured today.',
        'Сходится. Кипячение не уберёт то, что остаётся на дне котла. Рабочие готовы остановить промывку и переложить отстойник, но на это время останутся без платы. Или откроем старый канал сейчас и переселим семьи из подвала на сухой чердак. Они согласны, если сперва вынесем постели. Больные сегодня же не выздоровеют ни от того, ни от другого.',
        [
          action('ash-close', 'Back the stoppage and repair the pit. Keep carrying spring water until the well is safe.',
            'Поддержим остановку и ремонт отстойника. Пока носите воду из родника.',
            'The workers stopped the washing line to repair the settling pit. Tessa will keep the lower well closed until repeated checks are clear. The lost wages are immediate; recovery is not.',
            'Рабочие остановили промывку ради ремонта отстойника. Тесса не откроет нижний колодец, пока повторные проверки не подтвердят чистоту. Заработка лишились сразу; выздоровления придётся ждать.',
            'The washing line is still quiet. We’re carrying clean water, and the cramps are easing in a few houses. Don’t let anyone drink from the well just because it looks better.',
            'Промывка пока стоит. Носим чистую воду, в нескольких домах боли стали слабее. Не давай пить из колодца только потому, что он лучше выглядит.',
            { commons: 2, lanterns: 1, registry: -1 }),
          action('ash-channel-open', 'Move the bedding first, then open the spring channel. No one sleeps below the overflow.',
            'Сперва вынесите постели, потом открывайте родниковый канал. Под переливом никто не спит.',
            'The cellar households moved into the loft before the clean spring channel was opened. The washing line continues, but the polluted well stays closed. Families have water and wages at the cost of their separate rooms.',
            'Семьи вынесли вещи из подвала на чердак до открытия чистого родникового канала. Промывка работает, загрязнённый колодец закрыт. Вода и заработок есть, отдельных комнат больше нет.',
            'The channel is running clear. Six families in one loft, so there’s plenty of noise. At least they’re keeping their supper down. The old well stays covered.',
            'По каналу идёт чистая вода. На одном чердаке шесть семей, шум стоит страшный. Зато ужин уже не выворачивает обратно. Старый колодец пока закрыт.',
            { lanterns: 2, registry: 1, commons: -1 }),
        ]),
    ],
  },
  {
    id: 'bell-metal', kind: 'side', requires: null, reward: 35,
    title: text('Enough Bronze for Three', 'Бронзы на три колокола'),
    description: text(
      'Radek has bronze for one heavy crossing bell or three smaller village bells. Inspect the stored metal before anyone mistakes old cracks for a good bargain.',
      'У Радека хватит бронзы на один тяжёлый дорожный колокол или на три малых деревенских. Проверить металл на складе: трещины в старой отливке легко не заметить.'),
    unresolved: text(
      'The bronze remains in storage. Radek cannot promise three village bells, and no one has agreed to collect or tend them.',
      'Бронза остаётся на складе. Радек не обещает три деревенских колокола: некому ни забрать их, ни отвечать за уход.'),
    stages: [
      talk('radek', 'Ask Radek at the Bell Foundry about the unfinished bells.', 'Расспросить Радека на Колокольном дворе о неотлитых колоколах.',
        'Three villages paid deposits on funeral bells. Then the garrison offered to buy one big warning bell out of the same bronze. I haven’t promised the metal twice. I haven’t seen all of it yet. The returned pieces are in the Sealed Vault. Tap the crowns, not the skirts. It’s the part that holds the weight I need to know about.',
        'Три деревни внесли задаток на погребальные колокола. Потом гарнизон предложил выкупить эту бронзу под один большой сигнальный. Дважды я её не обещал. Я ещё не всю видел. Возвращённые части в Опечатанном подвале. Простучи короны, не края. Мне важно, что будет держать вес.',
        [action('bell-start', 'I’ll examine the stored pieces before you choose a casting.',
          'Осмотрю складские отливки, прежде чем ты выберешь форму.',
          'Radek needs the stored bronze checked. The same stock could make one strong crossing bell or three small bells, but cracked crowns cannot simply be rehung.',
          'Радеку нужно проверить бронзу на складе. Из запаса выйдет один большой дорожный колокол либо три малых. Старые отливки с треснувшими коронами просто так не повесишь.',
          'Vesk has the key and the weights. If he quotes the total without the iron, ask him to weigh it again.',
          'Ключ и вес у Веска. Если назовёт общий вес, не вычтя железо, попроси перевесить.')]),
      inspect('tax-vault', 'bell-lien',
        'Inspect the stored bell bronze in the Sealed Vault.', 'Осмотреть колокольную бронзу в Опечатанном подвале.',
        'Hairline cracks run through the old bell crowns beneath the soot. Striking them gives a dull double note. Once the iron yokes and ruined fittings are deducted, Radek’s chalk estimates fit: three small recast bells or one heavy bell with a spare clapper. The village deposits are separate from the unsigned garrison offer. The shortage is real, not a duplicate sale.',
        'Под копотью в старых коронах видны тонкие трещины. При ударе — глухой раздвоенный звук. Если вычесть железные подвесы и негодные крепления, расчёт Радека верен: три малых колокола после переплавки либо один тяжёлый с запасным языком. Деревенские задатки хранятся отдельно от неподписанного предложения гарнизона. Металла действительно мало; двойной продажи не было.'),
      talk('vesk', 'Ask Vesk who will accept the bell stock’s release.', 'Узнать у Веска, на каких условиях выдадут бронзу.',
        'The villagers own the deposits, not the castings. They agreed to take their money back if Radek chooses the heavy bell. If he casts three, each village must collect its own and maintain the hanging. I can release the bronze under either set of receipts. I can’t pay for ropes they forget to replace.',
        'Деревенские внесли задатки, отливки ещё не их. Они согласились забрать деньги, если Радек выберет тяжёлый колокол. Если отольёт три, каждая деревня должна вывезти свой и следить за подвесом. Под оба расчёта я могу выдать бронзу. Платить за верёвки, которые они забудут сменить, не могу.',
        [action('bell-witness', 'I’ll give Radek the actual weights and both terms.',
          'Передам Радеку настоящий вес и оба условия.',
          'Vesk confirms that either casting is possible with the owners’ consent. Three bells require collection and continued local care; the large bell serves one busy crossing instead.',
          'Веск подтвердил: владельцы согласны на любой из двух расчётов. Три колокола нужно вывезти и постоянно содержать на местах. Большой будет служить одному людному переезду.',
          'Good. Ask him to put the soundness of the metal in writing. I don’t want another cracked crown on this shelf.',
          'Хорошо. Пусть распишется за прочность металла. Ещё одной треснувшей короны на этой полке я не хочу.')]),
      talk('radek', 'Discuss the two castings with Radek.', 'Обсудить с Радеком две отливки.',
        'Three small bells will carry between nearby watches, if people keep the ropes and salt in order. I can cast them to the Old Cloister fittings. The heavy one will sound farther from a single crossing and need fewer hands, but the outlying houses won’t hear it. I won’t sell either as protection without someone there to ring it.',
        'Три малых колокола перекликнутся между ближними дозорами, если люди будут следить за верёвками и солью. Могу отлить под крепления Старого скита. Тяжёлый слышно дальше от одного переезда, людей для него нужно меньше. Но дальним домам звон не достанется. Без дежурного у верёвки я ни один защитой не назову.',
        [
          action('bell-mourn', 'Cast the three village bells. I’ll carry your terms to anyone asking for them.',
            'Отлей три деревенских. Я передам твои условия всем, кто на них рассчитывает.',
            'Radek cast the three small bells and set them aside for the villages. They can support separate watches using the Old Cloister fittings, but they still need willing keepers and a secured delivery route.',
            'Радек отлил три малых колокола и отложил для деревень. Они подойдут к старым креплениям скита и отдельным дозорам. Ещё нужны добровольные смотрители и безопасный путь доставки.',
            'Three sound crowns. I’ve tested each one. They’re waiting for the watches and the wagons now. Tell Elin I kept to the old measurements; tell everyone else to bring dry rope.',
            'Три целых короны. Каждую проверил. Теперь ждём дозоры и повозки. Элину передай: старые размеры выдержал. Остальным — пусть везут сухую верёвку.',
            { commons: 3, lanterns: 1, registry: -1 }),
          action('bell-road', 'Cast the heavy crossing bell. Return the village deposits in full.',
            'Отлей тяжёлый дорожный колокол. Деревням верни весь задаток.',
            'Radek cast one heavy bell for the busy crossing and returned the village deposits. Its single watch cannot replace the three separate watches required to free the road from one central binding.',
            'Радек отлил тяжёлый колокол для людного переезда, деревням вернули задатки. Один дозор не заменит три отдельных, нужных для освобождения тракта от единой привязи.',
            'The heavy bell rings true. The deposit money has gone back. It will do a useful job at one crossing. Not three jobs in three villages.',
            'Тяжёлый звучит чисто. Задатки отдали. На одном переезде он своё дело сделает. За три деревни не отзвонит.',
            { registry: 3, commons: -1, lanterns: -1 }),
        ],
        [
          remembered('stag-dependents',
            'Yara wrote about her rota and the meals for dependents. That is the first offer of keepers I can put a casting against. Three small bells would suit their shared watches and the Old Cloister fittings. One heavy bell serves a single crossing better. Choose the use before I pour; I can’t turn one into three afterward.',
            'Яра написала про очередь дежурств и еду для семей. Впервые есть смотрители, под которых можно лить. Три малых колокола подойдут к их общим дозорам и старым креплениям скита. Один тяжёлый лучше послужит одному переезду. Определиться нужно до заливки. После из одного три не сделаешь.'),
          remembered('stag-secret',
            'I heard the families kept their bell. Fair enough, but that leaves Yara without a shared watch. I can still cast three village bells, if someone later finds willing keepers, or one heavy bell for the busy crossing. Metal won’t decide who gets up in the night.',
            'Слышал, семьи оставили колокол себе. Их дело, только у Яры теперь нет общего дозора. Могу отлить три деревенских, если потом найдутся добровольцы, или один тяжёлый для людного переезда. Бронза не решит за людей, кому вставать ночью.'),
        ]),
    ],
  },
  {
    id: 'last-beacon', kind: 'side', requires: null, reward: 35,
    title: text('Three Pairs of Boots', 'Три пары сапог'),
    description: text(
      'The keeper of the Frozen Beacon was buried in spring, yet someone still tends its light. Lev wants to know who is burning the monastery’s oil.',
      'Смотрителя Замёрзшего маяка похоронили весной, но огонь до сих пор горит. Лев хочет узнать, кто расходует монастырское масло.'),
    unresolved: text(
      'The monastery keeps sending oil to an unanswered post. Whoever tends the beacon has no promise of another winter’s supplies.',
      'Монастырь продолжает слать масло на пост, откуда не отвечают. Тем, кто держит огонь, никто не обещал припасов на следующую зиму.'),
    stages: [
      talk('lev', 'Ask Lev at Star Monastery about the beacon keeper.', 'Расспросить Льва в Звёздном монастыре о смотрителе маяка.',
        'I buried the keeper in spring. Oil still disappears from the supply shelf, and the light still turns in bad weather. No request for wages, no name on the tally. Before someone sends a patrol to stop a theft, would you see who’s up there? A stolen jar is cheaper than a dead traveler.',
        'Смотрителя я похоронил весной. Масло с полки припасов всё ещё забирают, огонь в непогоду работает. Жалованья не просят, имя на счёте не ставят. Посмотри, кто там, прежде чем пошлют дозор пресекать кражу. Банка масла дешевле похорон путника.',
        [action('beacon-start', 'I’ll inspect the watch before anyone cuts off its oil.',
          'Проверю пост, прежде чем ему перекроют масло.',
          'Someone continues the dead keeper’s work without claiming wages. Lev wants the watch identified before it is treated merely as theft.',
          'Кто-то продолжает работу покойного смотрителя и не просит платы. Лев хочет разобраться с дозором, пока всё не свели к краже масла.',
          'Look at the wick trimmings. A lamp left alone burns badly. If they’re fresh, someone is doing the job.',
          'Посмотри, как подрезаны фитили. Без ухода лампа коптит. Если срезы свежие, значит, кто-то работает.')]),
      inspect('frozen-beacon', 'beacon-log',
        'Inspect the living quarters and lamp at the Frozen Beacon.', 'Осмотреть жилой угол и лампу Замёрзшего маяка.',
        'The wicks are neatly trimmed. Three sets of wet boots dry beside narrow bunks; army patches have been cut from the coats above them. The watch tally changes hand every four hours. A rescuer’s rope is abraded where it ran over ice, and a child’s mitten is drying beside it. Three people are working here. Cut patches suggest desertion, but do not explain why they left.',
        'Фитили аккуратно подрезаны. У узких нар три пары мокрых сапог; на висящих сверху шинелях срезаны армейские нашивки. Почерк в записях дежурств меняется каждые четыре часа. Спасательная верёвка потёрта там, где тёрлась о лёд, рядом сушится детская варежка. Здесь работают трое. Срезанные нашивки похожи на следы дезертирства, но не объясняют, почему люди ушли.'),
      talk('nika', 'Ask Nika at High Pass who tends the beacon.', 'Узнать у Ники на Высоком перевале, кто следит за маяком.',
        'I’ve seen all three. Two hauled a boy out of a drift while the third kept the light. They left Raut’s unit after an order to strip salt from occupied houses. That part is their account; the rescue I saw myself. They’ll sign a petition if Lev stands surety. They won’t walk unguarded into the barracks.',
        'Видела всех троих. Двое вытаскивали мальчишку из сугроба, третий держал огонь. Ушли из отряда Раута после приказа забрать соль из жилых домов. Это с их слов. А спасение видела сама. Если Лев поручится, прошение подпишут. Без охраны в казарму не пойдут.',
        [action('beacon-witness', 'I’ll ask Lev to stand surety and include what you actually witnessed.',
          'Попрошу Льва поручиться. Твои показания отделим от их рассказа.',
          'Nika witnessed the three keepers rescuing a child. Their reason for desertion remains their own testimony. They consent to a public petition if Lev will stand surety.',
          'Ника видела, как трое смотрителей спасали ребёнка. О причине дезертирства пока известно только с их слов. Они согласны подписать открытое прошение, если Лев поручится.',
          'I’ll sign for the boy and the rope. Not for battles I wasn’t at. That should still count for something.',
          'За мальчишку и верёвку подпишусь. За бои, где меня не было, — нет. И этого должно чего-то стоить.')]),
      talk('lev', 'Discuss the keepers’ future with Lev.', 'Обсудить со Львом будущее смотрителей.',
        'I can stand surety and ask for civilian service in place of punishment. I cannot grant a pardon, and neither can you. Their names will be posted where officers can read them. Or the Candlekeepers can keep bringing oil quietly, and the three stay hidden. The light gets tended either way; only one lets them ask to come down.',
        'Я могу поручиться и просить гражданскую службу вместо наказания. Помиловать не могу. Ты тоже. Их имена вывесим там, где прочтут и офицеры. Или Свечники будут тихо носить масло, а трое останутся в укрытии. Огонь будет в обоих случаях. Только в одном они смогут просить разрешения спуститься.',
        [
          action('beacon-amnesty', 'Stand surety. I’ll add Nika’s account and escort their petition, not promise a pardon.',
            'Поручись. Я приложу показания Ники и провожу прошение, но помилования обещать не буду.',
            'Lev publicly stood surety for the three keepers and petitioned for civilian service. Their names and Nika’s account are available to witnesses. No captain’s word has erased their charges.',
            'Лев открыто поручился за троих смотрителей и просит оставить их на гражданской службе. Имена и показания Ники доступны свидетелям. Слово капитана не сняло обвинений.',
            'Their petition hangs here with my name beneath theirs. The oil is counted openly now. They’re staying at the light while we wait for an answer.',
            'Прошение висит здесь, моё имя под их именами. Масло теперь выдаём открыто. Пока ждём ответа, они остаются при огне.',
            { commons: 2, registry: 1, lanterns: -1 }),
          action('beacon-hidden', 'Keep their names private. Ask the Candlekeepers to keep the oil coming.',
            'Сохрани их имена в тайне. Пусть Свечники продолжают носить масло.',
            'Lev arranged quiet supplies through the Candlekeepers. The beacon remains tended, but its keepers still cannot visit the settlements without risking arrest.',
            'Лев устроил тайные поставки через Свечников. За маяком следят, но смотрители по-прежнему рискуют арестом, если спустятся в поселения.',
            'The oil goes up with the Candlekeepers. Three bowls come back scraped clean. I wish I could offer those people a place at this table as safely.',
            'Масло уносят Свечники. Обратно возвращают три миски, выскобленные дочиста. Хотел бы я так же безопасно усадить этих людей за наш стол.',
            { lanterns: 3, registry: -1, commons: -1 }),
        ]),
    ],
  },
  {
    id: 'borrowed-name', kind: 'side', requires: null, reward: 35,
    title: text('The Scarf That Came Back', 'Вернувшийся платок'),
    description: text(
      'Mila brought a dead friend’s scarf to Hollow Village and stayed in her place. Now a familiar voice calls outside the house at night.',
      'Мила принесла в Глухую деревню платок погибшей подруги и осталась вместо неё. Теперь по ночам за дверью зовёт знакомый голос.'),
    unresolved: text(
      'Mila stays in the household under the dead girl’s pet name. The two women still have not spoken plainly about the grave.',
      'Мила остаётся в доме под домашним именем погибшей девушки. Две женщины так и не поговорили прямо о могиле.'),
    stages: [
      talk('mila', 'Hear Mila’s request in Hollow Village.', 'Выслушать просьбу Милы в Глухой деревне.',
        'Alya died on the road. I brought her scarf to her mother. The fever had left the old woman weak; she saw it on my shoulders and called me by Alya’s pet name. I stayed to nurse her. Never corrected her properly. Now Alya’s voice calls outside. Her mother left a bundle at the Echo Well. Please see whether it’s meant for a living girl or a dead one.',
        'Аля умерла в дороге. Я принесла её платок матери. Старуха после лихорадки была слабая. Увидела платок у меня на плечах, назвала меня, как дома звала Алю. Я осталась ухаживать. Толком так и не поправила. Теперь за дверью зовёт голос Али. Мать отнесла свёрток к Колодцу эха. Посмотри, пожалуйста: она его живой дочери оставила или мёртвой?',
        [action('borrowed-start', 'I’ll look at the bundle. Keep the door closed, even if the voice sounds kind.',
          'Посмотрю свёрток. Дверь не открывай, даже если голос ласковый.',
          'Mila has been nursing her dead friend’s mother while answering to a familiar pet name. She fears the older woman has mistaken the Caller for her daughter. The bundle at the well may clarify what she believes.',
          'Мила ухаживает за матерью погибшей подруги и отзывается на её домашнее имя. Она боится, что старуха приняла Оклик за дочь. Свёрток у колодца может показать, что та понимает.',
          'The door stays barred. I tell her it’s cold. She tells me she knows. I don’t know which of us thinks that fools anyone.',
          'Дверь на засове. Говорю ей: холодно. Она отвечает: знаю. Не понимаю, которая из нас надеется хоть кого-то этим обмануть.')]),
      inspect('name-well', 'borrowed-bowls',
        'Examine the wrapped offerings beside the Echo Well.', 'Осмотреть свёрток с подношениями у Колодца эха.',
        'The bundle contains a candle tied with Alya’s hair ribbon and a pair of newly knitted mittens. The candle paper reads “For Alya’s grave”; the mittens are wrapped in a note: “Mila, these should fit this time.” There is no food for a returning traveler. The mother knows who died and who is living in her house. The voice outside has not changed that.',
        'В свёртке свеча, перевязанная лентой Али, и свежесвязанные рукавицы. На бумаге от свечи: «На могилу Али». В рукавицах записка: «Мила, эти должны быть по руке». Еды для возвращающегося путника нет. Мать знает, кто умер и кто живёт в её доме. Голос за дверью этого не изменил.'),
      talk('mila', 'Tell Mila what the bundle contained.', 'Рассказать Миле, что было в свёртке.',
        'She measured my hand while I slept. I thought she was checking my fever. So she knows, and neither of us can bring ourselves to say it. I can ask her to call me Mila. Or let the old pet name stay between us, if we finally speak about whose grave the candle goes to. She may cry all night. I’ve been avoiding that more than the truth.',
        'Она мерила мою ладонь, пока я спала. Я думала, жар проверяет. Значит, знает. И ни одна из нас не решается сказать. Могу попросить звать меня Милой. Или оставить домашнее имя между нами — только поговорить наконец, на чью могилу понесём свечу. Она, наверное, всю ночь проплачет. Я этого больше правды боялась.',
        [
          action('borrowed-restore', 'Ask her to use Mila. Take the candle together; you don’t have to leave her.',
            'Попроси звать тебя Милой. Свечу отнесите вместе. Уходить от неё тебе не нужно.',
            'Mila and the older woman spoke plainly about Alya’s death and began using Mila’s own name at home. They remain together. Naming the loss brought grief back into the room; it did not undo it.',
            'Мила и старуха прямо поговорили о смерти Али. Дома Милу теперь зовут своим именем. Они остались вместе. Названная вслух потеря вернула в дом слёзы, но никуда не исчезла.',
            'She called me Mila over breakfast. Then cried into the porridge. I stayed. The mittens fit, by the way.',
            'За завтраком назвала меня Милой. Потом заплакала прямо в кашу. Я осталась. Рукавицы, кстати, по руке.',
            { commons: 2, lanterns: 1 }),
          action('borrowed-keep', 'Keep the pet name if you both want it. But tell her whose candle you’re carrying.',
            'Оставьте домашнее имя, если обеим нужно. Только скажи, чью свечу несёшь.',
            'Mila and the mother acknowledged Alya’s death but kept the household pet name. They know not to answer the voice outside. Their private comfort remains difficult to explain to neighbors.',
            'Мила и мать признали смерть Али, но оставили домашнее имя. Они знают, что голосу за дверью отвечать нельзя. Соседям их утешение по-прежнему трудно объяснить.',
            'We’ve spoken about the grave. She still uses the old name sometimes. I answer her when she’s beside me, not when something calls through the door. The neighbors can ask if they want to know.',
            'Про могилу поговорили. Иногда она всё ещё зовёт по-старому. Отвечаю, когда она рядом. Не когда кто-то зовёт из-за двери. Соседям надо знать — пусть спросят.',
            { lanterns: 2, commons: -1 }),
        ]),
    ],
  },
];

export const NPCS: StoryNpc[] = [
  {
    id: 'mara', locationId: 'roadward', name: text('Mara Venn', 'Мара Венн'),
    role: text('Convoy owner', 'Хозяйка обоза'), faction: 'guard',
    activity: text('Setting aside the absent drivers’ wages', 'Откладывает жалованье пропавших возчиков'),
    greeting: text(
      'You’re the captain? Good. Leave your boasts with the horse. I need someone who can get carts home.',
      'Ты капитан? Хорошо. Похвальбу оставь вместе с лошадью. Мне нужен человек, который доведёт телеги домой.'),
    localQuestion: text('What has to be secured before the convoy can get through?', 'Что нужно закрепить, чтобы обоз прошёл?'),
    local: text(
      'The Roadward Inn is our base in the Heartlands. Take two road posts, then bring the convoy close enough to supply each garrison. Break the enemy caravan as well. With the posts stocked and that raiding force gone, you can reach the fortress. Don’t mistake taking a post for feeding it.',
      'Трактовый двор — наша база в Срединных землях. Возьми две дорожные заставы, потом подведи обоз и снабди каждый гарнизон. Вражеский караван тоже нужно разбить. Когда на заставах будут припасы, а налётчиков не станет, доберёшься до крепости. Захватить пост и прокормить его — разные дела.'),
    beliefQuestion: text('Why keep the missing drivers’ pay separate?', 'Зачем отдельно хранить плату пропавших возчиков?'),
    belief: text(
      'Because if I leave it in the strongbox, sooner or later I’ll call it repair money. Three purses are harder to spend by mistake.',
      'Если оставлю в общей кассе, рано или поздно назову деньгами на ремонт. Три отдельных кошеля труднее потратить по ошибке.'),
    reactions: [{
      after: 'road-names',
      text: text(
        'So Ada buried all three. Leave her notes with me. I’ll tell the families myself. They have been setting places at supper; they need to stop waiting. The three purses are ready. You found what I asked for, captain. Give me a moment before we talk about the wagons.',
        'Значит, Ада похоронила всех троих. Записи оставь мне. Семьям скажу сама. Они до сих пор оставляют места за ужином — больше ждать им не надо. Три кошеля готовы. Ты сделал, о чём я просила, капитан. Дай мне немного посидеть, потом поговорим о телегах.'),
    }],
  },
  {
    id: 'toman', locationId: 'greenhollow', name: text('Toman Reed', 'Томан Рид'),
    role: text('Miller and village headman', 'Мельник и староста'), faction: 'elf',
    activity: text('Splicing a worn bell rope', 'Сращивает истёртую колокольную верёвку'),
    greeting: text(
      'Wait there a moment. If I let this knot go, we start again. All right. Who sent you?',
      'Подожди немного. Отпущу этот узел — придётся начинать сначала. Всё. Кто тебя прислал?'),
    localQuestion: text('Why is the mill open after dark?', 'Почему мельница открыта после темноты?'),
    local: text(
      'Greenhollow takes people in when they miss the last safe stretch. The mill has dry floors and enough room to spread a blanket. The Old Orchard is beyond our tended boundary. In Greenmarch, distances on a map don’t tell you where you can sleep.',
      'В Зелёной лощине принимают тех, кто не успел пройти последний безопасный отрезок. На мельнице сухо и можно расстелить одеяло. Старый сад уже за нашей охраняемой полосой. В Зелёном пограничье расстояние на карте ещё не говорит, где удастся переночевать.'),
    beliefQuestion: text('Do you ever leave someone outside when the mill is full?', 'Когда мельница полна, кого-нибудь оставляешь снаружи?'),
    belief: text(
      'I put them where the flour ought to be. Then I ask the farmers for another dry shed. They swear at me. So far, they’ve always found one.',
      'Кладу там, где должна быть мука. Потом прошу у хозяев ещё один сухой сарай. Ругаются. Пока всегда находили.'),
  },
  {
    id: 'lida', locationId: 'greenhollow', name: text('Lida Ash', 'Лида Эш'),
    role: text('Orchard keeper', 'Садовница'), faction: 'elf',
    activity: text('Binding a split graft', 'Обвязывает треснувшую прививку'),
    greeting: text(
      'Not that branch. It only looks strong. Here, hold the twine if you want to talk.',
      'Не эту ветку. Она только выглядит крепкой. На, подержи бечёвку, если поговорить хочешь.'),
    localQuestion: text('Why keep tending trees that no longer bear?', 'Зачем ухаживать за деревьями, которые не плодоносят?'),
    local: text(
      'The older row breaks the wind for the younger one. I know which branches can go and which will bring a tree down. You can’t learn that by looking at the fruit for one summer.',
      'Старый ряд закрывает молодой от ветра. Я знаю, какие ветви можно снять, а какие уронят дерево. За одно лето, пока считаешь яблоки, этого не поймёшь.'),
    beliefQuestion: text('Would you cut down a tree you planted yourself?', 'Срубила бы дерево, которое сама посадила?'),
    belief: text(
      'If it were going to fall on someone. I’ve done it. Kept a sound piece for a stool, burned the rot. Being fond of a tree doesn’t mend its trunk.',
      'Если оно на кого-нибудь упадёт — да. Уже рубила. Из здорового куска сделала табурет, гниль сожгла. От моей любви ствол не срастётся.'),
  },
  {
    id: 'yara', locationId: 'thornwatch', name: text('Yara of the Thorns', 'Яра Терновая'),
    role: text('Hunt warden', 'Старшая охотница'), faction: 'elf',
    activity: text('Taking wire snares off the path', 'Убирает с тропы проволочные силки'),
    greeting: text(
      'Mind your ankle. There was a snare here this morning. I found the wire; still looking for the fool who laid it.',
      'Смотри под ноги. Утром здесь был силок. Проволоку нашла. Дурака, который поставил, ещё ищу.'),
    localQuestion: text('What does Thornwatch watch besides hunters?', 'За кем Терновый дозор следит, кроме охотников?'),
    local: text(
      'People who cut across the woods to save half a day. The Stag Shrine used to be their shelter. There ought to be a bell and a person on watch there. “Ought to” is the trouble.',
      'За теми, кто срезает через лес ради половины дня. В Оленьем святилище раньше укрывались по пути. Там должен быть колокол и человек при нём. Вот это «должен» нас и подводит.'),
    beliefQuestion: text('Why not simply order every hunter to take a watch?', 'Почему не приказать всем охотникам дежурить?'),
    belief: text(
      'Because one has a sick husband and another feeds five children alone. Put them on a list without asking, and you’ll have a splendid list and an empty watch.',
      'У одной муж больной, другой один кормит пятерых детей. Впишешь, не спросив, — список получится отличный. Дежурить будет некому.'),
  },
  {
    id: 'sella', locationId: 'mirecross', name: text('Sella Brine', 'Селла Брайн'),
    role: text('River salvage diver', 'Речная ныряльщица'), faction: 'villain',
    activity: text('Picking grit from a salvage pulley', 'Вычищает песок из подъёмного блока'),
    greeting: text(
      'If you dropped it in the river, tell me how heavy before you tell me how precious.',
      'Если уронил в реку, сперва скажи, сколько весит. Потом — насколько дорого.'),
    localQuestion: text('Can anything still be recovered from the Drowned Archive?', 'Из Затопленного архива ещё можно что-нибудь достать?'),
    local: text(
      'The upper landings, yes. The lower floor shifts when the current changes. In the Fens, the water brings its own furniture. If a stair was sound yesterday, that’s yesterday’s news.',
      'С верхних площадок — да. Нижний пол шевелится, когда меняется течение. В Топях вода сама расставляет мебель. Если вчера ступень была цела, это вчерашние новости.'),
    beliefQuestion: text('Would you go under for something that cannot be sold?', 'Нырнёшь за вещью, которую не продать?'),
    belief: text(
      'I went under for a woman’s cooking pot once. Her son paid me in eggs for six weeks. He still brings one extra. Don’t tell anyone; I have a rate to maintain.',
      'Раз доставала женщине котелок. Её сын шесть недель платил яйцами. До сих пор одно лишнее приносит. Только не рассказывай, у меня расценки.'),
  },
  {
    id: 'ivet', locationId: 'reed-chapel', name: text('Sister Ivet', 'Сестра Ивета'),
    role: text('Chapel keeper and nurse', 'Смотрительница часовни и сиделка'), faction: 'guard',
    activity: text('Hanging washed bandages above the stove', 'Развешивает над печью выстиранные повязки'),
    greeting: text(
      'Wash your hands before touching anything. If you’re only here to talk, keep your voice below the coughing.',
      'Прежде чем что-нибудь трогать, вымой руки. Если только поговорить — говори тише кашля.'),
    localQuestion: text('What happens to the things brought in from the river?', 'Что вы делаете с вещами, принесёнными с реки?'),
    local: text(
      'We dry them, mark where they were found and keep them apart. A recovered coat is not proof its owner drowned. Ask me before taking anything from the shelf.',
      'Сушим, отмечаем, где нашли, храним отдельно. Выловленный кафтан ещё не значит, что хозяин утонул. Прежде чем брать с полки, спроси меня.'),
    beliefQuestion: text('How do you choose who gets the bed nearest the stove?', 'Как решаешь, кому дать кровать у печи?'),
    belief: text(
      'By touch. Cold fingers, poor breathing. People who can still argue about being moved usually aren’t first in need of it.',
      'На ощупь. Холодные пальцы, слабое дыхание. Кто ещё может ругаться из-за переселения, обычно нуждается не первым.'),
  },
  {
    id: 'oss', locationId: 'lantern-ferry', name: text('Oss Vale', 'Осс Вейл'),
    role: text('Ferryman', 'Паромщик'), faction: 'villain',
    activity: text('Scrubbing the ferry’s lowest step', 'Оттирает нижнюю ступень переправы'),
    greeting: text(
      'Step on the plank, not the rope. If you need to be sick, use the downstream side. I’ve just cleaned this one.',
      'На доску ступай, не на канат. Если замутит — наклонись по течению. С этой стороны я только вымыл.'),
    localQuestion: text('Why tie up the ferry before the water gets dark?', 'Зачем привязывать паром, пока вода ещё светлая?'),
    local: text(
      'Lantern Ferry has a crosscurrent you can see by day. After dark you only feel it when the boat turns. The shore bell warns of things on the bank; it doesn’t steer for you.',
      'На Фонарной переправе поперечное течение. Днём его видно, ночью чувствуешь только тогда, когда лодку уже разворачивает. Береговой колокол предупреждает о том, что на суше. Править за тебя не будет.'),
    beliefQuestion: text('Do you ever refuse a fare?', 'Бывает, отказываешь пассажиру?'),
    belief: text(
      'When the water reaches the second peg. Used to measure with my boot instead. The pegs don’t change their mind when someone offers more.',
      'Когда вода доходит до второго колышка. Раньше мерил сапогом. Колышки, в отличие от меня, не передумывают за лишнюю монету.'),
  },
  {
    id: 'orsa', locationId: 'saltmarket', name: text('Orsa Flint', 'Орса Флинт'),
    role: text('Grain factor', 'Зерноторговка'), faction: 'guard',
    activity: text('Checking the empty weight of a cargo sack', 'Проверяет вес пустого грузового мешка'),
    greeting: text(
      'Buying, selling, or asking why the price went up? I have different stools for each.',
      'Покупать, продавать или спрашивать, почему подорожало? Для каждого случая у меня свой табурет.'),
    localQuestion: text('Why send freight to the Tide Observatory to be weighed?', 'Зачем взвешивать груз в Приливной башне?'),
    local: text(
      'Saltmarket weighs the sale. The Tide Observatory weighs what a boat can actually lift without sinking. On the Salt Coast I prefer to compare the two before I pay for a missing half-ton.',
      'Соляной торг взвешивает товар при продаже. Приливная башня — груз, который судно может взять и не утонуть. На Соляном берегу лучше сверить обе цифры, прежде чем платить за пропавшие полтонны.'),
    beliefQuestion: text('Do you lend grain to people who might not repay it?', 'Даёшь зерно в долг тем, кто может не вернуть?'),
    belief: text(
      'Seed, sometimes. Supper, I call a gift if I can afford it. Calling a gift a loan makes people hide from you at the worst possible time.',
      'Семена — иногда. Еду, если могу себе позволить, просто дарю. Назовёшь подарок долгом — от тебя начнут прятаться как раз тогда, когда не надо.'),
  },
  {
    id: 'dren', locationId: 'wreckers-rest', name: text('Dren Silt', 'Дрен Силт'),
    role: text('Salvage crew leader', 'Старший подъёмной команды'), faction: 'villain',
    activity: text('Sorting wet sailcloth from cargo covers', 'Отделяет мокрые паруса от грузовых покрытий'),
    greeting: text(
      'If you’re from the ship, there’s a dry corner left. If you’re here for cargo, take a number like everyone else.',
      'Если с судна — сухой угол ещё найдётся. Если за грузом — вставай в очередь, как все.'),
    localQuestion: text('How did your crew reach the wreck through the breakers?', 'Как ваша команда добралась до судна через прибой?'),
    local: text(
      'Ropes from the rocks. Boats would have rolled before we reached it. Wreckers’ Rest keeps shore gear for that. We don’t get to choose whether the sea leaves us men or cargo first.',
      'По канатам со скал. Лодки перевернуло бы раньше. В Приюте корабельщиков на такой случай держат береговое снаряжение. Не нам выбирать, что море отдаст первым — людей или груз.'),
    beliefQuestion: text('When do you stop looking for a missing sailor?', 'Когда перестаёте искать пропавшего моряка?'),
    belief: text(
      'When a rope team can’t stand upright anymore. I send another if I have one. Anyone who promises never to stop has never had to send people out.',
      'Когда люди на канате уже на ногах не держатся. Если есть смена, посылаю смену. Кто обещает никогда не прекращать поиски, тот ни разу не посылал людей.'),
  },
  {
    id: 'hana', locationId: 'tide-observatory', name: text('Hana Pell', 'Хана Пелл'),
    role: text('Tide and signal keeper', 'Смотрительница приливов и огней'), faction: 'elf',
    activity: text('Scraping salt spray from a lamp shutter', 'Счищает соляные брызги со створки фонаря'),
    greeting: text(
      'Don’t lean on the bracket. It took an hour to set that bearing. You can lean on the wall; it’s less particular.',
      'На кронштейн не опирайся. Я час выставляла направление. На стену можно, она не такая капризная.'),
    localQuestion: text('Can a ship mistake a house lamp for a channel light?', 'Судно может принять огонь в доме за створный?'),
    local: text(
      'One light gives a direction. Two aligned lights suggest a channel. That’s why spare red lenses stay locked away, and why I write down the bearing before I turn any screw.',
      'Один огонь даёт направление. Два в створе указывают проход. Поэтому запасные красные линзы под замком, а перед поворотом винта я записываю направление.'),
    beliefQuestion: text('What do you put in the log when you aren’t certain?', 'Что пишешь в журнале, если не уверена?'),
    belief: text(
      'What I saw, then what kept me from seeing the rest. Fog, distance, a blocked lens. An empty gap is better than a confident guess someone will navigate by.',
      'Что видела. Потом — что помешало увидеть остальное. Туман, расстояние, закрытая линза. Лучше оставить пропуск, чем уверенную догадку, по которой кто-нибудь поведёт судно.'),
  },
  {
    id: 'beran', locationId: 'cinderwell', name: text('Beran Coalhand', 'Беран Угольная Рука'),
    role: text('Glass founder', 'Мастер стеклянной плавки'), faction: 'villain',
    activity: text('Brushing cooled slag off his leather apron', 'Счищает остывший шлак с кожаного передника'),
    greeting: text(
      'Behind the chalk mark. The floor looks cold because the heat is underneath it. Now, what broke?',
      'За меловую черту. Пол только выглядит холодным, жар под ним. Так, что разбилось?'),
    localQuestion: text('Where do you test a new casting?', 'Где проверяешь новую отливку?'),
    local: text(
      'At the Glass Quarry. There’s room around the cold furnace to compare rejects without anyone carrying molten work past your elbow. The Ash Steppe has plenty of open ground; we still manage to burn ourselves in the crowded bit.',
      'В Стеклянном карьере. У холодной печи можно сравнить брак, и никто не пронесёт расплав у тебя под локтем. В Пепельной степи земли сколько угодно, а обжигаемся всё равно в тесноте.'),
    beliefQuestion: text('Why keep flawed castings instead of melting them again?', 'Зачем хранить брак, а не плавить заново?'),
    belief: text(
      'So the apprentice can see where the crack started. Melt it at once and he’ll make the same mistake with twice the material. I mark my own failures too.',
      'Чтобы ученик увидел, откуда пошла трещина. Сразу переплавишь — он повторит ошибку на вдвое большей партии. Свой брак я тоже помечаю.'),
  },
  {
    id: 'tessa', locationId: 'cinderwell', name: text('Tessa Rill', 'Тесса Рилл'),
    role: text('Village healer', 'Деревенская лекарка'), faction: 'elf',
    activity: text('Labeling stoppered water jars', 'Подписывает закупоренные банки с водой'),
    greeting: text(
      'If you’re hurt, sit. If you’re here to explain a curse to me, hold that jar while you do it.',
      'Ранен — садись. Пришёл объяснять мне проклятие — подержи банку, пока объясняешь.'),
    localQuestion: text('What are you comparing in those jars?', 'Что ты сравниваешь в этих банках?'),
    local: text(
      'Water from different households and different days. People tell me it all comes from one hill. The Ash Cairn marks where the channels divide. One hill can still give you very different cups.',
      'Воду из разных домов за разные дни. Мне говорят: всё с одного склона. Пепельный курган стоит там, где расходятся каналы. С одного склона в кружки может попасть разное.'),
    beliefQuestion: text('How do you tell sickness from the Caller’s work?', 'Как отличаешь болезнь от того, что делает Оклик?'),
    belief: text(
      'I ask what they ate, drank and heard, and who else is ill. I check what changes when I change one thing. The Caller exists. That doesn’t excuse me from checking the water.',
      'Спрашиваю, что ели, пили и слышали, кто ещё болен. Меняю что-нибудь одно, смотрю на результат. Оклик существует. Воду из-за этого можно не проверять, что ли?'),
  },
  {
    id: 'vesk', locationId: 'crownbridge', name: text('Auditor Vesk', 'Ревизор Веск'),
    role: text('Garrison stores auditor', 'Ревизор гарнизонных складов'), faction: 'guard',
    activity: text('Weighing returned fittings separately from their crates', 'Взвешивает возвращённые крепления без ящиков'),
    greeting: text(
      'Put it on the empty side of the desk, please. The other side is counted. I’d like one side of something to remain counted.',
      'Положи на свободную сторону стола, пожалуйста. На другой уже посчитано. Хотелось бы хоть на одной стороне сохранить порядок.'),
    localQuestion: text('What do you keep in the Sealed Vault?', 'Что хранится в Опечатанном подвале?'),
    local: text(
      'Returned stores, disputed deliveries, pieces too valuable to throw out. Crownbridge receives all three. Crownlands looks tidy on a map because the map leaves out the storerooms.',
      'Возвращённые припасы, спорные поставки, обломки, которые жалко выбросить. Коронный мост принимает всё сразу. Коронные земли на карте выглядят аккуратно, потому что складов на ней нет.'),
    beliefQuestion: text('Why keep a damaged fitting after its cost has been entered?', 'Зачем хранить сломанное крепление, если его цену уже записали?'),
    belief: text(
      'A figure tells you the replacement cost. The part can tell you whether it wore out, was cut, or was never sound. Those are different questions, even when the total is the same.',
      'Цифра скажет, сколько стоит замена. Деталь — износилась она, её срезали или она с самого начала была негодной. Это разные вопросы, даже если сумма одна.'),
  },
  {
    id: 'radek', locationId: 'bell-foundry', name: text('Radek Noll', 'Радек Нолл'),
    role: text('Bell founder', 'Колокольный мастер'), faction: 'guard',
    activity: text('Testing a bell crown with a small hammer', 'Простукивает корону колокола малым молотком'),
    greeting: text(
      'Wait for the ring to die. There. Ask now. I can either listen to the bronze or listen to you.',
      'Подожди, пока отзвенит. Вот. Теперь спрашивай. Я могу слушать либо бронзу, либо тебя.'),
    localQuestion: text('Can you mend a cracked bell without recasting it?', 'Треснувший колокол можно починить без переплавки?'),
    local: text(
      'Sometimes a skirt. Not a split crown that has to carry the whole weight. At the Bell Foundry we keep the failed crowns on view. It discourages people from hanging bells with repairs they made in a hurry.',
      'Иногда — край. Лопнувшую корону, на которой весь вес, — нет. На Колокольном дворе мы держим такой брак на виду. Чтобы люди не вешали колокола после ремонта на скорую руку.'),
    beliefQuestion: text('Does a fine bell protect a village by itself?', 'Хороший колокол сам по себе защитит деревню?'),
    belief: text(
      'No. Someone checks the rope, clears the ice and takes the night turn. The bronze is my work. I make that part sound and tell them plainly what is theirs.',
      'Нет. Кто-то проверяет верёвку, счищает лёд, встаёт ночью. Бронза — моя работа. Её делаю как надо и прямо говорю, что остаётся людям.'),
  },
  {
    id: 'nika', locationId: 'high-pass', name: text('Nika Frost', 'Ника Фрост'),
    role: text('Pass guide', 'Проводница'), faction: 'elf',
    activity: text('Resetting a snow marker above the drift line', 'Переставляет веху выше края сугроба'),
    greeting: text(
      'You’ve still got feeling in your toes? Check before you answer. People like to be brave about the wrong things up here.',
      'Пальцы на ногах чувствуешь? Проверь, прежде чем ответить. Здесь любят храбриться как раз там, где не надо.'),
    localQuestion: text('Can the Frozen Beacon be trusted in this weather?', 'В такую погоду можно полагаться на Замёрзший маяк?'),
    local: text(
      'It gives a bearing, not a path. Follow the markers through High Pass even when the light looks close. Frostspine folds the ground between you and it into places you can’t see until you’re in them.',
      'Он даёт направление, не тропу. На Высоком перевале держись вех, даже если огонь кажется близким. Инейный хребет прячет между тобой и маяком такие провалы, что увидишь только оказавшись внутри.'),
    beliefQuestion: text('Have you ever dragged someone back who begged to go on?', 'Приходилось тащить назад человека, который просил идти дальше?'),
    belief: text(
      'Often. Cold makes people certain there’s a warm house just below the next ledge. A familiar voice can do worse. Get them somewhere sheltered first. Argue once they can feel their hands.',
      'Часто. На холоде люди уверены, что тёплый дом сразу под следующим уступом. Знакомый голос может сделать ещё хуже. Сперва утащи в укрытие. Спорить будете, когда руки отогреет.'),
  },
  {
    id: 'lev', locationId: 'star-monastery', name: text('Brother Lev', 'Брат Лев'),
    role: text('Monastery steward', 'Монастырский хозяйственник'), faction: 'guard',
    activity: text('Dividing lamp oil into carrying jars', 'Разливает лампадное масло по походным банкам'),
    greeting: text(
      'There’s hot water, if that helps. Tea when the next delivery arrives. We’ve been saying that for a while.',
      'Есть горячая вода, если годится. Чай будет со следующей поставкой. Мы это уже давно говорим.'),
    localQuestion: text('Why keep old ward fittings alongside the books?', 'Зачем хранить старые крепления защиты рядом с книгами?'),
    local: text(
      'Star Monastery copied the maintenance instructions, but drawings don’t show every kind of wear. The used parts stay beside them. Ask to compare both before deciding a sketch is complete.',
      'В Звёздном монастыре переписывали наставления по уходу, но не всякий износ попадёт на чертёж. Поэтому снятые детали храним рядом. Прежде чем верить полноте рисунка, сравни и то и другое.'),
    beliefQuestion: text('How much does it cost you to stand surety for someone?', 'Чего тебе стоит поручиться за человека?'),
    belief: text(
      'A bed if they need one. Oil, if they’re working a lamp. My name if they’re accused. I try to find out which of those I’m promising before I sign.',
      'Койки, если нужна койка. Масла, если он при лампе. Моего имени, если его обвиняют. Прежде чем подписывать, стараюсь понять, что именно обещаю.'),
  },
  {
    id: 'ada', locationId: 'hollow-village', name: text('Ada Wren', 'Ада Ренн'),
    role: text('Village burial keeper', 'Смотрительница деревенских могил'), faction: 'elf',
    activity: text('Shaking damp salt out onto a drying cloth', 'Высыпает отсыревшую соль на полотно для просушки'),
    greeting: text(
      'Wipe your boots outside the line, not across it. Thank you. People forget when they’re tired.',
      'Вытри сапоги перед полосой, не поперёк неё. Спасибо. Усталые часто забывают.'),
    localQuestion: text('Why does the Echo Well stay covered?', 'Почему Колодец эха держат закрытым?'),
    local: text(
      'Because people lean over before remembering not to answer. Hollow Village draws drinking water elsewhere. The cover keeps children from the edge; the salt needs tending whether the lid is down or not.',
      'Потому что люди успевают наклониться прежде, чем вспомнят, что отвечать нельзя. В Глухой деревне питьевую воду берут в другом месте. Крышка не пускает детей к краю. За солью надо следить и с крышкой, и без неё.'),
    beliefQuestion: text('How do you keep working when it calls in a voice you know?', 'Как продолжаешь работу, когда зовут знакомым голосом?'),
    belief: text(
      'I say what I’m doing to the person beside me. “Pass the cloth. Hold the bowl.” Real things, with someone there to answer. I don’t work at the boundary alone anymore.',
      'Говорю тому, кто рядом, что делаю. «Подай тряпку. Держи миску». Обычные вещи, на которые ответит живой человек. Одна у полосы больше не работаю.'),
  },
  {
    id: 'mila', locationId: 'hollow-village', name: text('Mila', 'Мила'),
    role: text('Displaced seamstress', 'Швея-переселенка'), faction: 'villain',
    activity: text('Mending the cuff of an oversized coat', 'Подшивает рукав слишком большого кафтана'),
    greeting: text(
      'If that tear goes through the lining, give me a moment. I’m nearly done with this sleeve.',
      'Если прорвано до подкладки, подожди немного. Сейчас этот рукав закончу.'),
    localQuestion: text('Are the cloth bundles by the well yours?', 'Свёртки у колодца — твои?'),
    local: text(
      'Some. People leave candles and things to take to the graves. I sew covers so they stay dry. Don’t move a bundle just to read what’s underneath; someone will think it’s been taken.',
      'Некоторые. Там оставляют свечи и вещи, которые понесут на могилы. Я шью чехлы, чтобы не отсырели. Не переставляй свёрток просто ради надписи под ним: решат, что забрали.'),
    beliefQuestion: text('Why mend a coat that will never fit its new owner?', 'Зачем чинить кафтан, который новому хозяину велик?'),
    belief: text(
      'Because cutting it down is easy. Asking whether they want it cut is harder. Sometimes they still want the old shoulders in it for a while.',
      'Ушить легко. Спросить, хотят ли ушивать, труднее. Иногда людям нужно ещё немного походить с чужими плечами.'),
  },
  {
    id: 'elin', locationId: 'last-archive', name: text('Elin Voss', 'Элин Восс'),
    role: text('Keeper of the old binding', 'Смотритель старой привязи'), faction: 'guard',
    activity: text('Checking the copper fastenings without closing them', 'Проверяет медные крепления, не замыкая их'),
    greeting: text(
      'Keep your hand off that catch. It still works. There’s room beside me where you can look without touching.',
      'Не трогай защёлку. Она ещё работает. Рядом со мной есть место, оттуда можно посмотреть, ничего не задев.'),
    localQuestion: text('What do you need from a convoy captain here?', 'Чем здесь может помочь капитан обоза?'),
    local: text(
      'Workers, salt, provisions, and a way to get them to the Old Cloister without losing them. Secure two posts, supply them with your convoy and destroy the enemy caravan. Then we can settle a plan. The binding work itself waits until Commander Raut is defeated.',
      'Нужны люди для работы, соль, припасы и возможность довезти всё в Старый скит. Закрепи две заставы, снабди их обозом и уничтожь вражеский караван. Тогда договоримся о плане. Саму привязь тронем только после победы над командиром Раутом.'),
    beliefQuestion: text('Would you put another person into that fastening?', 'Ты бы замкнул это крепление на другом человеке?'),
    belief: text(
      'Not on your order, or mine. A living keeper would have to understand the confinement and offer freely. I’ve spent long enough studying it to make that choice for myself. No one else owes it to me.',
      'Не по твоему приказу и не по моему. Живой смотритель должен понимать, что останется здесь, и предложить себя сам. Я достаточно изучал привязь, чтобы решать за себя. Другой человек мне этого не должен.'),
  },
  {
    id: 'ren', locationId: 'roadward', name: text('Ren the Cartwright', 'Рен Тележник'),
    role: text('Convoy wheelwright', 'Обозный колёсник'), faction: 'villain',
    activity: text('Feeling for play in a wheel hub', 'Проверяет люфт колёсной втулки'),
    greeting: text(
      'Hold the wheel. No, the wooden bit. Keep your fingers if you can; I haven’t got spare ones in the box.',
      'Подержи колесо. Нет, за дерево. Пальцы побереги, запасных у меня в ящике нет.'),
    localQuestion: text('When can I take a road shortcut with the convoy?', 'Когда можно сделать быстрый переезд вместе с обозом?'),
    local: text(
      'Discover the road stop first. Bring a sound convoy close, and clear nearby enemies and incoming shots at both ends before traveling. The shortcut takes you and the convoy together; it won’t pull a damaged cart out of a fight. To repair, stay beside the cart and hold the interact control.',
      'Сперва открой дорожную стоянку. Подведи исправный обоз. На обоих концах не должно быть врагов рядом и летящих снарядов. Быстрый переезд переносит тебя вместе с обозом, а не вытаскивает разбитую телегу из боя. Для ремонта встань у телеги и удерживай кнопку взаимодействия.'),
    beliefQuestion: text('What makes you refuse a cart that the driver says is sound?', 'Из-за чего не пускаешь телегу, если возчик уверяет, что она исправна?'),
    belief: text(
      'A hot hub. A loose pin. A driver who only checked the side you can see. I don’t argue about it; I put his hand where mine was and let the wheel explain.',
      'Горячая втулка. Разболтанная чека. Возчик, который проверил только видимую сторону. Не спорю: кладу его руку туда, где была моя. Колесо само объяснит.'),
  },
];
