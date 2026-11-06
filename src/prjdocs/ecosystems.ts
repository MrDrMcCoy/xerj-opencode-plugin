// Automation and infrastructure ecosystems: Ansible, NetBox, and the HashiCorp
// products. These are not languages and rarely appear as dependencies, so they
// are proved by the files they own (a playbook, a Terraform block, a Vagrant
// file) and by the packages and images that belong to them.

import { basename, join } from "node:path";
import type { TechRef } from "./detect.ts";

interface Ecosystem {
  readonly id: string;
  /** File names that prove the tool, matched case-insensitively. */
  readonly names: ReadonlyArray<RegExp>;
  /** Text markers, checked in build and configuration files. */
  readonly markers: ReadonlyArray<RegExp>;
  /** Dependency or image names that belong to the tool. */
  readonly packages: ReadonlyArray<RegExp>;
}

const ECOSYSTEMS: ReadonlyArray<Ecosystem> = [
  {
    id: "ansible",
    names: [/^ansible\.cfg$/i, /^galaxy\.yml$/i, /^site\.ya?ml$/i, /\.playbook\.ya?ml$/i],
    markers: [
      /^\s*-?\s*hosts:\s*\S+/m,
      /\bansible\.builtin\./,
      /\bansible-playbook\b/,
      /^\s*(roles|tasks|handlers):\s*$/m,
      /\bbecome:\s*(true|yes)\b/,
    ],
    packages: [/^(ansible|ansible-core|ansible-lint|molecule)$/],
  },
  {
    id: "ansible-collections",
    names: [/^requirements\.ya?ml$/i, /^meta\/main\.ya?ml$/i],
    markers: [
      /^\s*collections:\s*$/m,
      /\b(ansible|community|redhat|amazon|google|kubernetes|containers|networktocode)\.\w+/,
      /\bansible-galaxy\s+collection\b/,
    ],
    packages: [],
  },
  {
    id: "netbox",
    names: [/^netbox[-_]?configuration\.py$/i, /^configuration\.py$/i],
    markers: [
      /\bnetboxcommunity\/netbox\b/i,
      /\bNETBOX_(URL|TOKEN|API)\b/,
      /\bimport\s+pynetbox\b/,
      /\bnetbox-docker\b/i,
    ],
    packages: [/^(pynetbox|netbox-docker|netbox-plugin.*)$/],
  },
  {
    id: "terraform",
    names: [/^terragrunt\.hcl$/i, /^terraform\.tfvars$/i],
    markers: [
      /^\s*resource\s+"[^"]+"\s+"[^"]+"\s*\{/m,
      /^\s*module\s+"[^"]+"\s*\{/m,
      /^\s*provider\s+"[^"]+"\s*\{/m,
      /\bterraform\s+(init|plan|apply)\b/,
      /\bhashicorp\/(aws|azurerm|google|kubernetes|random|tls|null)\b/,
    ],
    packages: [/^(hashicorp\/.*|terraform)$/],
  },
  {
    id: "terraform-language",
    names: [/\.tfnotused$/],
    markers: [/^\s*variable\s+"[^"]+"\s*\{/m, /^\s*output\s+"[^"]+"\s*\{/m],
    packages: [],
  },
  {
    id: "vault",
    names: [/^vault\.hcl$/i],
    markers: [
      /\bVAULT_(ADDR|TOKEN|NAMESPACE)\b/,
      /^\s*path\s+"[^"]*"\s*\{/m,
      /\bimport\s+hvac\b/,
      /\bvault\s+(kv|secrets|policy|auth)\b/,
    ],
    packages: [/^(hvac|hashicorp\/vault)$/],
  },
  {
    id: "consul",
    names: [],
    markers: [
      /\bCONSUL_(HTTP_ADDR|TOKEN|AGENT_CONFIG)\b/,
      /^\s*service\s*\{\s*$/m,
      /^\s*connect\s*\{\s*$/m,
      /\bconsul\s+(agent|members|kv)\b/,
    ],
    packages: [/^(python-consul|hashicorp\/consul)$/],
  },
  {
    id: "nomad",
    names: [/\.nomad$/i, /\.nomad\.hcl$/i],
    markers: [
      /^\s*job\s+"[^"]+"\s*\{/m,
      /\bNOMAD_(ADDR|TOKEN|NAMESPACE)\b/,
      /\bnomad\s+(job|agent|node)\b/,
    ],
    packages: [/^hashicorp\/nomad$/],
  },
  {
    id: "packer",
    names: [/\.pkr\.hcl$/i, /^packer\.json$/i],
    markers: [
      /^\s*source\s+"[^"]+"\s+"[^"]+"\s*\{/m,
      /^\s*build\s*\{\s*$/m,
      /\bpacker\s+(build|init|validate)\b/,
    ],
    packages: [/^hashicorp\/packer$/],
  },
  {
    id: "vagrant",
    names: [/^vagrantfile$/i],
    markers: [
      /Vagrant\.configure\s*\(/,
      /^\s*config\.vm\.(box|provider|network)/m,
      /\bvagrant\s+(up|destroy|status)\b/,
    ],
    packages: [/^hashicorp\/vagrant$/],
  },
  {
    id: "boundary",
    names: [/^boundary\.hcl$/i],
    markers: [/\bBOUNDARY_(ADDR|TOKEN)\b/, /\bboundary\s+(connect|authenticate)\b/],
    packages: [/^hashicorp\/boundary$/],
  },
  {
    id: "waypoint",
    names: [/^waypoint\.hcl$/i],
    markers: [/\bwaypoint\s+(init|up|destroy)\b/, /^\s*project\s*=\s*"[^"]+"/m],
    packages: [/^hashicorp\/waypoint$/],
  },
];

/** Files large enough to be data rather than configuration. */
const MAX_BYTES = 256 * 1024;

/** Files one scan reads. YAML and HCL are small; this bounds a pathological tree. */
const MAX_READ = 600;

/** Configuration and source files an ecosystem marker can appear in. */
const READABLE = /\.(ya?ml|json|hcl|tf|tfvars|nomad|pkr\.hcl|cfg|ini|py|sh|conf|env)$/i;
/** Files with no extension that still carry markers. */
const READABLE_NAMES = /^(Dockerfile|Containerfile|Makefile|Vagrantfile|ansible\.cfg)$/i;

/** Finds the automation and infrastructure ecosystems in play. */
export async function detectEcosystems(
  files: { readonly names: ReadonlyArray<string> },
  read: (path: string) => Promise<string | null>,
  projectRoot: string,
): Promise<TechRef[]> {
  const found = new Map<string, { evidence: string; used: string | null }>();

  for (const name of files.names) {
    const base = basename(name);
    for (const ecosystem of ECOSYSTEMS) {
      if (found.has(ecosystem.id)) continue;
      if (!ecosystem.names.some((pattern) => pattern.test(base))) continue;
      found.set(ecosystem.id, { evidence: `found ${base}`, used: null });
    }
  }

  const candidates = files.names
    .filter((name) => {
      const base = basename(name);
      return (
        READABLE.test(base) ||
        READABLE_NAMES.test(base) ||
        ECOSYSTEMS.some((ecosystem) => ecosystem.names.some((p) => p.test(base)))
      );
    })
    .slice(0, MAX_READ);

  for (const name of candidates) {
    const absolute = name.startsWith("/") ? name : join(projectRoot, name);
    const text = await read(absolute);
    if (text === null || text.length > MAX_BYTES) continue;

    for (const ecosystem of ECOSYSTEMS) {
      if (found.has(ecosystem.id)) continue;
      if (!ecosystem.markers.some((marker) => marker.test(text))) continue;
      found.set(ecosystem.id, { evidence: `referenced in ${name}`, used: null });
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

/** Package and image names that belong to one of these ecosystems. */
export function ecosystemPackages(): ReadonlyArray<{ readonly id: string; readonly test: RegExp }> {
  return ECOSYSTEMS.flatMap((ecosystem) =>
    ecosystem.packages.map((test) => ({ id: ecosystem.id, test })),
  );
}
