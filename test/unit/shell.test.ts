import { describe, expect, test } from "bun:test";
import { shellCommands, shellReadPaths } from "../../src/remote/shell.ts";

describe("shellCommands", () => {
  test("splits operators and keeps quoted spaces", () => {
    expect(shellCommands(`cat "a b.md" > out.txt && grep x file`)).toEqual([
      ["cat", "a b.md"],
      ["grep", "x", "file"],
    ]);
  });

  test("drops redirection targets", () => {
    expect(shellCommands("cat file 2> /tmp/err")).toEqual([["cat", "file"]]);
  });
});

describe("shellReadPaths", () => {
  const cwd = "/repo";

  test("collects cat arguments", () => {
    expect(shellReadPaths("cat a.md b.md", cwd)).toEqual([
      "/repo/a.md",
      "/repo/b.md",
    ]);
  });

  test("keeps absolute paths and quoted names", () => {
    expect(shellReadPaths(`cat "/tmp/a b.md" /etc/hosts`, cwd)).toEqual([
      "/tmp/a b.md",
      "/etc/hosts",
    ]);
  });

  test("follows cd within one command chain", () => {
    expect(shellReadPaths("cd /tmp && cat note.md", cwd)).toEqual(["/tmp/note.md"]);
  });

  test("skips redirection targets", () => {
    expect(shellReadPaths("cat file.md > out.txt", cwd)).toEqual(["/repo/file.md"]);
  });

  test("accepts wrappers and head options", () => {
    expect(shellReadPaths("sudo head -n 20 /var/log/app.log", cwd)).toEqual([
      "/var/log/app.log",
    ]);
  });

  test("reads through a pipe", () => {
    expect(shellReadPaths("cat log.txt | grep error", cwd)).toEqual([
      "/repo/log.txt",
    ]);
  });

  test("skips sed scripts and in-place edits", () => {
    expect(shellReadPaths("sed -n 1,5p file.md", cwd)).toEqual(["/repo/file.md"]);
    expect(shellReadPaths("sed -i s/a/b/ file.md", cwd)).toEqual([]);
  });

  test("ignores variables, globs, and non-read commands", () => {
    expect(shellReadPaths("cat $FILE", cwd)).toEqual([]);
    expect(shellReadPaths("cat *.md", cwd)).toEqual([]);
    expect(shellReadPaths("rm file.md", cwd)).toEqual([]);
  });
});
