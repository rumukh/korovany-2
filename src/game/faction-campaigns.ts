import type { CampaignData } from './state';
import type { FactionId, LocalizedText, Vec2, WorldBlueprint } from './types';

const text = (en: string, ru: string): LocalizedText => ({ en, ru });
export type PoliticalFactionId = FactionId | 'neutral';
export type FactionDirective = 'shelter' | 'interdict' | 'relief' | 'pursuit' | 'dominion' | 'plunder';
export const SHIPMENT_NAME = text('Ward-glass shipment', 'Груз обережного стекла');
export interface FactionCampaignDefinition {
  id: FactionId;
  name: LocalizedText;
  role: LocalizedText;
  introduction: LocalizedText;
  allegiance: LocalizedText;
  militaryObjective: LocalizedText;
  homeLocationId: string;
  boss: { name: LocalizedText; role: LocalizedText };
  victoryTitle: LocalizedText;
  victorySummary: LocalizedText;
}
export interface FactionCampaignSnapshot {
  identity: FactionCampaignDefinition;
  directive: FactionDirective | null;
  orders: LocalizedText;
  requirements: { id: string; label: LocalizedText; complete: boolean; targetId: string | null }[];
  standing: { id: PoliticalFactionId; name: LocalizedText; relation: 'friendly' | 'hostile' | 'neutral' }[];
  shipment: { role: LocalizedText; status: LocalizedText; targetId: string };
  objectiveLabel: LocalizedText;
}
export interface MilitaryState {
  version: 1;
  directive: FactionDirective | null;
  shipment: { claimed: boolean; delivered: boolean; destination: string | null; route: Vec2[]; repairProgress: number };
}
export const FACTION_CAMPAIGNS: Record<FactionId, FactionCampaignDefinition> = {
  elf: {
    id: 'elf', name: text('The Elven Forest Resistance', 'Лесное сопротивление эльфов'),
    role: text('Elven defender of the wooden settlements', 'Эльф — защитник деревянных поселений'),
    introduction: text('Greenhollow is your home, not a contract. Palace patrols and mountain raiders take its food. Toman needs a decision: shelter the households or widen the partisan blockade.',
      'Зелёная лощина — ваш дом, а не подряд. Дворцовые патрули и горные налётчики отнимают её хлеб. Томан ждёт решения: укрыть семьи или расширить партизанскую блокаду.'),
    allegiance: text('Forest households and partisan watches; neutral humans are not enemies.', 'Лесные семьи и партизанские дозоры; нейтральные люди не враги.'),
    militaryObjective: text('Choose with Toman. Defeat the shipment escort, hold E beside the intact wagon to intercept it, and escort it to the forest depot. Liberate and supply the required posts, then defeat Raut.',
      'Примите решение с Томаном. Разбейте охрану груза, удерживайте E у целой повозки, чтобы перехватить её, и проводите её к лесному складу. Освободите и снабдите нужные заставы, затем победите Раута.'),
    homeLocationId: 'greenhollow',
    boss: { name: text('Raut', 'Раут'), role: text('Commander of the occupying expedition', 'Командир карательной экспедиции') },
    victoryTitle: text('The forest holds', 'Лес устоял'),
    victorySummary: text('The occupation is broken. Your decisions determine how the households survive the Hollow Road.', 'Оккупация сломлена. Ваши решения определяют, как лесные семьи переживут Глухой тракт.'),
  },
  guard: {
    id: 'guard', name: text('The Palace Guard', 'Дворцовая стража'),
    role: text('Officer under Commander Vesk', 'Офицер под началом командира Веска'),
    introduction: text('Report to Vesk at Crownbridge. Your post is the palace, your authority comes with orders. Repel the attackers at its supply gate and protect the ward-glass shipment before an authorized sortie.',
      'Доложите Веску у Коронного моста. Ваш пост — дворец, ваша власть ограничена приказом. Отбейте нападение на складские ворота и защитите груз обережного стекла до разрешённой вылазки.'),
    allegiance: text('The Crown garrison; forest partisans and the mountain army are hostile forces, not every resident.', 'Коронный гарнизон; лесные партизаны и горная армия — враждебные силы, но не все местные жители.'),
    militaryObjective: text('Accept Vesk’s relief or pursuit assignment. Defend the palace supply gate, then hold E beside the shipment and protect its road journey to the gate. Supply the ordered posts before the sortie against Raut.',
      'Примите у Веска приказ о помощи или преследовании. Защитите дворцовые складские ворота, затем удерживайте E у груза и охраняйте его путь к воротам. Снабдите указанные заставы до вылазки против Раута.'),
    homeLocationId: 'crownbridge',
    boss: { name: text('Raut', 'Раут'), role: text('Commander of the invading mountain army', 'Командир горной армии вторжения') },
    victoryTitle: text('The palace is defended', 'Дворец защищён'),
    victorySummary: text('The defense, protected delivery and authorized sortie are complete. Your service record shapes the settlement.', 'Оборона, доставка под охраной и разрешённая вылазка завершены. Послужной список определит условия мира.'),
  },
  villain: {
    id: 'villain', name: text('The Mountain Sovereign', 'Горный властитель'),
    role: text('Independent ruler of the Old Fort', 'Самостоятельный правитель Старого форта'),
    introduction: text('The Old Fort is yours and its soldiers answer to you. Ren brings intelligence, not orders. Seize the palace shipment and choose whether conquest will build a domain or feed your mountain treasury.',
      'Старый форт принадлежит вам, и его воины подчиняются вам. Рен приносит сведения, не приказы. Присвойте дворцовый груз и решите, создаст ли завоевание новую державу или наполнит горную казну.'),
    allegiance: text('Your own mountain army; the palace and forest resistance oppose expansion. Neutral humans remain independent.',
      'Ваша собственная горная армия; дворец и лесное сопротивление противостоят расширению. Нейтральные люди сохраняют независимость.'),
    militaryObjective: text('Declare dominion or plunder to Ren. Defeat the shipment escort and hold E beside the intact wagon to claim it. Escort it to the palace supply gate for dominion or back to the Old Fort for plunder. Establish your supply foothold and conquer the royal citadel.',
      'Объявите Рену о державе или добыче. Разбейте охрану груза и удерживайте E у целой повозки, чтобы присвоить её. Проводите её к дворцовым складским воротам для державы или в Старый форт для добычи. Обеспечьте плацдарм снабжением и завоюйте королевскую цитадель.'),
    homeLocationId: 'old-fort',
    boss: { name: text('The Palace Marshal', 'Дворцовый маршал'), role: text('Defender of the royal citadel', 'Защитник королевской цитадели') },
    victoryTitle: text('The throne is taken', 'Трон захвачен'),
    victorySummary: text('Your army holds the royal citadel. The terms of your rule now belong to you, not an employer.', 'Ваша армия держит королевскую цитадель. Условия правления определяете вы, не наниматель.'),
  },
};
export const DIRECTIVES: Record<FactionId, readonly FactionDirective[]> = {
  elf: ['shelter', 'interdict'], guard: ['relief', 'pursuit'], villain: ['dominion', 'plunder'],
};
export function createMilitary(): MilitaryState {
  return { version: 1, directive: null, shipment: { claimed: false, delivered: false, destination: null, route: [], repairProgress: 1 } };
}
export function requiredPosts(s: CampaignData): string[] {
  const directive = s.military?.directive;
  if (s.faction === 'elf') return directive === 'interdict' ? ['forest', 'palace'] : ['forest'];
  if (s.faction === 'guard') return directive === 'pursuit' ? ['palace', 'quarry'] : ['palace'];
  return directive === 'dominion' ? ['palace', 'quarry'] : ['palace'];
}
export function shipmentDestination(s: CampaignData): string {
  return s.faction === 'elf' ? 'forest' : s.military?.directive === 'plunder' ? 'old-fort' : 'palace';
}
export function militaryReady(s: CampaignData): boolean {
  if (!s.military) return s.raidComplete && s.outposts.filter(p => p.owner === 'player' && p.supplied).length >= 2;
  return s.military.directive !== null && s.military.shipment.delivered &&
    requiredPosts(s).every(id => s.outposts.some(p => p.id === id && p.owner === 'player' && p.supplied && p.defendersRemaining === 0));
}
export function canCapturePost(s: CampaignData, id: string): boolean {
  if (!s.military) return true;
  if (!s.military.directive) return false;
  if (s.faction !== 'guard') return true;
  return id === 'quarry' && s.military.directive === 'pursuit' && s.military.shipment.delivered &&
    s.outposts.some(p => p.id === 'palace' && p.defendersRemaining === 0 && p.supplied);
}
export function factionCampaignSnapshot(s: CampaignData): FactionCampaignSnapshot {
  const identity = FACTION_CAMPAIGNS[s.faction], military = s.military!;
  const requirements: FactionCampaignSnapshot['requirements'] = [
    { id: 'directive', label: text('Commit to your faction’s military plan', 'Принять военный план своей стороны'), complete: military.directive !== null,
      targetId: s.faction === 'elf' ? 'toman' : s.faction === 'guard' ? 'vesk' : 'ren' },
  ];
  if (s.faction === 'guard') requirements.push({
    id: 'defense', label: text('Repel the attack on the palace supply gate', 'Отбить нападение на дворцовые складские ворота'),
    complete: s.outposts.some(p => p.id === 'palace' && p.defendersRemaining === 0), targetId: 'palace',
  });
  requirements.push({ id: 'shipment', label: s.faction === 'guard' ?
    text('Protect the shipment to the palace supply gate', 'Защитить доставку груза к дворцовым складским воротам') :
    s.faction === 'elf' ? text('Intercept and recover the shipment to the forest depot', 'Перехватить и доставить груз к лесному складу') :
    military.directive === 'plunder' ? text('Appropriate the shipment and bring it to the Old Fort', 'Присвоить груз и доставить его в Старый форт') :
    text('Appropriate the shipment for the palace foothold', 'Присвоить груз для дворцового плацдарма'),
    complete: military.shipment.delivered, targetId: 'enemy-caravan' });
  for (const id of requiredPosts(s)) {
    const post = s.outposts.find(p => p.id === id)!;
    const name = id === 'forest' ? text('forest depot', 'лесной склад') : id === 'palace' ?
      text('palace supply gate', 'дворцовые складские ворота') : text('quarry road', 'дорога к карьеру');
    requirements.push({ id: `post-${id}`, label: text(`Secure and supply the ${name.en}`, `Обеспечить контроль и снабжение: ${name.ru}`),
      complete: post.owner === 'player' && post.supplied && post.defendersRemaining === 0, targetId: id });
  }
  requirements.push({ id: 'commander', label: text(`Defeat ${identity.boss.name.en}`, `Победить: ${identity.boss.name.ru}`),
    complete: s.fortress.bossDefeated, targetId: 'fortress' });
  const next = requirements.find(r => !r.complete);
  const status = military.shipment.delivered ? text('Delivered intact', 'Доставлен в целости') :
    military.shipment.claimed ? text('On the road: stay nearby, repair with E if disabled', 'В пути: держитесь рядом, при поломке чините клавишей E') :
    text('Awaiting intervention beside the wagon (hold E)', 'Ожидает действий у повозки (удерживайте E)');
  return {
    identity, directive: military.directive,
    orders: next?.label ?? text('Military obligations fulfilled; resolve your faction’s story.', 'Военные обязательства выполнены; завершите историю своей стороны.'),
    requirements, objectiveLabel: next?.label ?? text('Resolve the Hollow Road', 'Решить судьбу Глухого тракта'),
    standing: [
      { id: 'elf', name: FACTION_CAMPAIGNS.elf.name, relation: s.faction === 'elf' ? 'friendly' : 'hostile' },
      { id: 'guard', name: FACTION_CAMPAIGNS.guard.name, relation: s.faction === 'guard' ? 'friendly' : 'hostile' },
      { id: 'villain', name: FACTION_CAMPAIGNS.villain.name, relation: s.faction === 'villain' ? 'friendly' : 'hostile' },
      { id: 'neutral', name: text('Independent human settlements', 'Независимые людские поселения'), relation: 'neutral' },
    ],
    shipment: { role: s.faction === 'guard' ? text('Protected Crown shipment', 'Охраняемый коронный груз') :
      s.faction === 'elf' ? text('Interception target', 'Цель перехвата') : text('Prize for your army', 'Добыча для вашей армии'), status, targetId: 'enemy-caravan' },
  };
}

