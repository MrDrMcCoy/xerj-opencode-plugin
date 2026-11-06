import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cargoDependencies,
  classifyDependencies,
  detectTech,
  goDependencies,
  packageDependencies,
  pythonRequirements,
  runtimeVersions,
  usedVersion,
} from "../../src/prjdocs/detect.ts";

describe("usedVersion", () => {
  test("reads the version out of a range", () => {
    expect(usedVersion("^5.4.2")).toBe("5.4.2");
    expect(usedVersion("~3.13")).toBe("3.13");
    expect(usedVersion(">=1.2.3 <2")).toBe("1.2.3");
    expect(usedVersion("latest")).toBeNull();
    expect(usedVersion("*")).toBeNull();
  });
});

describe("packageDependencies", () => {
  test("reads dependencies and devDependencies", () => {
    const deps = packageDependencies(
      JSON.stringify({
        dependencies: { react: "^18.2.0", "@aws-sdk/client-s3": "^3.500.0" },
        devDependencies: { typescript: "~5.4.0" },
        peerDependencies: { hono: "^4.0.0" },
      }),
    );

    expect(deps.map((entry) => entry.name)).toEqual([
      "react",
      "@aws-sdk/client-s3",
      "typescript",
      "hono",
    ]);
  });

  test("a broken manifest is not an error", () => {
    expect(packageDependencies("{ not json")).toEqual([]);
  });
});

describe("pythonRequirements", () => {
  test("reads pinned and ranged requirements, dropping markers and comments", () => {
    const deps = pythonRequirements(
      [
        "# comment",
        "django>=4.2,<5",
        "requests==2.31.0",
        "uvicorn[standard]==0.29.0",
        "-r other.txt",
        "pydantic ; python_version > '3.9'",
      ].join("\n"),
    );

    expect(deps.map((entry) => entry.name)).toEqual([
      "django",
      "requests",
      "uvicorn",
      "pydantic",
    ]);
    expect(deps[0]?.version).toBe("4.2");
    expect(deps[1]?.version).toBe("2.31.0");
  });
});

describe("cargoDependencies", () => {
  test("reads simple and table dependencies", () => {
    const deps = cargoDependencies(
      [
        "[package]",
        'name = "demo"',
        "[dependencies]",
        'serde = "1.0"',
        'axum = { version = "0.7", features = ["json"] }',
        "[dev-dependencies]",
        'tokio = "1.38"',
        "[other]",
        'ignored = "9"',
      ].join("\n"),
    );

    expect(deps.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "serde@1.0",
      "axum@0.7",
      "tokio@1.38",
    ]);
  });
});

describe("goDependencies", () => {
  test("reads a require block and a single require", () => {
    const deps = goDependencies(
      [
        "module example.com/demo",
        "require github.com/gin-gonic/gin v1.9.1",
        "require (",
        "\tgithub.com/stripe/stripe-go v72.0.0",
        "\tgolang.org/x/net v0.20.0",
        ")",
      ].join("\n"),
    );

    expect(deps.map((entry) => entry.name)).toEqual([
      "github.com/gin-gonic/gin",
      "github.com/stripe/stripe-go",
      "golang.org/x/net",
    ]);
    expect(deps[0]?.version).toBe("1.9.1");
  });
});

describe("classifyDependencies", () => {
  test("separates frameworks from cloud APIs", () => {
    const refs = classifyDependencies(
      [
        { name: "react", version: "^18.2.0" },
        { name: "@aws-sdk/client-s3", version: "^3.0.0" },
        { name: "@google-cloud/storage", version: "^7.0.0" },
        { name: "stripe", version: "^14.0.0" },
        { name: "left-pad", version: "1.0.0" },
      ],
      "package.json",
    );

    expect(refs.map((ref) => `${ref.id}:${ref.kind}`)).toEqual([
      "react:framework",
      "aws:cloud",
      "gcp:cloud",
      "stripe:cloud",
    ]);
    expect(refs[0]?.used).toBe("18.2.0");
  });
});

