// Copyright 2023, Kry10 Limited
// SPDX-License-Identifier: BSD-2-Clause

// Wait for artifacts to become available in another workflow run,
// and optionally download them.

// Currently makes no attempt to handle GitHub API rate limits.
// Downloads might only work for modest artifact file sizes, since
// downloadArtifact slurps whole artifacts into memory.

const fs = require('fs/promises');

const core = require('@actions/core');
const github = require('@actions/github');

async function main() {
  try {
    const repo_full = core.getInput("repo");
    const repo_parts = repo_full.split("/");

    if (repo_parts.length !== 2) {
      throw new Error(`Invalid repository: ${repo_full}`);
    }

    const repo = {
      owner: repo_parts[0],
      repo: repo_parts[1],
    };

    const run_id = core.getInput('run-id');
    const artifact_names = core.getInput('artifact-names').trim().split(/\s+/);

    const download_dir = core.getInput('download-dir');
    if (download_dir) {
      await fs.mkdir(download_dir, {recursive: true});
    }

    const timeout = parseInt(core.getInput('timeout'), 10);
    const token = core.getInput('token');

    const octokit = github.getOctokit(token);

    const artifacts = await workflow_artifacts({
      repo, run_id, artifact_names, download_dir, timeout, octokit
    });

    const artifact_ids = artifact_names.map(name => artifacts.get(name).id);
    core.setOutput('artifact-ids', artifact_ids.join(" "));
  }
  catch (error) {
    core.setFailed(error.message);
  }
}

// Wait up to a timeout for named artifacts to become available in another workflow.
// If a `download_dir` is provided, download artifact zip files to that directory.
// Return artifact resources, as a Map from artifact name to artifact object.
async function workflow_artifacts({repo, run_id, artifact_names, download_dir, timeout, octokit}) {
  // Names of artifacts we're still waiting for.
  const waiting = new Set(artifact_names);

  // Artifacts we've found so far.
  // Map from artifact names to full artifact resources.
  const found = new Map();

  // Track files we still need to download.
  // Serialise downloads to avoid concurrent API requests.
  let to_download = [];
  async function download_pending() {
    if (download_dir) {
      for (const artifact_name of to_download) {
        const artifact = found.get(artifact_name);
        const filename = `${download_dir}/${artifact_name}.zip`;
        console.log(`Downloading ${artifact_name} to ${filename}`);
        const download = await octokit.rest.actions.downloadArtifact({
          ...repo, artifact_id: artifact.id, archive_format: 'zip'
        });
        await fs.writeFile(filename, Buffer.from(download.data));
        console.log(`Downloaded`);
      }
    }
    to_download = [];
  }

  // We keep trying until the timeout, then try once more.
  const time_to_give_up = Date.now() + timeout * 1000;
  let try_again = true;

  while (try_again) {
    console.log(`Waiting for artifacts: ${[...waiting].join(" ")}`);

    // Allow one more try past the timeout.
    if (Date.now() > time_to_give_up) {
      try_again = false;
    }

    // Artifact results might come in multiple pages, so we iterate.
    const artifact_iterator = octokit.paginate.iterator(
      octokit.rest.actions.listWorkflowRunArtifacts,
      { ...repo, run_id, per_page: 100 },
    );

    // On each attempt, first work through all the artifact result pages.
    for await (const {data} of artifact_iterator) {
      for (const artifact of data) {
        if (waiting.has(artifact.name)) {
          console.log(`Found ${artifact.name}`);
          waiting.delete(artifact.name);
          found.set(artifact.name, artifact);
          to_download.push(artifact.name);
        }
      }
      // Return as soon as we have found everything we need.
      if (waiting.size === 0) {
        await download_pending();
        return found;
      }
    }

    // Download any artifacts we've found so far, then try again.
    await download_pending();
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error("Expected artifacts not found");
}

main();