/** Appearance, political ownership and combat allegiance are separate data. */
export function configureFactionWorld(world: WorldBlueprint, faction: FactionId): WorldBlueprint {
  if (world.version === 1) return world;
  const identity = FACTION_CAMPAIGNS[faction];
  const home = world.exploration!.locations.find(l => l.id === identity.homeLocationId)!;
  const homeSite = world.sites.find(s => s.id === 'home')!;
  Object.assign(homeSite, { x: home.x, z: home.z, faction, allegiance: 'friendly', name: home.name });
  const original = world.roads.nodes.find(n => n.id === 'home')!;
  original.id = 'roadward-yard';
  for (const edge of world.roads.edges) {
    if (edge.from === 'home') edge.from = original.id;
    if (edge.to === 'home') edge.to = original.id;
  }
  const homeEdge = world.roads.edges.find(e => e.from === home.id || e.to === home.id)!;
  const neighbor = homeEdge.from === home.id ? homeEdge.to : homeEdge.from;
  world.roads.nodes.push({ id: 'home', x: home.x, z: home.z });
  world.roads.edges.push({ from: 'home', to: neighbor, width: homeEdge.width });
  for (const site of world.sites.filter(s => s.kind === 'outpost')) {
    site.name = site.id === 'forest' ? text('Forest depot', 'Лесной склад') :
      site.id === 'palace' ? text('Palace supply gate', 'Дворцовые складские ворота') : text('Quarry road post', 'Застава карьерной дороги');
    site.faction = site.id === 'forest' ? 'guard' : site.id === 'palace' ? 'guard' : faction === 'villain' ? 'guard' : 'villain';
    site.allegiance = faction === 'guard' && site.id === 'palace' || faction === 'villain' && site.id === 'forest' ? 'friendly' : 'hostile';
  }
  const fortress = world.sites.find(s => s.id === 'fortress')!;
  fortress.faction = faction === 'villain' ? 'guard' : 'villain';
  fortress.allegiance = 'hostile';
  fortress.name = faction === 'villain' ? text('Royal citadel', 'Королевская цитадель') : text('Raut’s invasion redoubt', 'Редут армии Раута');
  if (faction === 'villain') {
    const palace = world.exploration!.locations.find(l => l.id === 'palace-citadel')!;
    Object.assign(fortress, { x: palace.x, z: palace.z });
    const node = world.roads.nodes.find(n => n.id === 'fortress')!;
    node.id = 'old-redoubt';
    for (const edge of world.roads.edges) {
      if (edge.from === 'fortress') edge.from = node.id;
      if (edge.to === 'fortress') edge.to = node.id;
    }
    world.roads.nodes.push({ id: 'fortress', x: palace.x, z: palace.z });
    world.roads.edges.push({ from: 'fortress', to: 'crownbridge', width: 8 });
  }
  const raid = world.sites.find(s => s.id === 'raid')!;
  raid.name = text('Shipment staging point', 'Стоянка груза');
  raid.allegiance = faction === 'guard' ? 'friendly' : 'hostile';
  world.id += `-${faction}-campaign3`;
  return world;
}