describe("detectTech", () => {
  test("combines manifests with file extensions", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "requirements.txt": "django>=4.2\n",
    };

    const refs = await detectTech("/proj", {
      readManifest: async (path: string) => files[path.split("/").pop() ?? ""] ?? null,
      extensions: {
        names: ["package.json", "requirements.txt", "src/a.ts", "src/b.py"],
        extensionCounts: { ".ts": 3, ".py": 2 },
      },
    });

    expect(refs.map((ref) => ref.id).sort()).toEqual([
      "django",
      "python",
      "react",
      "typescript",
    ]);
    // A declared version is kept; a language found by extension has none.
    const python = refs.find((ref) => ref.id === "python");
    expect(python?.used).toBeNull();
    expect(python?.evidence).toBe("2 .py files");
  });
});

describe("runtimeVersions", () => {
  test("reads version pins from the files that hold them", () => {
    const versions = runtimeVersions({
      ".nvmrc": "v20.11.1\n",
      ".python-version": "3.13\n",
      "rust-toolchain.toml": '[toolchain]\nchannel = "1.75.0"\n',
      "go.mod": "module x\n\ngo 1.22\n",
      "package.json": JSON.stringify({ engines: { node: ">=20.6" } }),
    });

    expect(versions).toEqual(
      expect.arrayContaining([
        { id: "node", version: "20.11.1" },
        { id: "python", version: "3.13" },
        { id: "rust", version: "1.75.0" },
        { id: "go", version: "1.22" },
      ]),
    );
  });

  test("ignores versions that are not numbers", () => {
    expect(runtimeVersions({ ".nvmrc": "lts/*" })).toEqual([]);
  });
});

describe("detectTech with a runtime pin", () => {
  test("a pinned runtime version is kept on the language entry", async () => {
    const files: Record<string, string> = { ".nvmrc": "20.11.1" };

    const refs = await detectTech("/proj", {
      readManifest: async (path: string) => files[path.split("/").pop() ?? ""] ?? null,
      extensions: {
        names: [".nvmrc", "src/a.ts"],
        extensionCounts: { ".ts": 1 },
      },
    });

    const node = refs.find((ref) => ref.id === "node");
    expect(node?.used).toBe("20.11.1");
    expect(node?.kind).toBe("language");
  });
});

describe("GPU stacks through detectTech", () => {
  test("a CUDA project reports cuda with the version its build file pins", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-gpu-"));
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "kernel.cu"), "__global__ void k() {}\n");
    await writeFile(
      join(project, "CMakeLists.txt"),
      "find_package(CUDAToolkit 12.4 REQUIRED)\n",
    );

    const refs = await detectTech(project);
    const cuda = refs.find((ref) => ref.id === "cuda");

    expect(cuda?.kind).toBe("framework");
    expect(cuda?.used).toBe("12.4");

    await rm(project, { recursive: true, force: true });
  });

  test("a Vulkan shader and a build file report vulkan", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-vk-"));
    await mkdir(join(project, "shaders"), { recursive: true });
    await writeFile(
      join(project, "shaders", "triangle.vert"),
      "#version 450\n#include <vulkan/vulkan.h>\n",
    );

    const refs = await detectTech(project);

    expect(refs.some((ref) => ref.id === "vulkan")).toBe(true);

    await rm(project, { recursive: true, force: true });
  });

  test("a project with no GPU toolchain reports none of them", async () => {
    const project = await mkdtemp(join(tmpdir(), "xerj-nogpu-"));
    await writeFile(join(project, "index.ts"), "export const x = 1;\n");

    const refs = await detectTech(project);

    expect(refs.filter((ref) => ["cuda", "rocm", "sycl", "vulkan"].includes(ref.id))).toEqual(
      [],
    );

    await rm(project, { recursive: true, force: true });
  });
});

describe("GPU packages", () => {
  test("a python GPU package names its stack", () => {
    const refs = classifyDependencies(
      pythonRequirements("cupy-cuda12x==13.2.0\npycuda==2024.1\n"),
      "requirements.txt",
    );

    expect(refs.map((ref) => ref.id)).toEqual(["cuda"]);
    expect(refs[0]?.used).toBe("13.2.0");
  });

  test("a Rust Vulkan crate names Vulkan", () => {
    const refs = classifyDependencies(
      cargoDependencies('[dependencies]\nvulkano = "0.34"\n'),
      "Cargo.toml",
    );

    expect(refs.map((ref) => ref.id)).toEqual(["vulkan"]);
  });
});
