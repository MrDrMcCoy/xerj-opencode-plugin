// Accelerator toolchains: CUDA, ROCm/HIP, SYCL, oneAPI, and Vulkan. These are not
// languages and not npm packages, so neither extension counts nor dependency
// names catch them reliably. A project uses one when it compiles a kernel with
// that toolchain, includes its headers, or names it in a build file.

import { basename, extname, join } from "node:path";
import type { TechRef } from "./detect.ts";

/** Markers per stack, checked in file text and in dependency names. */
interface GpuStack {
  readonly id: string;
  /** Text markers that prove the toolchain is in use. */
  readonly markers: ReadonlyArray<RegExp>;
  /** Dependency or package names that belong to this stack. */
  readonly packages: ReadonlyArray<RegExp>;
  /** Extensions that only this stack uses. */
  readonly extensions: ReadonlyArray<string>;
  /** Where the version may be pinned, in any text. */
  readonly versions: ReadonlyArray<RegExp>;
}

const STACKS: ReadonlyArray<GpuStack> = [
  {
    id: "cuda",
    markers: [
      /#\s*include\s*[<"]cuda(?:_runtime|_fp16|_bf16|_rng)?\.h[>"]/i,
      /#\s*include\s*[<"](?:cublas|cudnn|cufft|curand|nccl|cub)\b[^>"]*[>"]/i,
      /\b__global__\b/,
      /\bcudaMalloc(?:Managed)?\s*\(/,
      /\bnvcc\b/,
      /\bCUDAExtension\s*\(/,
    ],
    packages: [/^(cupy|cupy-cuda\w*|pycuda|cuda-python|numba-cuda|cudatoolkit)$/],
    extensions: [".cu", ".cuh"],
    versions: [
      /nvidia\/cuda:(\d+\.\d+)/i,
      /cudatoolkit\s*[=:]\s*(\d+(?:\.\d+){0,2})/i,
      /CUDAToolkit(?:_VERSION)?\s+(?:REQUIRED\s+)?(\d+(?:\.\d+){0,2})/i,
      /CUDA_VERSION\s*[=:]\s*"?(\d+(?:\.\d+){0,2})/i,
    ],
  },
  {
    id: "rocm",
    markers: [
      /#\s*include\s*[<"]hip\/(?:hip_runtime|hip_fp16)\.h[>"]/i,
      /#\s*include\s*[<"](?:rocblas|hipblas|rocfft|miopen)\b[^>"]*[>"]/i,
      /\bhipMalloc(?:Managed)?\s*\(/,
      /\bhipcc\b/,
      /\bHIP_PLATFORM_(?:AMD|NVIDIA)\b/,
    ],
    packages: [/^(hip-python|rocm-smi|rocm)$/],
    extensions: [".hip"],
    versions: [
      /rocm\/dev-[^:\s]+:(\d+\.\d+)/i,
      /ROCM_VERSION\s*[=:]\s*"?(\d+(?:\.\d+){0,2})/i,
      /\/opt\/rocm-(\d+(?:\.\d+){0,2})/,
    ],
  },
  {
    id: "sycl",
    markers: [
      /#\s*include\s*[<"](?:sycl\/sycl|CL\/sycl)\.hpp[>"]/i,
      /\bsycl::(?:queue|buffer|handler|accessor)\b/,
      /\b(?:dpcpp|icpx)\b[^\n]*\s-fsycl\b/,
      /\bSYCL_DEVICE_FILTER\b/,
    ],
    packages: [/^(adaptivecpp|sycl|dpcpp-cpp-rt|intel-sycl-rt)$/],
    extensions: [],
    // The SYCL specification carries no version in its URL, and a oneAPI
    // toolkit version belongs to the oneapi stack, not this one.
    versions: [],
  },
  {
    id: "oneapi",
    markers: [
      /#\s*include\s*[<"](?:oneapi\/[^>"]+|mkl\.h|mkl\.hpp|dnnl\.h|dnnl\.hpp|tbb\/[^>"]+)[>"]/i,
      /\boneapi::(?:mkl|dnnl|tbb|dpl)::/,
      /#\s*include\s*[<"]level_zero\/ze_api\.h[>"]/i,
      /\bzeInit(?:Drivers)?\s*\(/,
      /\b(?:dpcpp|icpx)\b(?![^\n]*\s-fsycl\b)/,
      /\bONEAPI_ROOT\b/,
    ],
    packages: [
      /^(intel-extension-for-pytorch|scikit-learn-intelex|oneccl_bindings_for_pytorch|mkl|mkl-devel|intel-openmp|dpcpp-cpp-rt|intel-sycl-rt)$/,
    ],
    extensions: [],
    versions: [
      /intel\/oneapi-[\w.-]+:(\d{4}\.\d+)/i,
      /ONEAPI_VERSION\s*[=:]\s*"?(\d{4}\.\d+)/i,
      /(?:oneAPI|oneapi)\s+(\d{4}\.\d+)/i,
    ],
  },
  {
    id: "vulkan",
    markers: [
      /#\s*include\s*[<"]vulkan\/vulkan(?:_core)?\.h[>"]/i,
      /\bvkCreate(?:Instance|Device|Buffer|Pipeline)\w*\s*\(/,
      /\bVK_(?:SUCCESS|ERROR_\w+)\b/,
      /\bfind_package\s*\(\s*Vulkan\b/i,
      /\b(?:glslang|shaderc|glslc)\b/,
      /\bVULKAN_SDK\b/,
    ],
    packages: [/^(ash|vulkano|vulkan-sys|vulkan|shaderc|shaderc-sys|vulkano-shaders)$/],
    extensions: [".glsl", ".vert", ".frag", ".comp", ".slang"],
    versions: [/VULKAN_SDK\s*[=:]\s*"?(\d+\.\d+(?:\.\d+)?)/i],
  },
];

/** Text files small enough to read when looking for a stack marker. */
const SCAN_EXTENSIONS = new Set([
  ".c",
  ".h",
  ".cc",
  ".cpp",
  ".cxx",
  ".hpp",
  ".hh",
  ".cu",
  ".cuh",
  ".hip",
  ".py",
  ".rs",
  ".toml",
  ".cmake",
  ".txt",
  ".mk",
  ".yml",
  ".yaml",
  ".json",
  ".glsl",
  ".vert",
  ".frag",
  ".comp",
  ".slang",
]);

/** Build and container files, read wherever they appear in the tree. */
const BUILD_NAMES = new Set([
  "CMakeLists.txt",
  "CMakeCache.txt",
  "Makefile",
  "makefile",
  "meson.build",
  "setup.py",
  "pyproject.toml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "environment.yml",
  "environment.yaml",
  "Cargo.toml",
  "package.json",
]);

/** Files one scan reads: enough to find a toolchain in any real project. */
const MAX_READ = 400;

/** Files larger than this are build output or data, not a build script. */
const MAX_BYTES = 128 * 1024;

/**
 * Finds GPU compute stacks from file names, build files, and source markers.
 * Returns one ref per stack, with the version when a file pins one.
 */
export async function detectGpuStacks(
  files: { readonly names: ReadonlyArray<string>; readonly extensionCounts: Readonly<Record<string, number>> },
  read: (path: string) => Promise<string | null>,
  projectRoot: string,
): Promise<TechRef[]> {
  const found = new Map<string, { evidence: string; used: string | null }>();

  for (const stack of STACKS) {
    for (const extension of stack.extensions) {
      const count = files.extensionCounts[extension] ?? 0;
      if (count > 0) found.set(stack.id, { evidence: `${count} ${extension} files`, used: null });
    }
  }

  const candidates = files.names
    .filter((name) => {
      const base = basename(name);
      if (BUILD_NAMES.has(base)) return true;
      return SCAN_EXTENSIONS.has(extname(base).toLowerCase());
    })
    .slice(0, MAX_READ);

  for (const name of candidates) {
    const absolute = name.startsWith("/") ? name : join(projectRoot, name);
    const text = await read(absolute);
    if (text === null || text.length > MAX_BYTES) continue;

    for (const stack of STACKS) {
      // A build file can prove the stack by pinning its image or SDK version
      // without naming any header, so a version counts as a marker too.
      const version = versionIn(text, stack);
      if (version === null && !mentions(text, stack)) continue;

      const existing = found.get(stack.id);
      if (existing === undefined) {
        found.set(stack.id, { evidence: `referenced in ${name}`, used: version });
        continue;
      }
      if (existing.used === null && version !== null) existing.used = version;
    }
  }

  return [...found.entries()]
    .map(([id, entry]) => ({
      id,
      kind: "framework" as const,
      used: entry.used,
      evidence: entry.evidence,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/** True when the text carries any marker for the stack. */
function mentions(text: string, stack: GpuStack): boolean {
  return stack.markers.some((marker) => marker.test(text));
}

/** The version a file pins for the stack, or null. */
function versionIn(text: string, stack: GpuStack): string | null {
  for (const pattern of stack.versions) {
    const match = pattern.exec(text);
    const version = match?.[1];
    if (version !== undefined) return version;
  }
  return null;
}

/** Package names that belong to a GPU stack, used by dependency classification. */
export function gpuPackages(): ReadonlyArray<{ readonly id: string; readonly test: RegExp }> {
  return STACKS.flatMap((stack) =>
    stack.packages.map((test) => ({ id: stack.id, test })),
  );
}
