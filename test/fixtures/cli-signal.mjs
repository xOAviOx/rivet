// Windows does not support sending POSIX SIGINT with child.kill(). Exercise the
// CLI's real process signal listener through IPC without changing production code.
process.on("message", (message) => {
  if (message === "interrupt") process.emit("SIGINT");
});
process.channel?.unref();
await import("../../dist/cli.js");
