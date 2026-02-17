import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFfmpegArgs,
  processUploadedVideo,
  selectOptimizationProfiles,
} from "../src/video/videoProcessing.js";

test("selectOptimizationProfiles keeps only profiles that fit the source", () => {
  const profiles = selectOptimizationProfiles({ width: 1280, height: 720 });
  assert.deepEqual(
    profiles.map((profile) => profile.key),
    ["720p", "480p"],
  );
});

test("selectOptimizationProfiles falls back to source profile for tiny videos", () => {
  const profiles = selectOptimizationProfiles({ width: 320, height: 240 });
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].key, "source");
  assert.equal(profiles[0].width, 320);
  assert.equal(profiles[0].height, 240);
});

test("buildFfmpegArgs creates optimized H.264 command", () => {
  const args = buildFfmpegArgs({
    inputPath: "/tmp/input.mov",
    outputPath: "/tmp/output-720p.mp4",
    profile: {
      key: "720p",
      width: 1280,
      height: 720,
      videoBitrateKbps: 2800,
      audioBitrateKbps: 160,
    },
  });

  assert.deepEqual(args.slice(0, 4), ["-y", "-i", "/tmp/input.mov", "-vf"]);
  assert.ok(args.includes("libx264"));
  assert.ok(args.includes("+faststart"));
  assert.ok(args.includes("2800k"));
  assert.ok(args.includes("/tmp/output-720p.mp4"));
});

test("processUploadedVideo runs ffmpeg for each profile and returns outputs", async () => {
  const calls = [];
  const result = await processUploadedVideo({
    inputPath: "/tmp/source.mp4",
    outputDir: "/tmp/processed",
    outputBaseName: "candidate-intro",
    sourceDimensions: { width: 1920, height: 1080 },
    executeCommand: async ({ command, args }) => {
      calls.push({ command, args });
    },
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, "ffmpeg");
  assert.equal(result.outputs.length, 3);
  assert.deepEqual(
    result.outputs.map((output) => output.profile),
    ["1080p", "720p", "480p"],
  );
});
