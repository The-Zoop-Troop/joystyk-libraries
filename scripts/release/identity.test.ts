import { expect, it } from 'vitest';
import { assertStageEnvironment, RELEASE_REPOSITORY, RELEASE_WORKFLOW } from './identity.ts';

const hosted = {
  NPM_RELEASE_REPOSITORY: 'joystyk-games/game-libraries',
  GITHUB_REPOSITORY: 'joystyk-games/game-libraries',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_ACTIONS: 'true',
  GITHUB_WORKFLOW_REF: 'joystyk-games/game-libraries/.github/workflows/release.yml@refs/heads/main',
  RUNNER_ENVIRONMENT: 'github-hosted',
  NPM_PUBLISHERS_READY: 'true',
};

it('accepts the transferred repository’s main release workflow', () => {
  expect(RELEASE_REPOSITORY).toBe('joystyk-games/game-libraries');
  expect(RELEASE_WORKFLOW).toBe('release.yml');
  expect(() => assertStageEnvironment(hosted)).not.toThrow();
});

it.each([
  { GITHUB_ACTIONS: undefined },
  { GITHUB_REF: 'refs/heads/feature' },
  { RUNNER_ENVIRONMENT: 'self-hosted' },
  { NPM_PUBLISHERS_READY: 'false' },
  { GITHUB_WORKFLOW_REF: 'joystyk-games/game-libraries/.github/workflows/other.yml@refs/heads/main' },
  {
    NPM_RELEASE_REPOSITORY: 'example/fork',
    GITHUB_REPOSITORY: 'example/fork',
    GITHUB_WORKFLOW_REF: 'example/fork/.github/workflows/release.yml@refs/heads/main',
  },
])('rejects staging outside the approved source and publishing context: %j', (change) => {
  expect(() => assertStageEnvironment({ ...hosted, ...change })).toThrow('configured main-only hosted workflow');
});
