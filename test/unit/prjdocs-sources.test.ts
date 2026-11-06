import { describe, expect, test } from "bun:test";
import { docsTargets, maxPagesFor } from "../../src/prjdocs/sources.ts";

describe("GPU documentation sources", () => {
  test("CUDA docs follow the archive layout, used and latest", () => {
    const targets = docsTargets(
      { id: "cuda", kind: "framework", used: "12.4", evidence: "Dockerfile" },
      "12.10.1",
    );

    expect(targets.map((target) => target.version)).toEqual(["12.4.0", "12.10.1"]);
    expect(targets[0]?.url).toBe("https://docs.nvidia.com/cuda/archive/12.4.0/index.html");
    expect(targets[1]?.url).toContain("/archive/12.10.1/");
  });

  test("CUDA with no known version falls back to the current guide", () => {
    const targets = docsTargets(
      { id: "cuda", kind: "framework", used: null, evidence: ".cu files" },
      null,
    );

    expect(targets).toHaveLength(1);
    expect(targets[0]?.url).toBe("https://docs.nvidia.com/cuda/index.html");
    expect(targets[0]?.version).toBe("latest");
  });

  test("ROCm docs use the docs-<version> path", () => {
    const targets = docsTargets(
      { id: "rocm", kind: "framework", used: "6.2", evidence: "Dockerfile" },
      null,
    );

    expect(targets[0]?.url).toBe("https://rocm.docs.amd.com/en/docs-6.2.0/");
    expect(targets[0]?.version).toBe("6.2.0");
  });

  test("SYCL and Vulkan are unversioned and always produce one target", () => {
    const sycl = docsTargets({ id: "sycl", kind: "framework", used: null, evidence: "x" }, null);
    const vulkan = docsTargets(
      { id: "vulkan", kind: "framework", used: "1.3.290", evidence: "x" },
      null,
    );

    expect(sycl[0]?.url).toBe("https://registry.khronos.org/SYCL/");
    // The specification is one 4 MB page, so the source carries a byte limit.
    expect(sycl[0]?.maxBytes).toBe(6_000_000);
    expect(sycl[0]?.version).toBe("latest");
    expect(vulkan[0]?.url).toBe("https://docs.vulkan.org/guide/latest/index.html");
    expect(maxPagesFor("vulkan")).toBe(15);
  });
});

describe("version boundaries", () => {
  test("a versioned target carries the directory it must stay inside", () => {
    const rocm = docsTargets(
      { id: "rocm", kind: "framework", used: "6.2", evidence: "Dockerfile" },
      null,
    );

    expect(rocm[0]?.urlPrefix).toBe("https://rocm.docs.amd.com/en/docs-6.2.0/");
  });

  test("Node keeps its crawl inside one major version", () => {
    const node = docsTargets(
      { id: "node", kind: "language", used: "22", evidence: ".nvmrc" },
      "24",
    );

    expect(node.map((target) => target.urlPrefix)).toEqual([
      "https://nodejs.org/docs/latest-v22.x/api/",
      "https://nodejs.org/docs/latest-v24.x/api/",
    ]);
  });

  test("an unversioned source has no boundary", () => {
    const vulkan = docsTargets(
      { id: "vulkan", kind: "framework", used: null, evidence: "shader" },
      null,
    );

    expect(vulkan[0]?.urlPrefix).toBeUndefined();
  });
});
