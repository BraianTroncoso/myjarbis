/**
 * Org packs — loading how an organization works, instead of teaching it.
 *
 * `init` seeds ten generic baseline skills and nothing else, so everything
 * that describes a particular organization's way of working had to be loaded
 * by hand, project by project. Measured on three real projects: two were
 * missing that layer entirely, and one of them re-learned and re-documented
 * an operational gotcha that was already written down in a skill which had
 * never been materialised there. The same standard also got pasted in as a
 * 10,211-character project_context row duplicating rules that already
 * existed as skills.
 *
 * A pack is a directory the core knows the SHAPE of and nothing else. No
 * pack ships here: this file is the loader, the content lives in a separate
 * private repository. `examples/pack/` holds two fictional skills purely so
 * the contract is readable.
 *
 *   <pack>/
 *   ├── pack.yml            slug, name, version, compatible_with
 *   ├── skills/*.md         skills, frontmatter: name, description
 *   ├── overrides/*.md      replace a baseline skill of the same name
 *   ├── context-kinds.yml   extra taxonomy labels
 *   ├── workflows/*.yml     workflows at org scope
 *   └── providers.yml       provider templates, never credentials
 *
 * Everything is applied by content hash, so re-applying a pack reports
 * `unchanged` rather than churning rows and bumping timestamps.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { OrgRow, StepGate } from '../db/schema.js';
import { materializeSkills } from '../tools/skills.js';
import { validateProviderConfig } from './secrets.js';
import { assertCondition } from '../workflows/condition.js';
import {
  parseManifest,
  parseFrontmatter,
  asMap,
  asList,
  asString,
  optString,
  optNumber,
  optBool,
  YamlMap,
} from './yaml.js';

/** Bumped with the release; packs may require a minimum. */
export const MYJARBIS_VERSION = '0.5.2';

export type ApplyStatus = 'created' | 'updated' | 'unchanged';

export interface PackSkill {
  name: string;
  description?: string;
  triggerPattern?: string;
  content: string;
  /** From overrides/ rather than skills/. Applied after the baselines. */
  isOverride: boolean;
  sourceFile: string;
}

export interface PackContextKind {
  slug: string;
  label: string;
  description?: string;
  position?: number;
}

export interface PackWorkflowStep {
  name: string;
  actor: string;
  gate: StepGate;
  capability?: string;
  /** Slug of another workflow to run here. Excludes `capability`. */
  uses?: string;
  condition?: string;
  notes?: string;
  disabled?: boolean;
}

export interface PackWorkflow {
  slug: string;
  name: string;
  /** False = a child, invocable only from a parent and hidden from the menu. */
  standalone: boolean;
  steps: PackWorkflowStep[];
  sourceFile: string;
}

export interface PackProvider {
  role: string;
  kind: string;
  /** Already validated against the secret guard, serialised as JSON. */
  config: string | null;
}

export interface Pack {
  slug: string;
  name: string;
  version?: string;
  compatibleWith?: string;
  /** Absolute path the pack was read from. */
  packPath: string;
  /** Git revision of the pack, or a content hash when it is not a repo. */
  rev: string;
  skills: PackSkill[];
  contextKinds: PackContextKind[];
  workflows: PackWorkflow[];
  providers: PackProvider[];
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────
// Reading
// ─────────────────────────────────────────────────────────────────────

function readIfExists(dir: string, names: string[]): { file: string; src: string } | null {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return { file: n, src: fs.readFileSync(p, 'utf-8') };
  }
  return null;
}

function listMarkdown(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.md$/i.test(f))
    .sort();
}

function listManifests(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(ya?ml|json)$/i.test(f))
    .sort();
}

/**
 * A revision for the pack, so `doctor` can say "this project is behind the
 * pack" without the author having to remember to bump a version by hand.
 * Prefers the git commit; falls back to a hash over the file contents.
 */
