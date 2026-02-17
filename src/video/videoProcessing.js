import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_PROFILES = [
  { key: "1080p", width: 1920, height: 1080, videoBitrateKbps: 5000, audioBitrateKbps: 192 },
  { key: "720p", width: 1280, height: 720, videoBitrateKbps: 2800, audioBitrateKbps: 160 },
  { key: "480p", width: 854, height: 480, videoBitrateKbps: 1400, audioBitrateKbps: 128 },
];

export const selectOptimizationProfiles = ({ width, height, profiles = DEFAULT_PROFILES }) => {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Video dimensions must be positive numbers");
  }

  const selected = profiles.filter((profile) => {
    return profile.width <= width && profile.height <= height;
  });

  if (selected.length === 0) {
    return [
      {
        key: "source",
        width,
        height,
        videoBitrateKbps: 1000,
        audioBitrateKbps: 128,
      },
    ];
  }

  return selected;
};

export const buildFfmpegArgs = ({ inputPath, outputPath, profile }) => {
  if (!inputPath || !outputPath) {
    throw new Error("inputPath and outputPath are required");
  }
  if (!profile?.width || !profile?.height || !profile?.videoBitrateKbps) {
    throw new Error("A valid optimization profile is required");
  }

  const scaleFilter = `scale=w=${profile.width}:h=${profile.height}:force_original_aspect_ratio=decrease`;

  return [
    "-y",
    "-i",
    inputPath,
    "-vf",
    scaleFilter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-profile:v",
    "main",
    "-movflags",
    "+faststart",
    "-b:v",
    `${profile.videoBitrateKbps}k`,
    "-maxrate",
    `${Math.round(profile.videoBitrateKbps * 1.2)}k`,
    "-bufsize",
    `${profile.videoBitrateKbps * 2}k`,
    "-c:a",
    "aac",
    "-b:a",
    `${profile.audioBitrateKbps || 128}k`,
    outputPath,
  ];
};

const runCommand = ({ command, args }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${command}): ${stderr}`));
        return;
      }
      resolve();
    });
  });

export const processUploadedVideo = async ({
  inputPath,
  outputDir,
  outputBaseName,
  sourceDimensions,
  profiles,
  executeCommand = runCommand,
}) => {
  if (!inputPath || !outputDir || !outputBaseName) {
    throw new Error("inputPath, outputDir and outputBaseName are required");
  }

  await mkdir(outputDir, { recursive: true });

  const selectedProfiles =
    profiles ||
    selectOptimizationProfiles({
      width: sourceDimensions?.width,
      height: sourceDimensions?.height,
    });

  const outputs = [];

  for (const profile of selectedProfiles) {
    const fileName = `${outputBaseName}-${profile.key}.mp4`;
    const outputPath = path.join(outputDir, fileName);
    const args = buildFfmpegArgs({ inputPath, outputPath, profile });

    await executeCommand({ command: "ffmpeg", args });

    outputs.push({
      profile: profile.key,
      width: profile.width,
      height: profile.height,
      outputPath,
      mimeType: "video/mp4",
    });
  }

  return {
    inputPath,
    outputs,
  };
};
