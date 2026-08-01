import path from "node:path";
import { formatBatchAuditMarkdown, loadBatchContext, runBatchAudit } from "./batch-audit.mjs";
import { formatBatchBuildMarkdown, runBatchBuild } from "./batch-build.mjs";
import { buildAuditCaseSpecs } from "./case-scaffold.mjs";
import { jsonReplacer, readInputs, writeText } from "./utils.mjs";

export async function runReviewPack(args = {}) {
  const outDir = path.resolve(stringArg(args, "out-dir") || "outputs/review-pack");
  const caseSpecs = await resolveReviewCases(args);
  const sharedLawFetchCache = args.lawFetchCache || new Map();
  const common = {
    ...args,
    caseSpecs,
    lawFetchCache: sharedLawFetchCache,
  };
  const artifactDir = path.resolve(stringArg(args, "artifact-dir") || path.join(outDir, "artifacts"));
  const deckPath = stringArg(args, "deck")
    ? path.resolve(stringArg(args, "deck"))
    : path.join(artifactDir, "review-deck.pptx");
  const outputs = stringArg(args, "outputs") || "svg,json,audit,pptx,deck";

  const audit = await runBatchAudit(common);
  const build = await runBatchBuild({
    ...common,
    "out-dir": artifactDir,
    outputs,
    deck: deckPath,
  });

  const files = {
    cases: path.join(outDir, stringArg(args, "cases-out") || "cases.json"),
    audit: path.join(outDir, stringArg(args, "audit-out") || "audit.md"),
    auditJson: path.join(outDir, stringArg(args, "audit-json-out") || "audit.json"),
    manifest: path.join(outDir, stringArg(args, "manifest-out") || "manifest.md"),
    manifestJson: path.join(outDir, stringArg(args, "manifest-json-out") || "manifest.json"),
  };

  await writeText(files.cases, `${JSON.stringify({ cases: caseSpecs }, jsonReplacer, 2)}\n`);
  await writeText(files.audit, formatBatchAuditMarkdown(audit));
  await writeText(files.auditJson, `${JSON.stringify(audit, jsonReplacer, 2)}\n`);
  await writeText(files.manifest, formatBatchBuildMarkdown(build));
  await writeText(files.manifestJson, `${JSON.stringify(build, jsonReplacer, 2)}\n`);

  return {
    generatedAt: new Date().toISOString(),
    outDir,
    artifactDir,
    files,
    caseCount: caseSpecs.length,
    audit,
    build,
  };
}

async function resolveReviewCases(args) {
  if (args.caseSpecs) return args.caseSpecs;
  if (stringArg(args, "cases")) {
    const context = await loadBatchContext(args);
    return context.caseSpecs;
  }
  const inputInstitutions = args.input?.length ? await readInputs(args.input) : [];
  const institutions = [stringArg(args, "institutions"), stringArg(args, "institution"), ...inputInstitutions];
  return buildAuditCaseSpecs({
    institutions,
    date: stringArg(args, "date"),
    view: stringArg(args, "view") || "operational",
    paper: stringArg(args, "paper") || "a4-half",
    layout: stringArg(args, "layout") || "best",
    layouts: stringArg(args, "layouts"),
    focus: stringArg(args, "focus"),
    maxNodes: args["max-nodes"] ? Number(args["max-nodes"]) : undefined,
    lawMap: stringArg(args, "law-map"),
    lawMapDate: stringArg(args, "law-map-date"),
  }).cases;
}

function stringArg(args, key) {
  return typeof args[key] === "string" ? args[key] : undefined;
}