function packRevision(packPath: string): string {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: packPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) {
      let dirty = '';
      try {
        const st = execFileSync('git', ['status', '--porcelain'], {
          cwd: packPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (st) dirty = '-dirty';
      } catch {
        /* ignore */
      }
      return `git:${out}${dirty}`;
    }
  } catch {
    /* not a git repo */
  }

  const h = crypto.createHash('sha256');
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else {
        h.update(path.relative(packPath, p));
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(packPath);
  return `sha:${h.digest('hex').slice(0, 12)}`;
}

/** Compare `compatible_with` against MYJARBIS_VERSION. Supports an exact
 *  version or ">=x.y[.z]", which is all a pack realistically needs. */
export function isCompatible(spec: string | undefined, version = MYJARBIS_VERSION): boolean {
  if (!spec) return true;
  const want = spec.trim();
  const nums = (v: string): number[] =>
    v
      .split('.')
      .map((x) => parseInt(x, 10))
      .map((x) => (Number.isFinite(x) ? x : 0));

  const ge = /^>=\s*([\d.]+)$/.exec(want);
  if (ge) {
    const a = nums(version);
    const b = nums(ge[1]);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const x = a[i] ?? 0;
      const y = b[i] ?? 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return true;
  }
  return want === version;
}

function readSkillFile(dir: string, file: string, isOverride: boolean): PackSkill {
  const src = fs.readFileSync(path.join(dir, file), 'utf-8');
  const { data } = parseFrontmatter(src);
  const name = optString(data.name) ?? path.basename(file, path.extname(file));
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new MyJarbisError(
      ErrorType.PACK_ERROR,
      `${isOverride ? 'overrides' : 'skills'}/${file}: skill name "${name}" must be ` +
        `lowercase kebab-case (it becomes a directory name under .claude/skills/).`,
    );
  }
  return {
    name,
    description: optString(data.description),
    triggerPattern: optString(data.trigger) ?? optString(data.trigger_pattern),
    // The full file, frontmatter included: Claude Code reads SKILL.md whole.
    content: src,
    isOverride,
    sourceFile: `${isOverride ? 'overrides' : 'skills'}/${file}`,
  };
}

function readWorkflowFile(dir: string, file: string): PackWorkflow {
  const parsed = asMap(
    parseManifest(file, fs.readFileSync(path.join(dir, file), 'utf-8')),
    `workflows/${file}`,
  );
  const slug = optString(parsed.slug) ?? path.basename(file, path.extname(file));
  const name = optString(parsed.name) ?? slug;
  const standalone = optBool(parsed.standalone) ?? true;
  const steps: PackWorkflowStep[] = [];

  for (const [i, raw] of asList(parsed.steps, `workflows/${file}: steps`).entries()) {
    const s = asMap(raw, `workflows/${file}: steps[${i}]`);
    const stepName = asString(s.name, `workflows/${file}: steps[${i}].name`);
    const gate = (optString(s.gate) ?? 'none') as StepGate;
    if (!['none', 'approve', 'on-request'].includes(gate)) {
      throw new MyJarbisError(
        ErrorType.PACK_ERROR,
        `workflows/${file}: step "${stepName}" has gate "${gate}"; ` +
          `expected none | approve | on-request.`,
      );
    }
    const condition = optString(s.condition);
    if (condition) {
      // Validated at load time so a malformed gate is a pack error the
      // author sees now, not an ambiguity the agent reinterprets later.
      assertCondition(condition, `workflows/${file}: step "${stepName}"`);
    }
    const capability = optString(s.capability);
    const uses = optString(s.uses);
    // Same rule as the tool and the repository, checked at the earliest of the
    // three: a pack author finds out when they write the file, not when
    // somebody's session resolves it.
    if (uses && capability) {
      throw new MyJarbisError(
        ErrorType.PACK_ERROR,
        `workflows/${file}: step "${stepName}" has both uses="${uses}" and ` +
          `capability="${capability}". A step either runs another workflow or ` +
          'does something itself, never both.',
      );
    }
    if (uses === slug) {
      throw new MyJarbisError(
        ErrorType.PACK_ERROR,
        `workflows/${file}: step "${stepName}" makes "${slug}" invoke itself.`,
      );
    }
    if (stepName.includes('/')) {
      throw new MyJarbisError(
        ErrorType.PACK_ERROR,
        `workflows/${file}: step "${stepName}" contains "/", which is reserved ` +
          'for the names of steps that came from an invoked workflow.',
      );
    }
    steps.push({
      name: stepName,
      actor: optString(s.actor) ?? 'agent',
      gate,
      capability,
      uses,
      condition,
      notes: optString(s.notes),
      disabled: optBool(s.disabled),
    });
  }

  if (steps.length === 0) {
    throw new MyJarbisError(
      ErrorType.PACK_ERROR,
      `workflows/${file}: a workflow needs at least one step.`,
    );
  }
  return { slug, name, standalone, steps, sourceFile: `workflows/${file}` };
}

