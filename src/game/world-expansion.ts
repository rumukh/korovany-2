import { createPrng } from '@aegis/core';
import type { LocalizedText, WorldLocation, WorldRegion } from './narrative-types';
import type { Obstacle, RoadNode, Vec2, WorldBlueprint } from './types';
import { distance, projectSegment } from './world';

const text = (en: string, ru: string): LocalizedText => ({ en, ru });

function regions(): WorldRegion[] {
  return [
    {
      id: 'heartlands', name: text('The Heartlands', 'Срединные земли'),
      description: text('Wagon ruts cut through wet pasture between the supply posts. At the crossroads, innkeepers hang small iron bells above their doors.', 'Колея тянется через мокрые пастбища между заставами снабжения. У перекрёстков трактирщики вешают над дверями железные колокольчики.'),
      biome: 'countryside', bounds: { minX: -110, maxX: 110, minZ: -140, maxZ: 170 },
    },
    {
      id: 'greenmarch', name: text('Greenmarch', 'Зелёное пограничье'),
      description: text('Apple trees crowd the forest edge. The harvest carts are late, and strips of salted cloth dry beneath the village eaves.', 'Яблони подступают к тёмному лесу. Телеги с урожаем запаздывают; под деревенскими навесами сохнут полосы просоленной ткани.'),
      biome: 'forest', bounds: { minX: -490, maxX: 70, minZ: -490, maxZ: -140 },
    },
    {
      id: 'fenlands', name: text('The Fens', 'Топи'),
      description: text('Raised plank paths cross reed beds and black pools. Ferrymen keep dry tinder in clay pots; damp bell ropes hang beside every landing.', 'Дощатые гати пересекают тростники и чёрные заводи. Паромщики хранят сухой трут в глиняных горшках; у каждого причала висит влажная колокольная верёвка.'),
      biome: 'marsh', bounds: { minX: -490, maxX: -110, minZ: -140, maxZ: 170 },
    },
    {
      id: 'saltcoast', name: text('The Salt Coast', 'Соляной берег'),
      description: text('Sea wind carries brine over the market road. Rope sheds and tarred hulls shelter workers waiting for the tide to uncover the salt pans.', 'Морской ветер несёт рассол на торговую дорогу. У канатных сараев и просмолённых корпусов рабочие ждут, когда отлив обнажит соляные отмели.'),
      biome: 'coast', bounds: { minX: 110, maxX: 490, minZ: -140, maxZ: 170 },
    },
    {
      id: 'ashsteppe', name: text('The Ash Steppe', 'Пепельная степь'),
      description: text('Furnace ash settles in the wheel tracks. Beyond the workers’ wells, spoil heaps and old burial mounds break the bare ground.', 'Печной пепел оседает в колее. За рабочими колодцами среди голой земли поднимаются отвалы и старые погребальные курганы.'),
      biome: 'waste', bounds: { minX: 70, maxX: 490, minZ: -490, maxZ: -140 },
    },
    {
      id: 'crownlands', name: text('Crownlands', 'Коронные земли'),
      description: text('Army wagons pass shuttered storehouses on the approach to the fortress. The foundry yard smells of charcoal, hot sand and old bronze.', 'На подступах к крепости армейские повозки идут мимо запертых складов. На литейном дворе пахнет углём, горячим песком и старой бронзой.'),
      biome: 'countryside', bounds: { minX: -150, maxX: 170, minZ: 170, maxZ: 490 },
    },
    {
      id: 'frostspine', name: text('Frostspine', 'Инейный хребет'),
      description: text('Snow fills the hollows between the mountain road and the monastery. Watch shelters hold split firewood, spare ropes and blankets stiff with frost.', 'Снег заполняет ложбины между горной дорогой и монастырём. В дозорных укрытиях сложены дрова, запасные верёвки и задубевшие от инея одеяла.'),
      biome: 'mountains', bounds: { minX: -490, maxX: -150, minZ: 170, maxZ: 490 },
    },
    {
      id: 'hollowvale', name: text('Hollowvale', 'Глухая долина'),
      description: text('The valley road narrows between empty gardens and fir trees. At the village well, loose shutters knock against the stone curb.', 'Дорога в долине сужается между пустыми огородами и ельником. У деревенского колодца расшатанные створки стучат о каменный сруб.'),
      biome: 'forest', bounds: { minX: 170, maxX: 490, minZ: 170, maxZ: 490 },
    },
  ];
}

