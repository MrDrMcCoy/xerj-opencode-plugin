import { describe, expect, test } from "bun:test";
import { detectGpuStacks } from "../../src/prjdocs/gpu.ts";

function files(names: string[], counts: Record<string, number> = {}) {
  return { names, extensionCounts: counts };
}

function reader(texts: Record<string, string>) {
  return async (path: string): Promise<string | null> => texts[path] ?? null;
}

const root = "/project";

describe("detectGpuStacks", () => {
  test("a .cu file proves CUDA without reading anything", async () => {
    const stacks = await detectGpuStacks(
      files(["src/kernel.cu"], { ".cu": 2 }),
      reader({}),
      root,
    );

    expect(stacks.map((stack) => stack.id)).toEqual(["cuda"]);
    expect(stacks[0]?.evidence).toContain("2 .cu files");
    expect(stacks[0]?.used).toBeNull();
  });

  test("CUDA headers and a version in a Dockerfile are both found", async () => {
    const stacks = await detectGpuStacks(
      files(["src/main.cpp", "Dockerfile"]),
      reader({
        [`${root}/src/main.cpp`]: '#include <cuda_runtime.h>\n__global__ void k() {}\n',
        [`${root}/Dockerfile`]: "FROM nvidia/cuda:12.4.1-devel-ubuntu22.04\n",
      }),
      root,
    );

    const cuda = stacks.find((stack) => stack.id === "cuda");
    expect(cuda?.used).toBe("12.4");
    expect(cuda?.evidence).toContain("main.cpp");
  });

  test("HIP headers prove ROCm, with the image tag as its version", async () => {
    const stacks = await detectGpuStacks(
      files(["hip/kernels.hip", "Dockerfile"]),
      reader({
        [`${root}/hip/kernels.hip`]: '#include <hip/hip_runtime.h>\nhipMalloc(nullptr, 1);\n',
        [`${root}/Dockerfile`]: "FROM rocm/dev-ubuntu-22.04:6.2.1\n",
      }),
      root,
    );

    const rocm = stacks.find((stack) => stack.id === "rocm");
    expect(rocm?.used).toBe("6.2");
    expect(stacks.some((stack) => stack.id === "cuda")).toBe(false);
  });

  test("a SYCL queue and the sycl header find SYCL", async () => {
    const stacks = await detectGpuStacks(
      files(["src/queue.cpp"]),
      reader({
        [`${root}/src/queue.cpp`]:
          "#include <sycl/sycl.hpp>\nint main(){ sycl::queue q; }\n",
      }),
      root,
    );

    expect(stacks.find((stack) => stack.id === "sycl")?.used).toBeNull();
  });

  test("a Vulkan build file is enough", async () => {
    const stacks = await detectGpuStacks(
      files(["CMakeLists.txt"]),
      reader({
        [`${root}/CMakeLists.txt`]: "find_package(Vulkan REQUIRED)\ntarget_link_libraries(app Vulkan::Vulkan)\n",
      }),
      root,
    );

    expect(stacks.find((stack) => stack.id === "vulkan")).toBeDefined();
  });

  test("the Vulkan SDK version is taken when one is set", async () => {
    const stacks = await detectGpuStacks(
      files(["shaders/basic.vert", "Makefile"]),
      reader({
        [`${root}/shaders/basic.vert`]: "#version 450\n#include <vulkan/vulkan.h>\n",
        [`${root}/Makefile`]: "VULKAN_SDK=1.3.290\n",
      }),
      root,
    );

    expect(stacks.find((stack) => stack.id === "vulkan")?.used).toBe("1.3.290");
  });

  test("oneMKL and Level Zero headers prove oneAPI", async () => {
    const stacks = await detectGpuStacks(
      files(["src/mkl.cpp"]),
      reader({
        [`${root}/src/mkl.cpp`]:
          "#include <oneapi/mkl.hpp>\n#include <level_zero/ze_api.h>\nzeInit();\n",
      }),
      root,
    );

    const oneapi = stacks.find((stack) => stack.id === "oneapi");
    expect(oneapi).toBeDefined();
    expect(stacks.some((stack) => stack.id === "sycl")).toBe(false);
  });

  test("a oneAPI toolkit image carries the version", async () => {
    const stacks = await detectGpuStacks(
      files(["Dockerfile"]),
      reader({
        [`${root}/Dockerfile`]: "FROM intel/oneapi-basekit:2024.2.1-devel-ubuntu22.04\n",
      }),
      root,
    );

    expect(stacks.map((stack) => `${stack.id}@${stack.used}`)).toEqual(["oneapi@2024.2"]);
  });

  test("a project with no GPU code reports nothing", async () => {
    const stacks = await detectGpuStacks(
      files(["src/index.ts", "package.json"]),
      reader({
        [`${root}/src/index.ts`]: "export const add = (a: number, b: number) => a + b;\n",
        [`${root}/package.json`]: '{"name":"app"}',
      }),
      root,
    );

    expect(stacks).toEqual([]);
  });

  test("several stacks are reported once each, sorted", async () => {
    const stacks = await detectGpuStacks(
      files(["a.cu", "b.hip", "c.vert"], { ".cu": 1, ".hip": 1, ".vert": 1 }),
      reader({}),
      root,
    );

    expect(stacks.map((stack) => stack.id)).toEqual(["cuda", "rocm", "vulkan"]);
  });
});
