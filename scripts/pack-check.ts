import { packArtifacts } from './release/artifacts.ts';

const artifacts = await packArtifacts(process.argv.includes('--release'));
try {
  console.log(
    `All ${artifacts.items.length} library tarballs passed. ${process.argv.includes('--release') ? 'Final metadata required.' : 'Candidate checks; final license/source metadata is enforced by check:release.'}`,
  );
} finally {
  artifacts.cleanup();
}
