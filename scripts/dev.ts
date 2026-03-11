const tasks = [
  {
    name: "api",
    command: new Deno.Command(Deno.execPath(), {
      args: ["task", "dev:api"],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit"
    }).spawn()
  },
  {
    name: "web",
    command: new Deno.Command(Deno.execPath(), {
      args: ["task", "dev:web"],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit"
    }).spawn()
  }
];

const killSignal = Deno.build.os === "windows" ? "SIGINT" : "SIGTERM";
const listenSignals = Deno.build.os === "windows" ? (["SIGINT", "SIGBREAK"] as const) : (["SIGINT", "SIGTERM"] as const);

const stopAll = () => {
  for (const task of tasks) {
    try {
      Deno.kill(task.command.pid, killSignal);
    } catch {
      // Ignore process already exited.
    }
  }
};

for (const signal of listenSignals) {
  Deno.addSignalListener(signal, () => {
    stopAll();
    Deno.exit(0);
  });
}

const results = await Promise.all(tasks.map(async (task) => ({ name: task.name, status: await task.command.status })));
const failed = results.find((item) => !item.status.success);
if (failed) {
  stopAll();
  Deno.exit(failed.status.code || 1);
}
