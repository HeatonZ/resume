const npmCmd = Deno.build.os === "windows" ? "npm.cmd" : "npm";

const child = new Deno.Command(npmCmd, {
  args: ["run", "build"],
  cwd: "frontend",
  stdout: "inherit",
  stderr: "inherit",
  stdin: "inherit"
}).spawn();

const status = await child.status;
Deno.exit(status.success ? 0 : status.code || 1);
