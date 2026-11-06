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
    expect(maxPagesFor("vulkan")).toBe(120);
    // The specification is published chapter by chapter.
    expect(vulkan[0]?.seeds?.length ?? 0).toBeGreaterThan(1);
  });

  test("oneAPI stays inside the specification section", () => {
    const oneapi = docsTargets(
      { id: "oneapi", kind: "framework", used: "2024.2", evidence: "Dockerfile" },
      null,
    );

    expect(oneapi[0]?.url).toBe("https://uxlfoundation.org/specifications/oneapi/");
    expect(oneapi[0]?.urlPrefix).toBe("https://uxlfoundation.org/specifications/oneapi/");
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

describe("component guides", () => {
  test("CUDA names every library the toolkit ships", () => {
    const cuda = docsTargets(
      { id: "cuda", kind: "framework", used: "12.4", evidence: "Dockerfile" },
      null,
    )[0];
    const seeds = (cuda?.seeds ?? []).map((seed) => seed.url);

    for (const component of ["cublas", "cufft", "cusolver", "cusparse", "npp"]) {
      expect(seeds.some((url) => url.includes(`/12.4.0/${component}/`))).toBe(true);
    }
    expect(seeds.some((url) => url.includes("docs.nvidia.com/deeplearning/cudnn"))).toBe(true);
  });

  test("ROCm names its libraries under their versioned project paths", () => {
    const rocm = docsTargets(
      { id: "rocm", kind: "framework", used: "10.1", evidence: "Dockerfile" },
      null,
    )[0];
    const seeds = (rocm?.seeds ?? []).map((seed) => seed.url);

    expect(seeds).toContain("https://rocm.docs.amd.com/projects/rocBLAS/en/docs-10.1.0/");
    expect(seeds).toContain("https://rocm.docs.amd.com/projects/MIOpen/en/docs-10.1.0/");
    expect(seeds.length).toBeGreaterThanOrEqual(15);
  });

  test("a seed stays inside its own guide directory", () => {
    const rocm = docsTargets(
      { id: "rocm", kind: "framework", used: "10.1", evidence: "Dockerfile" },
      null,
    )[0];
    const seed = (rocm?.seeds ?? []).find((entry) => entry.url.includes("rocBLAS"));

    expect(seed?.prefix).toBe("https://rocm.docs.amd.com/projects/rocBLAS/en/docs-10.1.0/");
  });

  test("a versioned source without a version drops versioned seeds", () => {
    const cuda = docsTargets(
      { id: "cuda", kind: "framework", used: null, evidence: ".cu files" },
      null,
    )[0];

    // The fallback has no version path, so archive seeds cannot be built.
    expect(cuda?.seeds ?? []).toEqual([]);
  });
});

describe("automation and infrastructure sources", () => {
  test("each ecosystem has a docs source", () => {
    for (const id of [
      "ansible",
      "ansible-collections",
      "netbox",
      "terraform",
      "terraform-language",
      "vault",
      "consul",
      "nomad",
      "packer",
      "vagrant",
      "boundary",
      "waypoint",
    ]) {
      const targets = docsTargets({ id, kind: "framework", used: null, evidence: "x" }, null);
      expect(targets).toHaveLength(1);
      expect(targets[0]?.url.startsWith("https://")).toBe(true);
    }
  });

  test("Ansible stays inside its own tree", () => {
    const ansible = docsTargets(
      { id: "ansible", kind: "framework", used: null, evidence: "site.yml" },
      null,
    )[0];

    expect(ansible?.urlPrefix).toBe("https://docs.ansible.com/ansible/latest/");
    expect(ansible?.seeds?.length).toBeGreaterThan(0);
  });

  test("a HashiCorp product stays inside its product path", () => {
    const vault = docsTargets(
      { id: "vault", kind: "framework", used: null, evidence: "policies" },
      null,
    )[0];

    expect(vault?.url).toBe("https://developer.hashicorp.com/vault/docs");
    expect(vault?.urlPrefix).toBe("https://developer.hashicorp.com/vault/");
  });

  test("Terraform's language reference is its own source", () => {
    const language = docsTargets(
      { id: "terraform-language", kind: "framework", used: null, evidence: "x" },
      null,
    )[0];

    expect(language?.url).toBe("https://developer.hashicorp.com/terraform/language");
  });
});
