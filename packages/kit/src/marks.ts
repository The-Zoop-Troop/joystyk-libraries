/** Duplicate-aware two-pass marking for equal-length symbol puzzles. */
export type SymbolMark = 'absent' | 'wrong' | 'right';
export const markGuess = (guess: string, answer: string): SymbolMark[] => {
  const marks: SymbolMark[] = Array.from({ length: guess.length }, () => 'absent');
  const unused = new Map<string, number>();
  for (let i = 0; i < guess.length; i++) {
    const letter = answer[i] ?? '';
    if (guess[i] === letter) marks[i] = 'right';
    else unused.set(letter, (unused.get(letter) ?? 0) + 1);
  }
  for (let i = 0; i < guess.length; i++) {
    if (marks[i] === 'right') continue;
    const letter = guess[i] ?? '';
    const left = unused.get(letter) ?? 0;
    if (left > 0) {
      marks[i] = 'wrong';
      unused.set(letter, left - 1);
    }
  }
  return marks;
};