function location(
  id: string, regionId: string, x: number, z: number, kind: WorldLocation['kind'],
  en: string, ru: string, descriptionEn: string, descriptionRu: string, fastTravel = false,
): WorldLocation {
  return { id, regionId, x, z, kind, name: text(en, ru), description: text(descriptionEn, descriptionRu), radius: 22, fastTravel };
}

function locations(): WorldLocation[] {
  return [
    location('roadward', 'heartlands', 0, -57, 'inn', 'Roadward Inn', 'Трактовый двор',
      'Unhitched wagons stand under the lean-to. Grain has spilled across the yard, and the bell above the stable door has a new leather strap.',
      'Под навесом стоят распряжённые повозки. Во дворе рассыпано зерно; колокол над дверью конюшни подвешен на новом кожаном ремне.', true),
    location('greenhollow', 'greenmarch', -285, -300, 'settlement', 'Greenhollow', 'Зелёная лощина',
      'Fruit crates are stacked against low garden walls. A woman scrubs a doorstep while her children sort salt from a torn sack.',
      'Ящики с фруктами сложены у низких садовых стен. Женщина отмывает крыльцо, а дети собирают соль из разорванного мешка.', true),
    location('old-orchard', 'greenmarch', -165, -200, 'ruin', 'Old Orchard', 'Старый сад',
      'Fallen apples soften in the cart ruts. A broken fence borders the oldest trees; several branches bear deep rope marks.',
      'Упавшие яблоки гниют в колее. У старых деревьев сломан забор; на нескольких ветвях остались глубокие следы верёвки.'),
    location('stag-shrine', 'greenmarch', -405, -220, 'shrine', 'Stag Shrine', 'Оленье святилище',
      'Weathered antlers crown the shrine gate. Bowls of porridge and patched blankets lie beneath a bare wooden bell frame.',
      'Ворота святилища увенчаны выветренными рогами. Под пустой деревянной колокольной рамой стоят миски каши и лежат залатанные одеяла.'),
    location('thornwatch', 'greenmarch', -330, -430, 'ruin', 'Thornwatch', 'Терновый дозор',
      'Thorn scrub fills the ground floor of a ruined watchtower. An old signal chain hangs through the stairwell, its lowest links polished by use.',
      'Колючий кустарник заполнил нижний этаж разрушенной башни. В лестничный проём свисает сигнальная цепь; её нижние звенья отполированы руками.'),
    location('mirecross', 'fenlands', -270, -48, 'settlement', 'Mirecross', 'Болотный брод',
      'Fish smoke hangs over the bridge market. Reeds are bundled beneath the stalls, and the plank walkway has been repaired with coffin boards.',
      'Над рынком у моста висит рыбный дым. Под прилавками связан тростник; дощатый настил залатан гробовыми досками.', true),
    location('drowned-archive', 'fenlands', -410, 105, 'ruin', 'Drowned Archive', 'Затопленный архив',
      'Floodwater has left a brown line above the stone shelves. Swollen boxes rest in the mud, with brass fittings green from the damp.',
      'Паводок оставил бурую полосу над каменными полками. В грязи лежат разбухшие ящики с позеленевшими от сырости латунными скобами.'),
    location('reed-chapel', 'fenlands', -380, -100, 'shrine', 'Reed Chapel', 'Камышовая часовня',
      'Water drips through a roof of woven reeds. Beside the altar, rescued clothing has been spread over benches to dry.',
      'Сквозь плетёную камышовую крышу капает вода. У алтаря на скамьях разложена для просушки выловленная одежда.'),
    location('lantern-ferry', 'fenlands', -270, 45, 'inn', 'Lantern Ferry', 'Фонарная переправа',
      'Oil lamps hang from hooks along the landing. The ferry rope creaks against its post; spare oars wait beside a covered brazier.',
      'Вдоль причала на крюках висят масляные фонари. Паромный канат скрипит о столб; у накрытой жаровни стоят запасные вёсла.', true),
    location('saltmarket', 'saltcoast', 285, -60, 'settlement', 'Saltmarket', 'Соляной торг',
      'Canvas stalls sell coarse salt, lamp oil and rope. Buyers test the salt for grit before tying their sacks shut against the sea spray.',
      'Под полотняными навесами продают крупную соль, лампадное масло и канаты. Покупатели проверяют соль на песок и туго завязывают мешки от морских брызг.', true),
    location('tide-observatory', 'saltcoast', 415, 108, 'landmark', 'Tide Observatory', 'Приливная башня',
      'A corroded brass gauge stands beside the tower steps. The lantern housing is scored by windblown sand; old tide marks stripe the lower stones.',
      'У ступеней башни стоит изъеденный коррозией латунный уровнемер. Корпус фонаря исцарапан песком; на нижних камнях видны полосы прежних приливов.'),
    location('wreckers-rest', 'saltcoast', 420, -105, 'inn', "Wreckers' Rest", 'Приют корабельщиков',
      'An overturned hull shelters salvage crews. Wet boots steam by the stove, and salvaged lanterns crowd a shelf above the bunks.',
      'Под перевёрнутым корпусом устроились корабельщики. У печи парят мокрые сапоги; над койками на полке теснятся фонари с разбитых судов.', true),
    location('cinderwell', 'ashsteppe', 235, -270, 'settlement', 'Cinderwell', 'Углеземье',
      'Workers queue with buckets at a hand pump. Ash coats the washing lines, and bitter water gathers in the ditch below the furnace road.',
      'Рабочие с вёдрами стоят у ручного насоса. На бельевых верёвках осел пепел; в канаве под дорогой к печам собирается горькая вода.', true),
    location('glass-quarry', 'ashsteppe', 420, -345, 'ruin', 'Glass Quarry', 'Стеклянный карьер',
      'Black slag lies among broken furnace bricks. Wheel tracks run between the cooling pits, where discarded molds are stacked under torn canvas.',
      'Среди битого печного кирпича лежит чёрный шлак. Колея проходит между остывшими ямами; под рваным брезентом сложены выброшенные формы.'),
    location('ash-cairn', 'ashsteppe', 155, -430, 'shrine', 'Ash Cairn', 'Пепельный курган',
      'White stones mark the edge of an old burial mound. Ash has filled the shallow drainage channel, and dead grass clings to the damp bank.',
      'Белые камни отмечают край старого могильного холма. Неглубокая сточная канава забита пеплом; на сыром берегу примята мёртвая трава.'),
    location('crownbridge', 'crownlands', 0, 200, 'settlement', 'Crownbridge', 'Коронный мост',
      'The fortress road crosses a dry ditch on a squat stone bridge. Soldiers check wagon axles beside stacked crates of army provisions.',
      'Крепостная дорога пересекает сухой ров по низкому каменному мосту. У штабелей армейских ящиков солдаты проверяют оси повозок.', true),
    location('tax-vault', 'crownlands', -100, 305, 'ruin', 'Sealed Vault', 'Опечатанный подвал',
      'Iron-bound doors stand beneath the old storehouse. Wax flakes litter the steps, and damp has darkened the planks of the packing crates inside.',
      'Под старым складом стоят окованные железом двери. Ступени усеяны крошками воска; доски упаковочных ящиков внутри потемнели от сырости.'),
    location('bell-foundry', 'crownlands', 90, 350, 'landmark', 'Bell Foundry', 'Колокольный двор',
      'Bells of several sizes wait beside the casting pit. Some still have village ropes attached; cracked bronze has been sorted into baskets.',
      'У литейной ямы стоят колокола разной величины. На некоторых ещё висят деревенские верёвки; расколотая бронза рассортирована по корзинам.'),
    location('high-pass', 'frostspine', -200, 235, 'inn', 'High Pass', 'Высокий перевал',
      'A low stone shelter stands against the mountain wind. Meltwater drips from travellers’ coats onto the packed earth beside the hearth.',
      'Низкое каменное укрытие заслоняет путников от горного ветра. С дорожных плащей на утоптанную землю у очага стекает талая вода.', true),
    location('old-fort', 'frostspine', -365, 235, 'settlement', 'Old Fort', 'Старый форт',
      'Your mountain army musters inside an old stone fort. Its banners answer to its ruler, not a distant employer.',
      'Ваша горная армия собирается в старом каменном форте. Её знамёна подчиняются своему правителю, не далёкому нанимателю.', true),
    location('palace-citadel', 'crownlands', 0, 270, 'landmark', 'Royal Citadel', 'Королевская цитадель',
      'The royal residence stands behind the garrison quarter. Taking a supply gate is not taking this throne.',
      'За гарнизонным кварталом стоит королевская резиденция. Взять складские ворота — не значит захватить этот трон.'),
    location('star-monastery', 'frostspine', -330, 340, 'shrine', 'Star Monastery', 'Звёздный монастырь',
      'Narrow arches overlook the snowfields. Candle grease coats the reading desks, and a worn bell rope passes through a hole in the ceiling.',
      'Узкие арки выходят на снежные поля. Читальные столы покрыты свечными потёками; сквозь отверстие в потолке пропущена истёртая колокольная верёвка.'),
    location('frozen-beacon', 'frostspine', -430, 435, 'landmark', 'Frozen Beacon', 'Замёрзший маяк',
      'Ice grips the iron signal basket. Freshly split kindling lies beneath its cover, beside a watch stool wrapped in sheepskin.',
      'Железную сигнальную чашу сковал лёд. Под навесом лежит свежая растопка, рядом стоит дозорный табурет, обёрнутый овчиной.'),
    location('hollow-village', 'hollowvale', 240, 235, 'settlement', 'Hollow Village', 'Глухая деревня',
      'Several doors stand open along the lane. Cold pots remain on the hearths, and a child’s boot lies in the mud beneath an empty bell hook.',
      'Несколько дверей на улице распахнуты. На очагах остались холодные горшки; в грязи под пустым колокольным крюком лежит детский сапог.', true),
    location('name-well', 'hollowvale', 390, 310, 'shrine', 'Echo Well', 'Колодец эха',
      'Frayed cords descend into the dark shaft. Two clay bowls stand on the curb, and a loose stone rattles far below when the wind turns.',
      'В тёмную шахту спускаются истрепавшиеся шнуры. На срубе стоят две глиняные миски; когда ветер меняется, в глубине стучит расшатанный камень.'),
    location('last-archive', 'hollowvale', 315, 435, 'ruin', 'Old Cloister', 'Старый скит',
      'Fir needles cover the roofless passage. A stone worktable survives beside the ruined chapel, its surface scarred by clamps and scorched wax.',
      'Проход без крыши засыпан еловой хвоей. У разрушенной часовни сохранился каменный рабочий стол со следами зажимов и обгоревшего воска.'),
  ];
}

