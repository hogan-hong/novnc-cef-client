const { spawnSync } = require("child_process");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

const nativeStatus = run("npm", ["run", "build:native"]);
if (nativeStatus !== 0) {
  console.warn("Native addon build failed; continuing with app packaging.");
}

const builderStatus = run(
  process.execPath,
  [
    require.resolve("electron-builder/cli/cli"),
    "--win",
    "--publish",
    "never",
    "--config.compression=store",
  ],
  { shell: false }
);

process.exit(builderStatus);
