import { describe, test } from 'vitest';
import { factionAcceptance, factionAcceptanceCases, factionAcceptanceTitle } from './faction-acceptance';

describe('substantive faction campaign acceptance through public inputs', () => {
  test.each(factionAcceptanceCases.filter(({ faction, directive }) => faction === 'elf' && directive === 'interdict'))(
    factionAcceptanceTitle, factionAcceptance, 300_000);
});