/** An authored graph fixes geography; the seed varies scenery, never quest access. */
export function expandWorld(legacy: WorldBlueprint): WorldBlueprint {
  const world = legacy;
  world.version = 2;
  world.id = '';
  world.bounds = { minX: -490, maxX: 490, minZ: -490, maxZ: 490 };
  world.river = { minX: -490, maxX: 490, minZ: -5, maxZ: 5 };
  world.bridges.push(
    { minX: -277, maxX: -263, minZ: -12, maxZ: 12 },
    { minX: 263, maxX: 277, minZ: -12, maxZ: 12 },
  );
  world.exploration = { regions: regions(), locations: locations() };
  for (const region of world.exploration.regions) {
    region.politicalFaction = region.id === 'greenmarch' ? 'elf' : region.id === 'crownlands' ? 'guard' :
      region.id === 'frostspine' ? 'villain' : 'neutral';
  }
  const node = (id: string): RoadNode => {
    const result = world.roads.nodes.find(n => n.id === id);
    if (!result) throw new Error(`Unknown expanded road node: ${id}`);
    return result;
  };
  world.roads.nodes.push(
    ...world.exploration.locations.map(({ id, x, z }) => ({ id, x, z })),
    { id: 'west-old-road', x: -100, z: node('forest').z },
    { id: 'northwest-way', x: -100, z: node('quarry').z },
    { id: 'east-old-road', x: 100, z: node('palace').z },
    { id: 'southeast-way', x: 100, z: -24 },
    { id: 'western-crossing-south', x: -270, z: -18 },
    { id: 'western-crossing-north', x: -270, z: 18 },
    { id: 'eastern-crossing-south', x: 270, z: -18 },
    { id: 'eastern-crossing-north', x: 270, z: 18 },
    { id: 'southern-fork', x: 0, z: -165 },
    { id: 'southwest-turn', x: -110, z: -440 },
    { id: 'northwest-turn', x: -170, z: 445 },
    { id: 'northeast-turn', x: 160, z: 440 },
  );
  const chains = [
    ['high-pass', 'old-fort', 'star-monastery'],
    ['crownbridge', 'palace-citadel'],
    ['home', 'roadward', 'southern-fork', 'old-orchard', 'greenhollow', 'thornwatch', 'southwest-turn', 'ash-cairn', 'glass-quarry', 'wreckers-rest', 'saltmarket'],
    ['forest', 'west-old-road', 'western-crossing-south', 'western-crossing-north', 'northwest-way', 'quarry'],
    ['raid', 'southeast-way', 'eastern-crossing-south', 'eastern-crossing-north', 'east-old-road', 'palace'],
    ['western-crossing-south', 'mirecross', 'reed-chapel', 'stag-shrine', 'greenhollow'],
    ['old-orchard', 'reed-chapel'],
    ['southern-fork', 'cinderwell', 'saltmarket', 'eastern-crossing-south'],
    ['cinderwell', 'glass-quarry'],
    ['western-crossing-north', 'lantern-ferry', 'drowned-archive', 'high-pass', 'star-monastery', 'frozen-beacon', 'northwest-turn', 'tax-vault', 'crownbridge', 'fortress'],
    ['high-pass', 'crownbridge', 'bell-foundry', 'tax-vault'],
    ['bell-foundry', 'northeast-turn', 'last-archive', 'name-well', 'hollow-village', 'tide-observatory', 'eastern-crossing-north'],
    ['crownbridge', 'hollow-village', 'last-archive'],
  ];
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      world.roads.edges.push({ from: chain[i - 1]!, to: chain[i]!, width: 8 });
    }
  }
  const segments = world.roads.edges.map(edge => ({ a: node(edge.from), b: node(edge.to), width: edge.width }));
  const clearRoad = (p: Vec2, radius: number): boolean =>
    segments.every(({ a, b, width }) => distance(p, projectSegment(p, a, b)) >= width / 2 + radius + 1.5);
  const clearSite = (p: Vec2, radius: number): boolean =>
    world.sites.every(site => distance(p, site) >= site.radius + radius + 4)
    && world.exploration!.locations.every(place => distance(p, place) >= 9 + radius);
  // Original military structures remain intact; only random scenery yields to new lanes.
  world.obstacles = world.obstacles.filter(o => o.kind === 'wall' || (clearRoad(o, o.radius) && clearSite(o, o.radius)));
  const placeObstacle = (o: Obstacle): boolean => {
    if (Math.abs(o.x) + o.radius >= 484 || Math.abs(o.z) + o.radius >= 484
      || Math.abs(o.z) < 10 + o.radius || !clearRoad(o, o.radius) || !clearSite(o, o.radius)
      || world.obstacles.some(other => distance(o, other) < o.radius + other.radius + 1)) return false;
    world.obstacles.push(o);
    return true;
  };
  for (const place of world.exploration.locations) {
    const count = place.kind === 'settlement' ? 6 : place.kind === 'ruin' ? 5 : 3;
    let built = 0;
    for (let attempt = 0; attempt < 48 && built < count; attempt++) {
      const angle = attempt * Math.PI / 6 + Math.PI / 12;
      const ring = 18 + Math.floor(attempt / 12) * 8;
      const radius = place.kind === 'settlement' || place.kind === 'inn' ? 3.4 : 2.8;
      if (placeObstacle({
        id: `${place.id}-building-${built}`, kind: 'wall',
        x: place.x + Math.sin(angle) * ring, z: place.z + Math.cos(angle) * ring,
        radius, height: place.id === 'old-fort' ? built === 0 ? 14 : 10 + built % 3 :
          place.kind === 'landmark' ? 13 + built * 2 : place.kind === 'shrine' ? 8 : 5 + built % 3,
        variant: built,
      })) built++;
    }
    if (built < count) throw new Error(`Cannot place the authored silhouette at ${place.id}`);
  }
  const fort = world.exploration.locations.find(place => place.id === 'old-fort')!;
  const fortWalls: Obstacle[] = [
    { id: 'old-fort-wall-tower-0', kind: 'wall', x: fort.x - 5, z: fort.z + 18, radius: 2.5, height: 16, variant: 0 },
    { id: 'old-fort-wall-tower-1', kind: 'wall', x: fort.x + 14, z: fort.z + 9, radius: 2.2, height: 14, variant: 1 },
    ...Array.from({ length: 12 }, (_, index): Obstacle => {
      const angle = (144 + index * 18) * Math.PI / 180;
      return { id: `old-fort-wall-${index}`, kind: 'wall',
        x: fort.x + Math.sin(angle) * 12, z: fort.z + Math.cos(angle) * 12,
        radius: 1.3, height: 7, variant: index };
    }),
  ];
  for (const wall of fortWalls) {
    if (!placeObstacle(wall)) throw new Error(`Cannot place the Old Fort perimeter at ${wall.id}`);
  }
  const rng = createPrng(`korovany2:frontier:${world.seed}`);
  // Fixed attempt and obstacle budgets keep collision, saves and scenery bounded.
  for (let attempt = 0; attempt < 2600 && world.obstacles.length < 1400; attempt++) {
    const p = { x: rng.range(-478, 478), z: rng.range(-478, 478) };
    if (Math.abs(p.x) < 72 && Math.abs(p.z) < 72) continue;
    const region = world.exploration.regions.find(r => p.x >= r.bounds.minX && p.x <= r.bounds.maxX
      && p.z >= r.bounds.minZ && p.z <= r.bounds.maxZ);
    if (!region) throw new Error('Expanded regions do not cover the world');
    const wooded = region.biome === 'forest' || region.biome === 'marsh';
    const kind = wooded && rng.range(0, 1) > 0.18 ? 'tree' : 'rock';
    placeObstacle({
      ...p, id: `frontier-${attempt}`, kind, variant: rng.int(0, 4),
      radius: kind === 'tree' ? rng.range(1.1, 2.4) : rng.range(1.4, region.biome === 'mountains' ? 5 : 3),
      height: kind === 'tree' ? rng.range(7, 15) : rng.range(2, region.biome === 'mountains' ? 17 : 6),
    });
  }
  let hash = 2166136261;
  for (const c of JSON.stringify(world)) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  world.id = `k2-v2-${(hash >>> 0).toString(16)}`;
  return world;
}
