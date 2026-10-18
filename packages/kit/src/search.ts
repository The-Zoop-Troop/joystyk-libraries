/** Deterministic depth-first proof search with an explicit node budget. A budget exhaustion
 * is not a proof of impossibility. Keys must capture every fact that affects successors. */
export type SearchVerdict = 'winnable' | 'unwinnable' | 'unproven';
export const boundedSearch = <S, M>(
  start: S,
  spec: {
    readonly key: (state: S) => string;
    readonly won: (state: S) => boolean;
    readonly next: (state: S) => readonly { readonly state: S; readonly move: M }[];
    readonly budget: number;
    /** Depth bounds are a stop, never evidence that a deal is impossible. */
    readonly maxDepth?: number;
  },
): { readonly verdict: SearchVerdict; readonly path: readonly M[]; readonly nodes: number } => {
  const seen = new Map<string, number>();
  let exhausted = false;
  let nodes = 0;
  const path: M[] = [];
  type Frame = { readonly state: S; steps?: readonly { readonly state: S; readonly move: M }[]; cursor: number };
  const stack: Frame[] = [{ state: start, cursor: 0 }];
  const pop = () => {
    stack.pop();
    if (stack.length > 0) path.pop();
  };
  // An explicit stack avoids overflowing JavaScript's call stack on a long proof.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.steps === undefined) {
      if (spec.won(frame.state)) return { verdict: 'winnable', path: [...path], nodes };
      const key = spec.key(frame.state);
      const earlier = seen.get(key);
      if (earlier !== undefined && earlier <= path.length) {
        pop();
        continue;
      }
      if (nodes >= spec.budget) {
        exhausted = true;
        break;
      }
      seen.set(key, path.length);
      nodes += 1;
      frame.steps = spec.next(frame.state);
      if (path.length >= (spec.maxDepth ?? Infinity) && frame.steps.length > 0) {
        exhausted = true;
        pop();
        continue;
      }
    }
    const step = frame.steps[frame.cursor++];
    if (step === undefined) {
      pop();
      continue;
    }
    path.push(step.move);
    stack.push({ state: step.state, cursor: 0 });
  }
  return { verdict: exhausted ? 'unproven' : 'unwinnable', path: [], nodes };
};
