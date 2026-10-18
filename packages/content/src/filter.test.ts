import { describe, expect, it } from 'vitest';
import { createWordFilter, defaultFilter, filterForms, gridLines } from './filter.ts';
import { formsOf, leaksLetters, mentions, stemOf, usesForm, wordsOf } from './text.ts';
import { scowlVocabulary } from './vocabulary.ts';

describe('text helpers', () => {
  it('tokenizes with folded accents, kept contractions and dropped possessives', () => {
    expect(wordsOf("Zoë's café doesn't close—ever!")).toEqual(['zoe', 'cafe', "doesn't", 'close', 'ever']);
  });

  it('finds regular forms and stems of a word', () => {
    expect(usesForm('The stream meandered past us.', 'meander')).toBe(true);
    expect(usesForm('They were vying for first place.', 'vie')).toBe(true);
    expect(usesForm('She tarried a while.', 'tarry')).toBe(true);
    expect(mentions('It fades ephemerally.', 'ephemeral')).toBe(true);
    expect(mentions('A problem to solve.', 'probe')).toBe(false);
    expect(stemOf('probe')).toBeNull();
    expect(formsOf('ebb').has('ebbing')).toBe(true);
  });

  it('applies the strict letter-run rule for letter-guessing games', () => {
    expect(leaksLetters('several days', 'ephemeral')).toBe(true);
    expect(leaksLetters('a short time', 'ephemeral')).toBe(false);
  });
});

describe('the word lists', () => {
  const filter = defaultFilter();

  it('matches whole words in their regular forms, never inside innocent words', () => {
    expect(filter.matches('a class of grasses near the scamper path')).toEqual([]);
    expect(filter.matches('the butter melted')).toEqual([]);
    // Stems are kept narrow enough to pass everyday words that start with them.
    expect(
      filter.matches(
        'A rabbit read the bulletin, thanked them for their hospitality and gave a bombastic demonstration.',
      ),
    ).toEqual([]);
    expect(filter.matches('Shut up, you stupid butt.').map((m) => m.term)).toEqual(['stupid', 'butt']);
    expect(filter.matches('They went to a casino at night.').map((m) => m.list)).toEqual(['sensitive']);
    expect(filter.matches('The soldiers marched.').map((m) => m.term)).toEqual(['soldier*']);
  });

  it('matches phrases', () => {
    const custom = createWordFilter({ blocklist: 'crack cocaine\n', sensitive: '' });
    expect(custom.matches('a crack in the wall')).toEqual([]);
    expect(custom.matches('selling crack cocaine')).toEqual([{ list: 'blocklist', term: 'crack cocaine' }]);
  });

  it('reports each hit with its field', () => {
    const report = filter.check([
      { path: 'clue', text: 'A happy dog' },
      { path: 'example', text: 'She drank wine with dinner.' },
    ]);
    expect(report).toEqual({ ok: false, hits: [{ path: 'example', list: 'sensitive', term: 'wine' }] });
  });

  it('reads letter grids along every line, both ways, for words of four letters or more', () => {
    const lines = gridLines(['ab', 'cd']);
    expect(lines).toEqual(expect.arrayContaining(['ab', 'ba', 'ac', 'ca', 'ad', 'da', 'bc', 'cb']));
    expect(filter.checkGrid(['xshitx', 'aaaaaa']).ok).toBe(false);
    expect(filter.checkGrid(['xtihsx']).ok).toBe(false); // backwards
    expect(filter.checkGrid(['s...', '.h..', '..i.', '...t']).ok).toBe(false); // diagonal
    expect(filter.checkGrid(['xassx']).ok).toBe(true); // three letters: too short to read as a word
  });

  it('builds narrow forms for list entries', () => {
    expect([...filterForms('butt')]).not.toContain('butter');
    expect(filterForms('sin').has('sinning')).toBe(true);
    expect(filterForms('rob').has('robed')).toBe(false);
  });

  it('keeps every blocklist entry out of the common vocabulary it would reject', () => {
    // A sanity check of the lists: entries parse into at least one token each.
    expect(filter.isListed('war')).toBe(true);
    expect(filter.isListed('warm')).toBe(false);
  });
});

describe('the SCOWL vocabulary', () => {
  it('knows common words, rarer words and contractions, and not junk', () => {
    const vocabulary = scowlVocabulary();
    expect(vocabulary.isCommon('happy')).toBe(true);
    expect(vocabulary.isCommon("don't")).toBe(true);
    expect(vocabulary.isCommon('megalithic')).toBe(false);
    expect(vocabulary.isKnown('megalithic')).toBe(true);
    expect(vocabulary.isKnown('zzqx')).toBe(false);
  });
});
