// <jy-button> as a model: messages in, state and commands out. No DOM.
import { initial, outputsIn, run, step } from '@gyral/testing';
import { describe, expect, it } from 'vitest';
import { Button, type ButtonProps } from './button.ts';

const { spec } = Button;
const plain: ButtonProps = { toggle: false, pressed: false };
const toggle: ButtonProps = { toggle: true, pressed: false };
const activate = { _tag: 'Activate' } as const;

const outputs = (commands: Parameters<typeof outputsIn>[0]) => outputsIn(commands, Button);

describe('<jy-button> model', () => {
  it('starts from the pressed prop', () => {
    expect(initial(spec, plain).state).toEqual({ pressed: false });
    expect(initial(spec, { toggle: true, pressed: true }).state).toEqual({ pressed: true });
  });

  it('reports activation of a plain button and keeps its state', () => {
    const next = step(spec, { pressed: false }, activate, plain);
    expect(next.state).toEqual({ pressed: false });
    expect(outputs(next.commands)).toEqual([{ _tag: 'Activated' }]);
  });

  it('flips a toggle button and reports the new state', () => {
    const next = step(spec, { pressed: false }, activate, toggle);
    expect(next.state).toEqual({ pressed: true });
    expect(outputs(next.commands)).toEqual([{ _tag: 'Toggled', pressed: true }]);
  });

  it('flips back on a second activation', () => {
    const { states } = run(spec, [activate, activate], { props: toggle, state: { pressed: false } });
    expect(states).toEqual([{ pressed: true }, { pressed: false }]);
  });

  it('follows a parent that changes the pressed prop', () => {
    const changed = { _tag: 'PropsChanged', props: { toggle: true, pressed: true }, prev: toggle } as const;
    expect(step(spec, { pressed: false }, changed, changed.props).state).toEqual({ pressed: true });
  });
});
