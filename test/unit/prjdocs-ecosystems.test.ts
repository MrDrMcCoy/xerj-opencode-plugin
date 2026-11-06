import { describe, expect, test } from "bun:test";
import { detectEcosystems } from "../../src/prjdocs/ecosystems.ts";

const root = "/project";

function files(names: string[]) {
  return { names };
}

function reader(texts: Record<string, string>) {
  return async (path: string): Promise<string | null> => texts[path] ?? null;
}

describe("detectEcosystems", () => {
  test("a playbook and ansible.cfg prove Ansible", async () => {
    const found = await detectEcosystems(
      files(["site.yml", "ansible.cfg"]),
      reader({ [`${root}/site.yml`]: "- hosts: all\n  become: true\n" }),
      root,
    );

    expect(found.map((ref) => ref.id)).toContain("ansible");
  });

  test("a requirements file with collections proves community collections", async () => {
    const found = await detectEcosystems(
      files(["requirements.yml"]),
      reader({
        [`${root}/requirements.yml`]: "collections:\n  - community.general\n  - ansible.posix\n",
      }),
      root,
    );

    expect(found.map((ref) => ref.id)).toContain("ansible-collections");
  });

  test("a NetBox image proves NetBox", async () => {
    const found = await detectEcosystems(
      files(["Dockerfile"]),
      reader({ [`${root}/Dockerfile`]: "FROM netboxcommunity/netbox:v4.1\n" }),
      root,
    );

    expect(found.map((ref) => ref.id)).toContain("netbox");
  });

  test("Terraform blocks prove Terraform", async () => {
    const found = await detectEcosystems(
      files(["main.tf"]),
      reader({ [`${root}/main.tf`]: 'resource "aws_s3_bucket" "b" {}\n' }),
      root,
    );

    expect(found.map((ref) => ref.id)).toContain("terraform");
  });

  test("a Vault policy file proves Vault", async () => {
    const found = await detectEcosystems(
      files(["policies/app.hcl"]),
      reader({ [`${root}/policies/app.hcl`]: 'path "secret/data/*" {\n  capabilities = ["read"]\n}\n' }),
      root,
    );

    expect(found.map((ref) => ref.id)).toContain("vault");
  });

  test("a Nomad job file proves Nomad by name alone", async () => {
    const found = await detectEcosystems(files(["web.nomad"]), reader({}), root);

    expect(found.map((ref) => ref.id)).toContain("nomad");
  });

  test("a Vagrantfile proves Vagrant", async () => {
    const found = await detectEcosystems(
      files(["Vagrantfile"]),
      reader({ [`${root}/Vagrantfile`]: 'Vagrant.configure("2") do |config|\nend\n' }),
      root,
    );

    expect(found.map((ref) => ref.id)).toContain("vagrant");
  });

  test("HashiCorp environment variables prove their products", async () => {
    const found = await detectEcosystems(
      files(["deploy.sh"]),
      reader({
        [`${root}/deploy.sh`]:
          "vault kv put secret/a b=1\nconsul members\nboundary authenticate\n",
      }),
      root,
    );

    const ids = found.map((ref) => ref.id);
    expect(ids).toContain("vault");
    expect(ids).toContain("consul");
    expect(ids).toContain("boundary");
  });

  test("an unrelated project reports nothing", async () => {
    const found = await detectEcosystems(
      files(["index.ts", "package.json"]),
      reader({
        [`${root}/index.ts`]: "export const value = 1;\n",
        [`${root}/package.json`]: '{"name":"app"}',
      }),
      root,
    );

    expect(found).toEqual([]);
  });
});