/** Parse and validate a pack directory. Touches no database. */
export function readPack(packPathRaw: string): Pack {
  const packPath = path.resolve(packPathRaw);
  if (!fs.existsSync(packPath) || !fs.statSync(packPath).isDirectory()) {
    throw new MyJarbisError(ErrorType.PACK_ERROR, `Pack directory not found: ${packPath}`);
  }

  const manifest = readIfExists(packPath, ['pack.yml', 'pack.yaml', 'pack.json']);
  if (!manifest) {
    throw new MyJarbisError(
      ErrorType.PACK_ERROR,
      `${packPath} has no pack.yml (or pack.json). A pack needs a manifest ` +
        `declaring at least slug and name.`,
    );
  }

  const meta = asMap(parseManifest(manifest.file, manifest.src), manifest.file);
  const slug = asString(meta.slug, `${manifest.file}: slug`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new MyJarbisError(
      ErrorType.PACK_ERROR,
      `${manifest.file}: slug "${slug}" must be lowercase kebab-case.`,
    );
  }
  const name = optString(meta.name) ?? slug;
  const compatibleWith = optString(meta.compatible_with);
  if (!isCompatible(compatibleWith)) {
    throw new MyJarbisError(
      ErrorType.PACK_ERROR,
      `Pack "${slug}" requires MyJarbis ${compatibleWith}, this is ${MYJARBIS_VERSION}.`,
    );
  }

  const warnings: string[] = [];

  // Skills, then overrides. Order matters at apply time, so it is fixed here.
  const skills: PackSkill[] = [];
  const skillsDir = path.join(packPath, 'skills');
  const overridesDir = path.join(packPath, 'overrides');
  for (const f of listMarkdown(skillsDir)) skills.push(readSkillFile(skillsDir, f, false));
  for (const f of listMarkdown(overridesDir)) skills.push(readSkillFile(overridesDir, f, true));

  if (skills.length === 0) {
    warnings.push('pack contains no skills — nothing will be seeded beyond the baselines');
  }

  // Taxonomy additions.
  const contextKinds: PackContextKind[] = [];
  const kindsFile = readIfExists(packPath, [
    'context-kinds.yml',
    'context-kinds.yaml',
    'context-kinds.json',
  ]);
  if (kindsFile) {
    const doc = asMap(parseManifest(kindsFile.file, kindsFile.src), kindsFile.file);
    for (const [i, raw] of asList(doc.kinds, `${kindsFile.file}: kinds`).entries()) {
      const k = asMap(raw, `${kindsFile.file}: kinds[${i}]`);
      const kslug = asString(k.slug, `${kindsFile.file}: kinds[${i}].slug`);
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(kslug)) {
        throw new MyJarbisError(
          ErrorType.PACK_ERROR,
          `${kindsFile.file}: kind slug "${kslug}" must be lowercase.`,
        );
      }
      contextKinds.push({
        slug: kslug,
        label: optString(k.label) ?? kslug,
        description: optString(k.description),
        position: optNumber(k.position) ?? 300,
      });
    }
  }

  // Org-scope workflows.
  const workflows: PackWorkflow[] = [];
  const wfDir = path.join(packPath, 'workflows');
  for (const f of listManifests(wfDir)) workflows.push(readWorkflowFile(wfDir, f));

  const seenSlugs = new Set<string>();
  for (const w of workflows) {
    if (seenSlugs.has(w.slug)) {
      throw new MyJarbisError(
        ErrorType.PACK_ERROR,
        `two workflow files declare slug "${w.slug}"; slugs must be unique within a pack.`,
      );
    }
    seenSlugs.add(w.slug);
  }

  // A `uses` target must exist, and the check happens HERE rather than per
  // file, because every slug in the pack is only known once all of them are
  // read — validating one workflow at a time would reject a parent whose
  // child's file sorts after it.
  //
  // A target outside the pack is allowed and reported as a warning instead of
  // an error: a pack can legitimately invoke a workflow the project defines
  // itself, and refusing that would make a pack unable to extend a project.
  // Unresolvable at run time, it is caught by the resolver, which names the
  // parent step rather than only the missing slug.
  for (const w of workflows) {
    for (const s of w.steps) {
      if (!s.uses || seenSlugs.has(s.uses)) continue;
      warnings.push(
        `${w.sourceFile}: step "${s.name}" invokes "${s.uses}", which this pack ` +
          'does not define. It has to exist in the project, or the workflow will ' +
          'fail to resolve.',
      );
    }
  }

  // Cycles, over the pack's own graph. Caught here as well as in the resolver
  // because a pack is authored once and read by everyone: the author should
  // find this, not twenty-three projects.
  const usesOf = new Map<string, string[]>(
    workflows.map((w) => [w.slug, w.steps.filter((s) => s.uses).map((s) => s.uses!)]),
  );
  const walk = (slug: string, pathSoFar: string[]): void => {
    if (pathSoFar.includes(slug)) {
      throw new MyJarbisError(
        ErrorType.PACK_ERROR,
        `workflow cycle in this pack: ${[...pathSoFar, slug].join(' → ')}.`,
      );
    }
    for (const child of usesOf.get(slug) ?? []) walk(child, [...pathSoFar, slug]);
  };
  for (const w of workflows) walk(w.slug, []);

  // Provider templates.
  const providers: PackProvider[] = [];
  const provFile = readIfExists(packPath, ['providers.yml', 'providers.yaml', 'providers.json']);
  if (provFile) {
    const doc = asMap(parseManifest(provFile.file, provFile.src), provFile.file);
    for (const [i, raw] of asList(doc.providers, `${provFile.file}: providers`).entries()) {
      const p = asMap(raw, `${provFile.file}: providers[${i}]`);
      const role = asString(p.role, `${provFile.file}: providers[${i}].role`);
      const kind = asString(p.kind, `${provFile.file}: providers[${i}].kind`);
      // Runs the secret guard at read time: a pack carrying a credential is
      // rejected before it can be written anywhere, including into a dump.
      const config = validateProviderConfig(
        p.config === undefined || p.config === null ? null : (p.config as unknown as object),
      );
      providers.push({ role, kind, config });
    }
  }

  return {
    slug,
    name,
    version: optString(meta.version),
    compatibleWith,
    packPath,
    rev: packRevision(packPath),
    skills,
    contextKinds,
    workflows,
    providers,
    warnings,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Applying
// ─────────────────────────────────────────────────────────────────────

export interface PackApplyReport {
  org: { slug: string; name: string; rev: string; packPath: string };
  project: { id: number; name: string };
  skills: Array<{ name: string; from: string; status: ApplyStatus }>;
  contextKinds: Array<{ slug: string; status: ApplyStatus }>;
  workflows: Array<{ slug: string; steps: number; status: ApplyStatus }>;
  providers: Array<{ role: string; kind: string; status: ApplyStatus }>;
  /** Skills actually written to .claude/skills/. Inserting into the DB is
   *  not enough — Claude Code reads the directory, not the table. */
  materialized: { count: number; dir: string; names: string[] };
  warnings: string[];
  dryRun: boolean;
}

/**
 * Apply a pack to the project in `ctx`.
 *
 * Steps are ordered so that overrides land after the baselines they replace,
 * and so materialisation happens last. Two real projects were found with 20
 * and 18 skills in the database but only 10 on disk, because an earlier
 * loader stopped at the insert — and the overrides directory was never
 * iterated at all, leaving those projects running the generic baseline that
 * contradicted the organization's own rule.
 */
export function applyPack(
  ctx: ServerContext,
  pack: Pack,
  opts: { dryRun?: boolean; skipMaterialize?: boolean } = {},
): PackApplyReport {
  const project = ctx.requireProject();
  const dryRun = opts.dryRun === true;

  const report: PackApplyReport = {
    org: { slug: pack.slug, name: pack.name, rev: pack.rev, packPath: pack.packPath },
    project: { id: project.id, name: project.name },
    skills: [],
    contextKinds: [],
    workflows: [],
    providers: [],
    materialized: { count: 0, dir: '', names: [] },
    warnings: [...pack.warnings],
    dryRun,
  };

  const run = (): OrgRow => {
    const org = ctx.db.orgs.upsert({
      slug: pack.slug,
      name: pack.name,
      packPath: pack.packPath,
      packRev: pack.rev,
    });
    ctx.db.projects.setOrg(project.id, org.id);

    // 1. Taxonomy first: a workflow or a skill may reference a kind the
    //    pack adds, so the catalogue has to exist before they are read.
    for (const k of pack.contextKinds) {
      const existed = ctx.db.contextKinds.exists(k.slug, org.id);
      ctx.db.contextKinds.upsert({
        slug: k.slug,
        label: k.label,
        description: k.description,
        orgId: org.id,
        position: k.position,
      });
      report.contextKinds.push({ slug: k.slug, status: existed ? 'unchanged' : 'created' });
    }

    // 2. Skills, baselines first and overrides after (readPack fixed that
    //    order). The upsert is hash-keyed, so re-applying reports unchanged.
    for (const s of pack.skills) {
      const r = ctx.db.skills.upsert({
        projectId: project.id,
        name: s.name,
        description: s.description,
        triggerPattern: s.triggerPattern,
        content: s.content,
      });
      report.skills.push({
        name: s.name,
        from: s.sourceFile,
        status: r.status === 'inserted' ? 'created' : r.status,
      });
    }

    // 3. Org-scope workflows. Steps are replaced wholesale per workflow so a
    //    step removed from the pack disappears instead of lingering.
    //
    //    A step's `uses` target is NOT validated here against the rest of the
    //    pack. It is validated in readPack, where every file has been read and
    //    the whole set of slugs is known — checking it one workflow at a time
    //    would reject a parent that happens to be applied before its child.
    for (const w of pack.workflows) {
      const existed = ctx.db.workflows.find(w.slug, 'org', org.id) !== null;
      const wf = ctx.db.workflows.upsert({
        slug: w.slug,
        name: w.name,
        scope: 'org',
        scopeId: org.id,
        standalone: w.standalone,
      });
      const keep = new Set(w.steps.map((s) => s.name));
      for (const existing of ctx.db.workflowSteps.listByWorkflow(wf.id)) {
        if (!keep.has(existing.name)) ctx.db.workflowSteps.delete(existing.id);
      }
      w.steps.forEach((s, i) => {
        ctx.db.workflowSteps.upsert({
          workflowId: wf.id,
          position: (i + 1) * 10,
          name: s.name,
          actor: s.actor,
          gate: s.gate,
          capability: s.capability,
          uses: s.uses,
          condition: s.condition,
          notes: s.notes,
          disabled: s.disabled,
        });
      });
      report.workflows.push({
        slug: w.slug,
        steps: w.steps.length,
        status: existed ? 'updated' : 'created',
      });
    }

    // 4. Provider templates. A project that already names a provider for a
    //    role keeps it: the pack supplies the default, the project decides.
    for (const p of pack.providers) {
      const existing = ctx.db.providers.findByRole(project.id, p.role as 'tracker');
      if (existing) {
        report.providers.push({ role: p.role, kind: existing.kind, status: 'unchanged' });
        continue;
      }
      ctx.db.providers.upsert({
        projectId: project.id,
        role: p.role as 'tracker',
        kind: p.kind,
        config: p.config,
      });
      report.providers.push({ role: p.role, kind: p.kind, status: 'created' });
    }

    return org;
  };

  if (dryRun) {
    // Compute the report inside a transaction that is always rolled back,
    // so --dry-run reports exactly what a real run would do without a
    // separate, drift-prone prediction path.
    try {
      ctx.db.tx(() => {
        run();
        throw new DryRunRollback();
      });
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
    }
    report.warnings.push('dry run — nothing was written');
    return report;
  }

  ctx.db.tx(run);

  // 5. Materialise. Inserting rows is not enough: Claude Code loads skills
  //    from .claude/skills/<dir>/SKILL.md, so a pack that stops at the
  //    database has configured nothing the agent can actually see.
  if (!opts.skipMaterialize) {
    const m = materializeSkills(ctx, {});
    // What matters is how many ended up ON DISK, not how many changed.
    // Reporting only `written` would show 0 on a re-apply and read as a
    // failure, which is the opposite of the truth.
    const onDisk = [...m.written, ...m.unchanged].sort();
    report.materialized = {
      count: onDisk.length,
      dir: m.skills_dir,
      names: onDisk,
    };
    if (onDisk.length === 0) {
      report.warnings.push(
        'no skills are present in .claude/skills/ — the agent will not see them',
      );
    }
  }

  return report;
}

class DryRunRollback extends Error {}

/**
 * Re-apply a pack to every project of its org.
 *
 * This is the operation that makes a cross-cutting rule change a single
 * action instead of N visits, which was the main cost of the old
 * one-brain-per-project arrangement.
 */
export interface OrgSyncReport {
  org: string;
  rev: string;
  projects: Array<{
    name: string;
    path: string;
    ok: boolean;
    skills?: number;
    materialized?: number;
    error?: string;
  }>;
}
