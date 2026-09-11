import { createPrng } from '@aegis/core';
import type { LocalizedText, WorldLocation, WorldRegion } from './narrative-types';
import type { Obstacle, RoadNode, Vec2, WorldBlueprint } from './types';
import { distance, projectSegment } from './world';

const text = (en: string, ru: string): LocalizedText => ({ en, ru });

function regions(): WorldRegion[] {
  return [
    {
      id: 'heartlands', name: text('The Roadward Heartlands', 'Сердцевина тракта'),
      description: text('Six old banners still defend the crossroads. Beyond their walls, the toll rolls have begun to lose whole villages.', 'Шесть старых знамён ещё защищают перекрёстки. За их стенами из пошлинных книг начинают исчезать целые деревни.'),
      biome: 'countryside', bounds: { minX: -110, maxX: 110, minZ: -140, maxZ: 170 },
    },
    {
      id: 'greenmarch', name: text('Greenmarch', 'Зелёное пограничье'),
      description: text('Orchards and dark firs shelter families whose names now survive only in harvest songs.', 'Сады и тёмные ели укрывают семьи, чьи имена сохранились лишь в песнях о жатве.'),
      biome: 'forest', bounds: { minX: -490, maxX: 70, minZ: -490, maxZ: -140 },
    },
    {
      id: 'fenlands', name: text('The Lantern Fens', 'Фонарные топи'),
      description: text('Reed causeways carry unlicensed witnesses between drowned shelves and a ferry that refuses to count its passengers.', 'Тростниковые гати ведут незарегистрированных свидетелей мимо затопленных полок к переправе, где отказываются считать пассажиров.'),
      biome: 'marsh', bounds: { minX: -490, maxX: -110, minZ: -140, maxZ: 170 },
    },
    {
      id: 'saltcoast', name: text('The Salt Coast', 'Соляной берег'),
      description: text('Salt has eaten the seals from every customs chest. The tide keeps a less obedient calendar than the Crown.', 'Соль разъела печати на таможенных ларях. Приливы ведут календарь, неподвластный Короне.'),
      biome: 'coast', bounds: { minX: 110, maxX: 490, minZ: -140, maxZ: 170 },
    },
    {
      id: 'ashsteppe', name: text('The Ash Steppe', 'Пепельная степь'),
      description: text('Burned survey stakes cross the ochre waste. Every mile was paid for twice: once in coin, once in memory.', 'Обгорелые межевые столбы пересекают охряную пустошь. За каждую милю заплатили дважды: монетой и памятью.'),
      biome: 'waste', bounds: { minX: 70, maxX: 490, minZ: -490, maxZ: -140 },
    },
    {
      id: 'crownlands', name: text('The Ledger Crownlands', 'Коронные земли Реестра'),
      description: text('Bell towers and sealed vaults measure the cost of belonging. Here an empty line can condemn a town.', 'Колокольни и запечатанные хранилища отмеряют цену права на существование. Здесь пустая строка может погубить город.'),
      biome: 'countryside', bounds: { minX: -150, maxX: 170, minZ: 170, maxZ: 490 },
    },
    {
      id: 'frostspine', name: text('Frostspine', 'Инейный хребет'),
      description: text('Above the snow line, monks chart stars that no registrar has managed to rename.', 'За снеговой чертой монахи наносят на карты звёзды, которые ни один писарь не сумел переименовать.'),
      biome: 'mountains', bounds: { minX: -490, maxX: -150, minZ: 170, maxZ: 490 },
    },
    {
      id: 'hollowvale', name: text('The Hollow Vale', 'Полая долина'),
      description: text('Doors stand open in a valley absent from every map. The wells still answer when the missing are called.', 'В долине, которой нет ни на одной карте, двери стоят открытыми. Колодцы ещё отзываются на имена пропавших.'),
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
    location('roadward', 'heartlands', 0, -57, 'inn', 'Roadward Inn', 'Трактовый приют',
      'A roof for anyone the toll books refuse to name. Blank milestones are stacked beside the guest ledger.',
      'Кров для всех, чьи имена отвергли пошлинные книги. У гостевой книги сложены вехи со стёртыми надписями.', true),
    location('greenhollow', 'greenmarch', -285, -300, 'settlement', 'Greenhollow', 'Зелёная лощина',
      'Orchard families share bread beneath an empty charter frame. The tax collector insists nobody lives here.',
      'Семьи садоводов делят хлеб под пустой рамой хартии. Сборщик податей уверяет, что здесь никто не живёт.', true),
    location('old-orchard', 'greenmarch', -165, -200, 'ruin', 'The Unnumbered Orchard', 'Сад без номера',
      'Every tree bears a copper family tag. The oldest tags have been scraped smooth, but the roots remember the rows.',
      'На каждом дереве медная бирка семьи. Старые бирки выскоблены дочиста, но корни помнят свои ряды.'),
    location('stag-shrine', 'greenmarch', -405, -220, 'shrine', 'Shrine of the Returning Stag', 'Святилище вернувшегося оленя',
      'Antler arches shelter offerings addressed to people erased from the census. Fresh footprints lead both ways.',
      'Под арками из рогов лежат подношения людям, вычеркнутым из переписи. Свежие следы ведут в обе стороны.'),
    location('thornwatch', 'greenmarch', -330, -430, 'ruin', 'Thornwatch', 'Терновый дозор',
      'A border tower overlooks a road the Crown calls unfinished. Its last keeper carved the true mileage into the lintel.',
      'Пограничная башня сторожит тракт, который Корона считает недостроенным. Последний смотритель вырезал верный путь на притолоке.'),
    location('mirecross', 'fenlands', -270, -48, 'settlement', 'Mirecross', 'Болотный брод',
      'A stubborn market guards the western bridge. Residents paint their names anew whenever the rain washes the boards.',
      'Упрямый рынок охраняет западный мост. Жители заново пишут свои имена на досках после каждого дождя.', true),
    location('drowned-archive', 'fenlands', -410, 105, 'ruin', 'The Drowned Archive', 'Затопленный архив',
      'Stone shelves rise from mud where the toll court sank its first records. Wax seals still float between the reeds.',
      'Каменные полки выступают из ила там, где пошлинный суд утопил первые записи. Между тростниками ещё плавают восковые печати.'),
    location('reed-chapel', 'fenlands', -380, -100, 'shrine', 'Reed Chapel', 'Тростниковая часовня',
      'A roof of woven reeds covers a bell without a tongue. Pilgrims speak the missing names into its hollow.',
      'Плетёная тростниковая крыша укрывает колокол без языка. Паломники шепчут в его полость имена пропавших.'),
    location('lantern-ferry', 'fenlands', -270, 45, 'inn', 'The Lantern Ferry', 'Фонарная переправа',
      'The old ferryman tends lamps beside the new bridge. His passenger book records stories instead of fares.',
      'Старый паромщик зажигает фонари у нового моста. В его книге пассажиров вместо платы записаны истории.', true),
    location('saltmarket', 'saltcoast', 285, -60, 'settlement', 'Saltmarket', 'Соляной торг',
      'Canvas stalls sell salt, rope and confiscated maps. Each map shows a different edge to the kingdom.',
      'Под полотняными навесами торгуют солью, канатами и изъятыми картами. На каждой карте границы королевства иные.', true),
    location('tide-observatory', 'saltcoast', 415, 108, 'landmark', 'The Tide Observatory', 'Приливная обсерватория',
      'A brass ring charts the tide against a sky of unpaid stars. Its instruments prove the official calendar has missing days.',
      'Латунное кольцо сверяет приливы со звёздами, не знающими пошлин. Приборы доказывают: в казённом календаре пропущены дни.'),
    location('wreckers-rest', 'saltcoast', 420, -105, 'inn', "Wreckers' Rest", 'Приют разбитых судов',
      'An overturned hull shelters sailors whose home ports vanished from the register while they were at sea.',
      'Перевёрнутый корпус укрывает моряков, чьи родные порты исчезли из реестра, пока они были в море.', true),
    location('cinderwell', 'ashsteppe', 235, -270, 'settlement', 'Cinderwell', 'Угольный колодец',
      'A hand pump draws clean water through black ash. The well serves three villages; only one is permitted a name.',
      'Ручной насос тянет чистую воду сквозь чёрный пепел. Колодец поит три деревни; иметь имя дозволено лишь одной.', true),
    location('glass-quarry', 'ashsteppe', 420, -345, 'ruin', 'The Glass Quarry', 'Стеклянный карьер',
      'Green glass ribs mark the furnaces that melted confiscated seals. Some impressions survived inside the slag.',
      'Зелёные стеклянные рёбра отмечают печи, где плавили изъятые печати. В шлаке сохранились оттиски.'),
    location('ash-cairn', 'ashsteppe', 155, -430, 'shrine', 'The Ash Cairn', 'Пепельный курган',
      'Travelers leave one white stone for each village omitted from their journey permit. The mound outgrew the marker.',
      'Путники оставляют по белому камню за каждую деревню, пропущенную в подорожной. Курган давно перерос свою веху.'),
    location('crownbridge', 'crownlands', 0, 200, 'settlement', 'Crownbridge', 'Коронный мост',
      'A dry ceremonial bridge carries the royal road over a trench of discarded petitions. Its toll booth never closes.',
      'Сухой церемониальный мост ведёт королевский тракт над рвом отвергнутых прошений. Пошлинная будка не закрывается.', true),
    location('tax-vault', 'crownlands', -100, 305, 'ruin', 'The Silent Tax Vault', 'Безмолвное податное хранилище',
      'Rows of iron shutters guard empty coin niches. Behind them, the Crown stores the names it accepted as payment.',
      'Ряды железных ставней охраняют пустые ниши для монет. За ними Корона хранит имена, принятые в уплату.'),
    location('bell-foundry', 'crownlands', 90, 350, 'landmark', 'The Census Bell Foundry', 'Литейня переписных колоколов',
      'Unfinished bells hang beside a cold furnace. One was cast for every recognized town; several have been split for scrap.',
      'Недолитые колокола висят у холодной печи. Их отливали для каждого признанного города; несколько уже расколоты на лом.'),
    location('high-pass', 'frostspine', -200, 235, 'inn', 'High Pass Refuge', 'Приют Высокого перевала',
      'A low stone shelter stands beyond the last tax post. Names are spoken here before anyone asks for papers.',
      'Низкое каменное убежище стоит за последней заставой. Здесь сначала называют имя и лишь потом спрашивают бумаги.', true),
    location('star-monastery', 'frostspine', -330, 340, 'shrine', 'Monastery of Uncounted Stars', 'Монастырь несосчитанных звёзд',
      'Open arches frame constellations stitched into the monks’ registers. Their oldest chart includes a road no surveyor remembers.',
      'Открытые арки обрамляют созвездия, вышитые в монастырских книгах. На старейшей карте есть дорога, которую не помнит ни один землемер.'),
    location('frozen-beacon', 'frostspine', -430, 435, 'landmark', 'The Frozen Beacon', 'Замёрзший маяк',
      'An ice-bright signal basket faces the erased valleys. Someone keeps replacing the fuel, though no watch is officially stationed here.',
      'Сияющая льдом сигнальная чаша обращена к стёртым долинам. Кто-то пополняет топливо, хотя по бумагам здесь нет дозора.'),
    location('hollow-village', 'hollowvale', 240, 235, 'settlement', 'Hollow Village', 'Полая деревня',
      'Meals cool behind open doors. The village has people, gardens and debts, but the register leaves its square blank.',
      'За открытыми дверями остывает еда. У деревни есть жители, сады и долги, но её клетка в реестре пуста.', true),
    location('name-well', 'hollowvale', 390, 310, 'shrine', 'The Well of Names', 'Колодец имён',
      'Ribbons descend into a dry stone throat. Say a lost name and the echo returns in a voice not quite your own.',
      'Ленты спускаются в сухое каменное горло. Произнеси потерянное имя, и эхо ответит голосом, не совсем похожим на твой.'),
    location('last-archive', 'hollowvale', 315, 435, 'ruin', 'The Last Archive', 'Последний архив',
      'Roofless shelves await a book that can restore the unwritten road. There is room for every settlement, and no place for a seal.',
      'Полки под открытым небом ждут книгу, способную вернуть ненаписанный тракт. Здесь хватит места каждому поселению, но нет места печати.'),
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
        radius, height: place.kind === 'landmark' ? 13 + built * 2 : place.kind === 'shrine' ? 8 : 5 + built % 3,
        variant: built,
      })) built++;
    }
    if (built < count) throw new Error(`Cannot place the authored silhouette at ${place.id}`);
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
