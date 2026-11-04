import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellCommands, shellReadPaths } from "../../src/remote/shell.ts";

const root = await mkdtemp(join(tmpdir(), "xerj-shell-"));
afterAll(async () => rm(root, { recursive: true, force: true }));

describe("shellCommands", () => {
  test("splits operators and keeps quoted spaces", () => {
    expect(shellCommands(`cat "a b.md" > out.txt && grep x file`)).toEqual([
      ["cat", "a b.md"],
      ["grep", "x", "file"],
    ]);
  });

  test("drops redirection targets and their descriptor", () => {
    expect(shellCommands("cat file 2> /tmp/err")).toEqual([["cat", "file"]]);
  });
});

describe("shellReadPaths", () => {
  let cwd = "";
  beforeAll(async () => {
    cwd = await mkdtemp(join(root, "cwd-"));
    await writeFile(join(cwd, "a.md"), "a");
    await writeFile(join(cwd, "b.md"), "b");
    await writeFile(join(cwd, "pattern"), "p");
    await mkdir(join(cwd, "scripts"));
    await writeFile(join(cwd, "scripts", "gen.sh"), "echo hi");
    await mkdir(join(cwd, "folder"));
  });

  test("collects arguments of any command that exist as files", async () => {
    expect(await shellReadPaths("cat a.md b.md", cwd)).toEqual([
      join(cwd, "a.md"),
      join(cwd, "b.md"),
    ]);
  });

  test("indexes grep and rg targets, not the pattern", async () => {
    const result = await shellReadPaths(`rg "todo" b.md`, cwd);
    expect(result).toEqual([join(cwd, "b.md")]);
  });

  test("indexes a script executed by path", async () => {
    expect(await shellReadPaths("./scripts/gen.sh", cwd)).toEqual([
      join(cwd, "scripts/gen.sh"),
    ]);
  });

  test("keeps absolute paths and quoted names", async () => {
    const quoted = join(root, "a b.md");
    await writeFile(quoted, "q");
    const hosts = "/etc/hosts";
    expect(await shellReadPaths(`cat "${quoted}" ${hosts}`, cwd)).toEqual([
      quoted,
      hosts,
    ]);
  });

  test("follows cd within one command chain", async () => {
    expect(await shellReadPaths("cd scripts && cat gen.sh", cwd)).toEqual([
      join(cwd, "scripts/gen.sh"),
    ]);
  });

  test("skips redirection targets", async () => {
    expect(await shellReadPaths("cat a.md > out.txt", cwd)).toEqual([
      join(cwd, "a.md"),
    ]);
  });

  test("skips the value of a short option", async () => {
    expect(await shellReadPaths("head -n 20 a.md", cwd)).toEqual([
      join(cwd, "a.md"),
    ]);
    expect(await shellReadPaths("grep -e pattern b.md", cwd)).toEqual([
      join(cwd, "b.md"),
    ]);
  });

  test("reads through a pipe", async () => {
    expect(await shellReadPaths("cat a.md | grep x", cwd)).toEqual([
      join(cwd, "a.md"),
    ]);
  });

  test("ignores variables, globs, directories, and missing files", async () => {
    expect(await shellReadPaths("cat $FILE", cwd)).toEqual([]);
    expect(await shellReadPaths("cat *.md", cwd)).toEqual([]);
    expect(await shellReadPaths("ls folder", cwd)).toEqual([]);
    expect(await shellReadPaths("cat absent.md", cwd)).toEqual([]);
  });

  test("indexes files read inside a command substitution", async () => {
    expect(await shellReadPaths("echo $(cat b.md) a.md", cwd)).toEqual([
      join(cwd, "b.md"),
      join(cwd, "a.md"),
    ]);
    expect(await shellReadPaths("echo `cat b.md`", cwd)).toEqual([
      join(cwd, "b.md"),
    ]);
  });

  test("does not expand inside single quotes", async () => {
    expect(await shellReadPaths("echo '$(cat b.md)'", cwd)).toEqual([]);
  });

  test("indexes the argument file xargs reads from", async () => {
    expect(await shellReadPaths("xargs -a b.md echo", cwd)).toEqual([
      join(cwd, "b.md"),
    ]);
    expect(await shellReadPaths("xargs --arg-file=b.md echo", cwd)).toEqual([
      join(cwd, "b.md"),
    ]);
  });

  test("follows cd inside a subshell", async () => {
    await writeFile(join(cwd, "folder", "inner.md"), "i");
    expect(await shellReadPaths("(cd folder && cat inner.md)", cwd)).toEqual([
      join(cwd, "folder", "inner.md"),
    ]);
  });

  test("caps how many files one command can produce", async () => {
    const many = Array.from({ length: 12 }, (_, index) => "a.md").join(" ");
    const paths = await shellReadPaths(`cat ${many}`, cwd);
    expect(paths).toHaveLength(1);
  });
});
