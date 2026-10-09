import { spawn } from "node:child_process";
import { destination, keyName, type Config } from "./config.js";
import { hash } from "./security.js";
import { RivetError } from "./types.js";

// Native credential helpers receive no model-controlled arguments. Secret output is never logged.
async function helper(
  command: string,
  args: string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    const timer = setTimeout(() => {
      p.kill();
      reject(new RivetError("Credential helper timed out", 2));
    }, 10000);
    p.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      if (out.length > 16384) p.kill();
    });
    p.stderr.resume();
    p.on("error", () => {
      clearTimeout(timer);
      reject(
        new RivetError(
          "OS credential helper unavailable; use an environment key",
          2,
        ),
      );
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else
        reject(
          new RivetError(
            "OS credential unavailable; use an environment key",
            2,
          ),
        );
    });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}
export async function credential(
  config: Config,
  sessionKey?: string,
): Promise<string> {
  if (sessionKey) return sessionKey;
  if (config.credential === "environment") {
    const key = process.env[keyName(config)];
    if (!key)
      throw new RivetError(
        `Set ${keyName(config)} or use /key for this process`,
        2,
      );
    return key;
  }
  const account = hash(destination(config));
  if (process.platform === "darwin")
    return helper("security", [
      "find-generic-password",
      "-s",
      "rivet",
      "-a",
      account,
      "-w",
    ]);
  if (process.platform === "linux")
    return helper("secret-tool", [
      "lookup",
      "service",
      "rivet",
      "account",
      account,
    ]);
  // Windows PasswordVault uses WinRT, protecting persisted secrets under the user's OS account.
  return helper("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$ErrorActionPreference='Stop'; [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v=New-Object Windows.Security.Credentials.PasswordVault; $c=$v.Retrieve('rivet','${account}'); $c.RetrievePassword(); [Console]::Write($c.Password)`,
  ]);
}
export async function storeCredential(config: Config, key: string) {
  const account = hash(destination(config));
  if (process.platform === "darwin")
    throw new RivetError(
      "Add a generic password with service rivet and account " +
        account +
        " using Keychain Access; or use environment credentials",
      2,
    );
  if (process.platform === "linux") {
    await helper(
      "secret-tool",
      ["store", "--label=Rivet", "service", "rivet", "account", account],
      key,
    );
    return;
  }
  await helper(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; [void][Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]; $v=New-Object Windows.Security.Credentials.PasswordVault; $k=[Console]::In.ReadToEnd(); $v.Add((New-Object Windows.Security.Credentials.PasswordCredential('rivet','${account}',$k)))`,
    ],
    key,
  );
}
