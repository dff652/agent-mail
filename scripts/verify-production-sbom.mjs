#!/usr/bin/env node

import fs from "node:fs";

const [treePath, rawSbomPath, outputPath] = process.argv.slice(2);
if (!treePath || !rawSbomPath || !outputPath) {
  throw new Error("usage: verify-production-sbom.mjs TREE_JSON RAW_SBOM_JSON OUTPUT_JSON");
}

const tree = JSON.parse(fs.readFileSync(treePath, "utf8"));
const sbom = JSON.parse(fs.readFileSync(rawSbomPath, "utf8"));

if (!Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
  throw new Error("CycloneDX SBOM is missing components or dependencies");
}

// npm 10 may emit the same bom-ref once per physical install path. Collapse
// only identical component identities, retaining every distinct property.
const componentsByRef = new Map();
for (const component of sbom.components) {
  const ref = component["bom-ref"];
  if (!ref || !component.name || !component.version || !component.purl) {
    throw new Error("SBOM component is missing bom-ref, name, version, or purl");
  }
  const previous = componentsByRef.get(ref);
  if (!previous) {
    componentsByRef.set(ref, component);
    continue;
  }
  const withoutProperties = ({ properties: _ignored, ...value }) => value;
  if (JSON.stringify(withoutProperties(previous)) !== JSON.stringify(withoutProperties(component))) {
    throw new Error(`conflicting duplicate SBOM component: ${ref}`);
  }
  const propertyKeys = new Set((previous.properties || []).map((item) => JSON.stringify(item)));
  for (const property of component.properties || []) {
    const key = JSON.stringify(property);
    if (!propertyKeys.has(key)) {
      (previous.properties ||= []).push(property);
      propertyKeys.add(key);
    }
  }
}
sbom.components = [...componentsByRef.values()];

const dependenciesByRef = new Map();
for (const dependency of sbom.dependencies) {
  if (!dependency.ref || !Array.isArray(dependency.dependsOn)) {
    throw new Error("SBOM dependency entry is missing ref or dependsOn");
  }
  const merged = dependenciesByRef.get(dependency.ref) || { ref: dependency.ref, dependsOn: [] };
  merged.dependsOn = [...new Set([...merged.dependsOn, ...dependency.dependsOn])];
  dependenciesByRef.set(dependency.ref, merged);
}
sbom.dependencies = [...dependenciesByRef.values()];

const treeComponents = new Set();
function visitDependencies(node) {
  for (const [name, dependency] of Object.entries(node.dependencies || {})) {
    // npm ls includes an empty placeholder for an unavailable optional peer.
    if (!dependency.version) continue;
    treeComponents.add(`${name}\0${dependency.version}`);
    visitDependencies(dependency);
  }
}
visitDependencies(tree);

const sbomComponents = new Set();
const componentRefs = new Set();
for (const component of sbom.components) {
  const identity = `${component.name}\0${component.version}`;
  if (sbomComponents.has(identity)) {
    throw new Error(`duplicate SBOM name/version identity: ${component.name}@${component.version}`);
  }
  sbomComponents.add(identity);
  if (componentRefs.has(component["bom-ref"])) {
    throw new Error(`duplicate SBOM bom-ref: ${component["bom-ref"]}`);
  }
  componentRefs.add(component["bom-ref"]);
  const expectedPurl = `pkg:npm/${encodeURIComponent(component.name).replaceAll("%2F", "/")}@${encodeURIComponent(component.version)}`;
  if (component.purl !== expectedPurl) {
    throw new Error(`SBOM purl mismatch for ${component.name}@${component.version}`);
  }
}

const missing = [...treeComponents].filter((identity) => !sbomComponents.has(identity));
const extra = [...sbomComponents].filter((identity) => !treeComponents.has(identity));
if (missing.length || extra.length) {
  const display = (identity) => identity.replace("\0", "@");
  throw new Error(
    `SBOM production closure mismatch; missing=[${missing.map(display).join(", ")}], extra=[${extra.map(display).join(", ")}]`,
  );
}

for (const name of ["@modelcontextprotocol/sdk", "ajv", "fast-uri", "hono", "ip-address"]) {
  const installed = [...treeComponents].find((identity) => identity.startsWith(`${name}\0`));
  if (!installed || !sbomComponents.has(installed)) {
    throw new Error(`required production component missing from installed tree or SBOM: ${name}`);
  }
}
for (const name of ["eslint", "typescript", "vitest"]) {
  if ([...sbomComponents].some((identity) => identity.startsWith(`${name}\0`))) {
    throw new Error(`development-only component present in production SBOM: ${name}`);
  }
}

const root = sbom.metadata?.component;
if (!root?.["bom-ref"] || !tree.name || !tree.version) {
  throw new Error("SBOM or installed tree is missing root package identity");
}
const rootRef = `${tree.name}@${tree.version}`;
const rootPurl = `pkg:npm/${encodeURIComponent(tree.name).replaceAll("%2F", "/")}@${encodeURIComponent(tree.version)}`;
if (root["bom-ref"] !== rootRef || root.version !== tree.version || root.purl !== rootPurl) {
  throw new Error("SBOM root identity does not match the installed production tree");
}
// npm names the root after the extraction directory (package/) even though its
// bom-ref and purl use the manifest name. Normalize that known inconsistency.
root.name = tree.name;
const graphRefs = new Set(sbom.dependencies.map((dependency) => dependency.ref));
if (!dependenciesByRef.has(rootRef)) {
  throw new Error(`SBOM dependency graph is missing root entry: ${rootRef}`);
}
for (const ref of componentRefs) {
  if (!graphRefs.has(ref)) throw new Error(`SBOM component is absent from dependency graph: ${ref}`);
}
for (const ref of graphRefs) {
  if (ref !== rootRef && !componentRefs.has(ref)) {
    throw new Error(`unknown SBOM dependency graph ref: ${ref}`);
  }
}
for (const dependency of sbom.dependencies) {
  for (const ref of dependency.dependsOn) {
    if (!componentRefs.has(ref)) throw new Error(`dangling SBOM dependency ref: ${ref}`);
  }
}

const reachableRefs = new Set([rootRef]);
const pendingRefs = [rootRef];
while (pendingRefs.length) {
  const ref = pendingRefs.pop();
  const dependency = dependenciesByRef.get(ref);
  if (!dependency) throw new Error(`reachable SBOM ref has no dependency entry: ${ref}`);
  for (const childRef of dependency.dependsOn) {
    if (!reachableRefs.has(childRef)) {
      reachableRefs.add(childRef);
      pendingRefs.push(childRef);
    }
  }
}
const unreachableRefs = [...componentRefs].filter((ref) => !reachableRefs.has(ref));
if (unreachableRefs.length) {
  throw new Error(`SBOM contains components unreachable from root: ${unreachableRefs.join(", ")}`);
}

fs.writeFileSync(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
console.error(`verified production SBOM closure: ${treeComponents.size} components`);
