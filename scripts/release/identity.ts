import * as z from 'zod/mini';

export const RELEASE_REPOSITORY = 'joystyk-games/game-libraries';
export const RELEASE_REPOSITORY_URL = `git+https://github.com/${RELEASE_REPOSITORY}.git`;
export const RELEASE_WORKFLOW = 'release.yml';
export const NPM_REGISTRY = 'https://registry.npmjs.org';

const hostedRelease = z.object({
  NPM_RELEASE_REPOSITORY: z.literal(RELEASE_REPOSITORY),
  GITHUB_REPOSITORY: z.literal(RELEASE_REPOSITORY),
  GITHUB_REF: z.literal('refs/heads/main'),
  GITHUB_ACTIONS: z.literal('true'),
  GITHUB_WORKFLOW_REF: z.literal(`${RELEASE_REPOSITORY}/.github/workflows/${RELEASE_WORKFLOW}@refs/heads/main`),
  RUNNER_ENVIRONMENT: z.literal('github-hosted'),
  NPM_PUBLISHERS_READY: z.literal('true'),
});

export const assertStageEnvironment = (env: Readonly<Record<string, string | undefined>>): void => {
  if (!hostedRelease.safeParse(env).success)
    throw new Error('Staging requires the configured main-only hosted workflow and confirmed per-package publishers');
};
